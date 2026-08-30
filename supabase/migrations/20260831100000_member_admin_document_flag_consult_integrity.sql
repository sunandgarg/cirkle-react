-- Production controls for member administration, document verification and Consult.

insert into public.app_settings (key, value)
values ('document_verification_enabled', 'false')
on conflict (key) do nothing;

drop policy if exists users_create_own_document_verification on public.document_verifications;
create policy users_create_own_document_verification
  on public.document_verifications for insert to authenticated
  with check (
    user_id = auth.uid()
    and coalesce((select value from public.app_settings where key = 'document_verification_enabled'), 'false') = 'true'
  );

alter table public.consultations add column if not exists chat_room_id uuid references public.chat_rooms(id) on delete set null;

do $$ begin
  alter table public.consultations add constraint consultations_type_check
    check (consultation_type in ('chat', 'audio', 'video'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.consultations add constraint consultations_status_check
    check (status in ('pending', 'confirmed', 'completed', 'cancelled'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.consultations add constraint consultations_duration_check
    check (duration_minutes in (15, 30, 45, 60));
exception when duplicate_object then null;
end $$;

create index if not exists consultations_consultant_schedule_idx
  on public.consultations (consultant_id, scheduled_at)
  where status in ('pending', 'confirmed');
create index if not exists consultations_client_schedule_idx
  on public.consultations (client_id, scheduled_at)
  where status in ('pending', 'confirmed');

drop policy if exists consultations_insert_client on public.consultations;
drop policy if exists consultations_update_participants on public.consultations;

create or replace function public.request_consultation(
  p_consultant_id uuid,
  p_consultation_type text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_notes text default null
)
returns public.consultations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid := auth.uid();
  v_client public.profiles;
  v_mentor public.profiles;
  v_amount numeric;
  v_result public.consultations;
  v_end timestamptz;
begin
  if v_client_id is null then raise exception 'Authentication required'; end if;
  if p_consultant_id is null or p_consultant_id = v_client_id then raise exception 'Choose another member as your mentor'; end if;
  if p_consultation_type not in ('chat', 'audio', 'video') then raise exception 'Unsupported consultation type'; end if;
  if p_duration_minutes not in (15, 30, 45, 60) then raise exception 'Choose a supported duration'; end if;
  if p_scheduled_at is null or p_scheduled_at < now() + interval '30 minutes' then raise exception 'Choose a time at least 30 minutes from now'; end if;
  if p_scheduled_at > now() + interval '90 days' then raise exception 'Bookings can be made up to 90 days ahead'; end if;
  if length(coalesce(p_notes, '')) > 1000 then raise exception 'Notes must be 1000 characters or fewer'; end if;

  select * into v_client from public.profiles where user_id = v_client_id;
  if v_client.user_id is null or not v_client.is_verified or not v_client.onboarding_completed then
    raise exception 'Complete verification before booking a mentor';
  end if;

  select * into v_mentor from public.profiles where user_id = p_consultant_id;
  if v_mentor.user_id is null or not v_mentor.is_mentor or not v_mentor.is_verified then
    raise exception 'This mentor is not available for booking';
  end if;

  v_amount := case p_consultation_type
    when 'chat' then v_mentor.mentor_price_chat
    when 'audio' then v_mentor.mentor_price_audio
    when 'video' then v_mentor.mentor_price_video
  end;
  if v_amount is null or v_amount < 0 then raise exception 'This service is not offered by the mentor'; end if;

  -- Serialize a mentor's booking requests so concurrent clients cannot double-book.
  perform pg_advisory_xact_lock(hashtextextended(p_consultant_id::text, 7102026));
  v_end := p_scheduled_at + make_interval(mins => p_duration_minutes);
  if exists (
    select 1 from public.consultations c
    where c.status in ('pending', 'confirmed')
      and (c.consultant_id = p_consultant_id or c.client_id = v_client_id)
      and tstzrange(c.scheduled_at, c.scheduled_at + make_interval(mins => c.duration_minutes), '[)')
          && tstzrange(p_scheduled_at, v_end, '[)')
  ) then
    raise exception 'That time overlaps an existing booking. Choose another slot';
  end if;

  insert into public.consultations (
    client_id, consultant_id, consultation_type, status, amount,
    duration_minutes, scheduled_at, notes
  ) values (
    v_client_id, p_consultant_id, p_consultation_type, 'pending', v_amount,
    p_duration_minutes, p_scheduled_at, nullif(trim(p_notes), '')
  ) returning * into v_result;

  insert into public.notifications (user_id, type, title, message, entity_id)
  values (
    p_consultant_id, 'consultation_booking', 'New consultation request',
    coalesce(v_client.name, 'A member') || ' requested a ' || p_consultation_type || ' session.',
    v_result.id
  );
  return v_result;
end;
$$;

create or replace function public.change_consultation_status(
  p_consultation_id uuid,
  p_status text
)
returns public.consultations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_booking public.consultations;
  v_result public.consultations;
  v_recipient uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_status not in ('confirmed', 'completed', 'cancelled') then raise exception 'Unsupported status'; end if;

  select * into v_booking from public.consultations where id = p_consultation_id for update;
  if v_booking.id is null then raise exception 'Booking not found'; end if;
  if v_actor not in (v_booking.client_id, v_booking.consultant_id) then raise exception 'Not allowed'; end if;

  if v_booking.status = 'pending' then
    if p_status = 'confirmed' and v_actor <> v_booking.consultant_id then raise exception 'Only the mentor can accept this request'; end if;
    if p_status not in ('confirmed', 'cancelled') then raise exception 'Invalid status change'; end if;
  elsif v_booking.status = 'confirmed' then
    if p_status = 'completed' then
      if v_actor <> v_booking.consultant_id then raise exception 'Only the mentor can complete this session'; end if;
      if now() < v_booking.scheduled_at then raise exception 'The session cannot be completed before it starts'; end if;
    elsif p_status <> 'cancelled' then
      raise exception 'Invalid status change';
    end if;
  else
    raise exception 'This booking is already closed';
  end if;

  update public.consultations
  set status = p_status, updated_at = now()
  where id = p_consultation_id
  returning * into v_result;

  v_recipient := case when v_actor = v_booking.client_id then v_booking.consultant_id else v_booking.client_id end;
  insert into public.notifications (user_id, type, title, message, entity_id)
  values (
    v_recipient,
    'consultation_status',
    case p_status when 'confirmed' then 'Consultation accepted' when 'completed' then 'Consultation completed' else 'Consultation cancelled' end,
    'Your consultation request is now ' || p_status || '.',
    v_result.id
  );
  return v_result;
end;
$$;

revoke all on function public.request_consultation(uuid, text, timestamptz, integer, text) from public;
grant execute on function public.request_consultation(uuid, text, timestamptz, integer, text) to authenticated;
revoke all on function public.change_consultation_status(uuid, text) from public;
grant execute on function public.change_consultation_status(uuid, text) to authenticated;

