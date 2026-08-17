-- Launch-readiness: durable onboarding, last-room resume, safe connections,
-- and indexes for high-volume chronological chat reads.

create index if not exists posts_room_top_level_created_id_idx
  on public.posts (scope_type, scope_key, created_at desc, id desc)
  where reply_to_id is null and deleted_at is null;
create index if not exists posts_thread_created_id_idx
  on public.posts (reply_to_id, created_at, id)
  where reply_to_id is not null and deleted_at is null;
create index if not exists posts_created_brin_idx on public.posts using brin (created_at);
create index if not exists messages_created_brin_idx on public.messages using brin (created_at);

-- Members may only create one-to-one rooms through the accepted-connection RPC.
-- Group rooms are provisioned by trusted backend/admin logic, never by clients.
revoke all on function public.create_chat_group(text, uuid[]) from public;
revoke execute on function public.create_chat_group(text, uuid[]) from authenticated;
grant execute on function public.create_chat_group(text, uuid[]) to service_role;

create or replace function public.get_last_forum_room()
returns table (scope_type text, scope_key text)
language sql
stable
security definer
set search_path = public
as $$
  select state.scope_type, state.scope_key
  from public.forum_room_state state
  where state.user_id = (select auth.uid())
    and public.forum_can_access_scope(state.scope_type, state.scope_key)
  order by state.last_opened_at desc
  limit 1;
$$;
revoke all on function public.get_last_forum_room() from public;
grant execute on function public.get_last_forum_room() to authenticated;

create or replace function public.complete_member_onboarding(
  p_name text,
  p_iit_name text,
  p_degree text,
  p_specialisation text,
  p_passing_year text,
  p_location text default null,
  p_linkedin text default null,
  p_company text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_education_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'A valid name is required'; end if;
  if length(trim(coalesce(p_degree, ''))) < 2 or length(trim(coalesce(p_specialisation, ''))) < 2 then
    raise exception 'Course and specialisation are required';
  end if;
  if trim(coalesce(p_passing_year, '')) !~ '^[0-9]{4}$' then raise exception 'A valid passing year is required'; end if;
  if not exists (
    select 1 from public.profiles
    where user_id = v_user_id and is_verified = true and trim(iit_name) = trim(p_iit_name)
  ) then raise exception 'Verified institute identity required'; end if;

  select id into v_education_id
  from public.education
  where user_id = v_user_id and trim(institution) = trim(p_iit_name)
  order by created_at desc limit 1
  for update;

  if v_education_id is null then
    insert into public.education (user_id, institution, degree, branch_area, passing_year)
    values (v_user_id, trim(p_iit_name), trim(p_degree), trim(p_specialisation), trim(p_passing_year))
    returning id into v_education_id;
  else
    update public.education set
      degree = trim(p_degree), branch_area = trim(p_specialisation), passing_year = trim(p_passing_year)
    where id = v_education_id;
  end if;

  update public.profiles set
    name = trim(p_name),
    location = nullif(trim(coalesce(p_location, '')), ''),
    social_links = case when nullif(trim(coalesce(p_linkedin, '')), '') is null
      then social_links else coalesce(social_links, '{}'::jsonb) || jsonb_build_object('linkedin', trim(p_linkedin)) end,
    primary_education_id = v_education_id,
    onboarding_completed = true
  where user_id = v_user_id;

  if nullif(trim(coalesce(p_company, '')), '') is not null
    and not exists (select 1 from public.professional_experience where user_id = v_user_id and is_current = true and lower(company_name) = lower(trim(p_company)))
  then
    insert into public.professional_experience (user_id, company_name, is_current)
    values (v_user_id, trim(p_company), true);
  end if;

  return v_education_id;
end;
$$;
revoke all on function public.complete_member_onboarding(text,text,text,text,text,text,text,text) from public;
grant execute on function public.complete_member_onboarding(text,text,text,text,text,text,text,text) to authenticated;

alter table public.connections add column if not exists note text;
alter table public.connections add column if not exists responded_at timestamptz;
alter table public.connections add column if not exists withdrawn_at timestamptz;
alter table public.connections drop constraint if exists connections_note_length;
alter table public.connections add constraint connections_note_length check (char_length(coalesce(note, '')) <= 200);

-- Prevent direct PostgREST mutations from bypassing invitation limits/cooldowns.
revoke insert, update, delete on table public.connections from anon, authenticated;
grant select on table public.connections to authenticated;
grant all on table public.connections to service_role;

create or replace function public.send_connection_request(p_receiver_id uuid, p_note text default null)
returns public.connections
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_existing public.connections;
  v_result public.connections;
begin
  if v_me is null or p_receiver_id is null or p_receiver_id = v_me then raise exception 'Invalid connection request'; end if;
  if char_length(coalesce(p_note, '')) > 200 then raise exception 'Connection note must be 200 characters or less'; end if;
  if not exists (select 1 from public.profiles where user_id = v_me and is_verified = true)
    or not exists (select 1 from public.profiles where user_id = p_receiver_id and is_verified = true)
  then raise exception 'Both members must be verified'; end if;
  if (select count(*) from public.connections where requester_id = v_me and created_at > now() - interval '7 days') >= 50
  then raise exception 'Weekly invitation limit reached. Try again later.'; end if;
  if (select count(*) from public.connections where requester_id = v_me and status = 'pending') >= 100
  then raise exception 'Resolve outstanding invitations before sending more.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(least(v_me::text, p_receiver_id::text) || greatest(v_me::text, p_receiver_id::text), 0));
  select * into v_existing from public.connections
  where (requester_id = v_me and receiver_id = p_receiver_id)
     or (requester_id = p_receiver_id and receiver_id = v_me)
  order by created_at desc limit 1 for update;

  if found and v_existing.status = 'accepted' then raise exception 'You are already connected'; end if;
  if found and v_existing.status = 'pending' then raise exception 'A connection request is already pending'; end if;
  if found and v_existing.created_at > now() - interval '21 days' then
    raise exception 'Wait 21 days before inviting this member again';
  end if;
  if found then delete from public.connections where id = v_existing.id; end if;

  insert into public.connections (requester_id, receiver_id, community_id, status, note)
  values (v_me, p_receiver_id, 'default', 'pending', nullif(trim(coalesce(p_note, '')), ''))
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.respond_connection_request(p_request_id uuid, p_accept boolean)
returns public.connections
language plpgsql
security definer
set search_path = public
as $$
declare v_result public.connections;
begin
  update public.connections set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now()
  where id = p_request_id and receiver_id = auth.uid() and status = 'pending'
  returning * into v_result;
  if v_result.id is null then raise exception 'Pending invitation not found'; end if;
  return v_result;
end;
$$;

create or replace function public.withdraw_connection_request(p_request_id uuid)
returns public.connections
language plpgsql
security definer
set search_path = public
as $$
declare v_result public.connections;
begin
  update public.connections set status = 'withdrawn', withdrawn_at = now()
  where id = p_request_id and requester_id = auth.uid() and status = 'pending'
  returning * into v_result;
  if v_result.id is null then raise exception 'Pending invitation not found'; end if;
  return v_result;
end;
$$;

revoke all on function public.send_connection_request(uuid,text) from public;
revoke all on function public.respond_connection_request(uuid,boolean) from public;
revoke all on function public.withdraw_connection_request(uuid) from public;
grant execute on function public.send_connection_request(uuid,text) to authenticated;
grant execute on function public.respond_connection_request(uuid,boolean) to authenticated;
grant execute on function public.withdraw_connection_request(uuid) to authenticated;
