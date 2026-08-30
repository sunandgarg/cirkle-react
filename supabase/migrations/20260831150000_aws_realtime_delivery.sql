-- Durable AWS AppSync delivery bridge. Postgres remains authoritative while
-- realtime events are retried independently until AWS acknowledges them.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.realtime_channel_registry (
  channel text primary key,
  scope_type text not null,
  scope_key text not null,
  created_at timestamptz not null default now(),
  unique (scope_type, scope_key)
);

create table if not exists public.realtime_delivery_outbox (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  source text not null check (source in ('forum', 'chat')),
  aggregate_id uuid not null,
  channel text not null,
  event_type text not null check (event_type in ('INSERT', 'UPDATE', 'DELETE')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'delivered', 'failed')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by uuid,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists realtime_outbox_claim_idx
  on public.realtime_delivery_outbox (available_at, id)
  where status in ('pending', 'failed', 'processing');
create index if not exists realtime_outbox_aggregate_idx
  on public.realtime_delivery_outbox (source, aggregate_id, created_at desc);

alter table public.realtime_channel_registry enable row level security;
alter table public.realtime_delivery_outbox enable row level security;
revoke all on table public.realtime_channel_registry, public.realtime_delivery_outbox from anon, authenticated;
grant all on table public.realtime_channel_registry, public.realtime_delivery_outbox to service_role;
grant usage, select on sequence public.realtime_delivery_outbox_id_seq to service_role;

create or replace function public.appsync_scope_channel(p_namespace text, p_scope_type text, p_scope_key text)
returns text language sql immutable set search_path = public, extensions as $$
  select '/' || lower(regexp_replace(p_namespace, '[^a-zA-Z0-9-]+', '-', 'g'))
    || '/' || lower(regexp_replace(p_scope_type, '[^a-zA-Z0-9-]+', '-', 'g'))
    || '/' || substring(encode(digest(coalesce(p_scope_key, ''), 'sha256'), 'hex') from 1 for 32);
$$;

create or replace function public.get_appsync_forum_channels(p_scope_type text, p_scope_key text)
returns table(message_channel text, typing_channel text, presence_channel text)
language plpgsql security definer set search_path = public as $$
declare v_channel text;
begin
  if auth.uid() is null or not public.forum_can_access_scope(p_scope_type, p_scope_key) then
    raise exception 'Forum membership required';
  end if;
  v_channel := public.appsync_scope_channel('forum', p_scope_type, p_scope_key);
  insert into public.realtime_channel_registry(channel, scope_type, scope_key)
  values (v_channel, p_scope_type, p_scope_key)
  on conflict (scope_type, scope_key) do update set channel = excluded.channel;
  return query select v_channel,
    public.appsync_scope_channel('typing', p_scope_type, p_scope_key),
    public.appsync_scope_channel('presence', p_scope_type, p_scope_key);
end;
$$;
revoke all on function public.get_appsync_forum_channels(text,text) from public;
grant execute on function public.get_appsync_forum_channels(text,text) to authenticated;

create or replace function public.appsync_can_access_channel(p_channel text, p_operation text default 'subscribe')
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_room uuid; v_registry public.realtime_channel_registry;
begin
  if auth.uid() is null or p_channel is null then return false; end if;
  if p_channel ~ '^/(forum|typing|presence)/[a-z0-9-]+/[a-f0-9]{32}$' then
    select * into v_registry from public.realtime_channel_registry
    where channel = regexp_replace(p_channel, '^/(typing|presence)/', '/forum/');
    if v_registry.channel is null then return false; end if;
    if p_operation = 'publish' and p_channel not like '/typing/%' and p_channel not like '/presence/%' then return false; end if;
    return public.forum_can_access_scope(v_registry.scope_type, v_registry.scope_key);
  end if;
  if p_channel ~ '^/thread/[0-9a-f-]{36}$' then
    if p_operation = 'publish' then return false; end if;
    v_room := split_part(p_channel, '/', 3)::uuid;
    return exists (select 1 from public.posts p where p.id = v_room and public.forum_can_access_scope(p.scope_type, p.scope_key));
  end if;
  if p_channel ~ '^/(chat|chat-typing|chat-presence)/[0-9a-f-]{36}$' then
    v_room := split_part(p_channel, '/', 3)::uuid;
    if p_operation = 'publish' and p_channel like '/chat/%' then return false; end if;
    return public.is_chat_member(v_room, auth.uid());
  end if;
  return false;
exception when others then return false;
end;
$$;
revoke all on function public.appsync_can_access_channel(text,text) from public;
grant execute on function public.appsync_can_access_channel(text,text) to authenticated;

create or replace function public.enqueue_forum_appsync_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_row public.posts; v_record jsonb; v_channel text;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  if v_row.scope_type is null or v_row.scope_key is null then return null; end if;
  if tg_op = 'DELETE' then
    v_record := jsonb_build_object('id', old.id, 'scope_type', old.scope_type, 'scope_key', old.scope_key,
      'reply_to_id', old.reply_to_id, 'created_at', old.created_at);
  else
    v_record := to_jsonb(new);
    if new.is_anonymous then v_record := v_record - 'author_id'; end if;
  end if;
  v_channel := case when v_row.reply_to_id is null
    then public.appsync_scope_channel('forum', v_row.scope_type, v_row.scope_key)
    else '/thread/' || v_row.reply_to_id::text end;
  insert into public.realtime_channel_registry(channel, scope_type, scope_key)
  values (public.appsync_scope_channel('forum', v_row.scope_type, v_row.scope_key), v_row.scope_type, v_row.scope_key)
  on conflict (scope_type, scope_key) do nothing;
  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  values ('forum', v_row.id, v_channel, tg_op,
    jsonb_build_object('source', 'forum', 'eventType', tg_op,
      case when tg_op = 'DELETE' then 'old' else 'new' end, v_record));
  return null;
end;
$$;
drop trigger if exists enqueue_forum_appsync_event on public.posts;
create trigger enqueue_forum_appsync_event after insert or update or delete on public.posts
for each row execute function public.enqueue_forum_appsync_event();

create or replace function public.enqueue_chat_appsync_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_row public.messages; v_record jsonb;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  v_record := case when tg_op = 'DELETE'
    then jsonb_build_object('id', old.id, 'room_id', old.room_id, 'created_at', old.created_at)
    else to_jsonb(new) end;
  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  values ('chat', v_row.id, '/chat/' || v_row.room_id::text, tg_op,
    jsonb_build_object('source', 'chat', 'eventType', tg_op,
      case when tg_op = 'DELETE' then 'old' else 'new' end, v_record));
  return null;
end;
$$;
drop trigger if exists enqueue_chat_appsync_event on public.messages;
create trigger enqueue_chat_appsync_event after insert or update or delete on public.messages
for each row execute function public.enqueue_chat_appsync_event();

create or replace function public.claim_realtime_delivery_batch(p_limit integer default 100, p_worker uuid default gen_random_uuid())
returns table(id bigint, event_id uuid, channel text, payload jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  return query
  with candidates as (
    select o.id from public.realtime_delivery_outbox o
    where o.available_at <= now()
      and (o.status in ('pending','failed') or (o.status = 'processing' and o.locked_at < now() - interval '2 minutes'))
    order by o.id for update skip locked limit least(greatest(p_limit, 1), 500)
  ), claimed as (
    update public.realtime_delivery_outbox o set status = 'processing', locked_at = now(), locked_by = p_worker,
      attempts = o.attempts + 1
    from candidates c where o.id = c.id
    returning o.id, o.event_id, o.channel, o.payload
  ) select * from claimed;
end;
$$;

create or replace function public.complete_realtime_delivery(p_ids bigint[], p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_error is null then
    update public.realtime_delivery_outbox set status = 'delivered', delivered_at = now(), locked_at = null,
      locked_by = null, last_error = null where id = any(p_ids);
  else
    update public.realtime_delivery_outbox set status = 'failed', locked_at = null, locked_by = null,
      last_error = left(p_error, 1000), available_at = now() + least(interval '5 minutes', interval '2 seconds' * power(2, least(attempts, 7)))
    where id = any(p_ids);
  end if;
end;
$$;
revoke all on function public.claim_realtime_delivery_batch(integer,uuid) from public;
revoke all on function public.complete_realtime_delivery(bigint[],text) from public;
grant execute on function public.claim_realtime_delivery_batch(integer,uuid) to service_role;
grant execute on function public.complete_realtime_delivery(bigint[],text) to service_role;

-- Server-only view of login identity plus the separately verified IIT address.
create or replace function public.get_admin_users_detailed(p_limit integer default 500)
returns table(
  user_id uuid, name text, login_email text, phone_full text, iit_email text,
  iit_name text, student_status text, is_verified boolean, onboarding_completed boolean,
  role public.app_role, location text, headline text, avatar_url text,
  degree text, specialisation text, passing_year text, created_at timestamptz, last_sign_in_at timestamptz
) language sql stable security definer set search_path = public, auth as $$
  select p.user_id, p.name, u.email::text, p.phone_full, p.iit_email, p.iit_name,
    p.student_status, p.is_verified, p.onboarding_completed, p.role, p.location, p.headline,
    p.avatar_url, e.degree, e.branch_area, e.passing_year, p.created_at, u.last_sign_in_at
  from public.profiles p
  join auth.users u on u.id = p.user_id
  left join public.education e on e.id = p.primary_education_id
  where public.forum_is_admin()
  order by p.created_at desc
  limit least(greatest(p_limit, 1), 1000);
$$;
revoke all on function public.get_admin_users_detailed(integer) from public;
grant execute on function public.get_admin_users_detailed(integer) to authenticated;

-- Delivered audit rows are retained for operational diagnosis. A scheduled AWS
-- retry invokes the dispatcher; a later maintenance job can prune rows older
-- than seven days without making this migration depend on pg_cron.
