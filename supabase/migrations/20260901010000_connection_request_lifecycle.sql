-- Complete, server-enforced connection request lifecycle.

alter table public.connections drop constraint if exists connections_status_check;
alter table public.connections
  add constraint connections_status_check
  check (status in ('pending', 'accepted', 'declined', 'withdrawn', 'rejected'));

create index if not exists connections_pending_receiver_created_idx
  on public.connections (receiver_id, created_at desc)
  where status = 'pending';

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
  v_sender_name text;
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

  select coalesce(nullif(trim(name), ''), 'A Cirkle member') into v_sender_name
  from public.profiles where user_id = v_me;
  insert into public.notifications (user_id, type, title, message, entity_id)
  values (
    p_receiver_id,
    'connection_request',
    'New connection request',
    v_sender_name || ' would like to connect with you.',
    v_result.id
  );

  return v_result;
end;
$$;

create or replace function public.respond_connection_request(p_request_id uuid, p_accept boolean)
returns public.connections
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.connections;
  v_receiver_name text;
begin
  update public.connections
  set status = case when p_accept then 'accepted' else 'declined' end,
      responded_at = now()
  where id = p_request_id and receiver_id = auth.uid() and status = 'pending'
  returning * into v_result;
  if v_result.id is null then raise exception 'Pending request not found'; end if;

  select coalesce(nullif(trim(name), ''), 'A Cirkle member') into v_receiver_name
  from public.profiles where user_id = auth.uid();
  insert into public.notifications (user_id, type, title, message, entity_id)
  values (
    v_result.requester_id,
    'connection_response',
    case when p_accept then 'Connection request accepted' else 'Connection request declined' end,
    v_receiver_name || case when p_accept then ' accepted your connection request.' else ' declined your connection request.' end,
    v_result.id
  );

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
  if v_result.id is null then raise exception 'Pending request not found'; end if;

  delete from public.notifications
  where user_id = v_result.receiver_id
    and type = 'connection_request'
    and entity_id = v_result.id
    and is_read = false;
  return v_result;
end;
$$;

revoke all on function public.send_connection_request(uuid,text) from public;
revoke all on function public.respond_connection_request(uuid,boolean) from public;
revoke all on function public.withdraw_connection_request(uuid) from public;
grant execute on function public.send_connection_request(uuid,text) to authenticated;
grant execute on function public.respond_connection_request(uuid,boolean) to authenticated;
grant execute on function public.withdraw_connection_request(uuid) to authenticated;

