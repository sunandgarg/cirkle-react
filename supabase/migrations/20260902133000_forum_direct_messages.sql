-- Direct-message inbox for the Forum sidebar. Accepted connections are the
-- authority; chat history remains in Postgres and AWS only carries live events.

create or replace function public.get_direct_message_sidebar()
returns table (
  connection_id uuid,
  peer_id uuid,
  room_id uuid,
  display_name text,
  display_avatar text,
  last_message jsonb,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with accepted as (
    select
      c.id as connection_id,
      case when c.requester_id = auth.uid() then c.receiver_id else c.requester_id end as peer_id,
      coalesce(c.responded_at, c.created_at) as connected_at
    from public.connections c
    where c.status = 'accepted'
      and auth.uid() in (c.requester_id, c.receiver_id)
  )
  select
    accepted.connection_id,
    accepted.peer_id,
    room.id as room_id,
    coalesce(profile.name, 'Cirkle member') as display_name,
    profile.avatar_url as display_avatar,
    case when latest.id is null then null else jsonb_build_object(
      'id', latest.id,
      'content', latest.content,
      'created_at', latest.created_at,
      'sender_id', latest.sender_id,
      'message_type', latest.message_type
    ) end as last_message,
    case when room.id is null then 0 else (
      select count(*)
      from public.messages unread
      where unread.room_id = room.id
        and unread.sender_id <> auth.uid()
        and unread.created_at > coalesce(member.last_read_at, '-infinity'::timestamptz)
    ) end as unread_count
  from accepted
  join public.profiles profile on profile.user_id = accepted.peer_id
  left join public.chat_rooms room
    on room.direct_key = least(auth.uid()::text, accepted.peer_id::text) || ':' || greatest(auth.uid()::text, accepted.peer_id::text)
  left join public.chat_members member on member.room_id = room.id and member.user_id = auth.uid()
  left join lateral (
    select message.id, message.content, message.created_at, message.sender_id, message.message_type
    from public.messages message
    where message.room_id = room.id
    order by message.created_at desc, message.id desc
    limit 1
  ) latest on true
  order by coalesce(latest.created_at, accepted.connected_at) desc, accepted.connection_id;
$$;

revoke all on function public.get_direct_message_sidebar() from public;
grant execute on function public.get_direct_message_sidebar() to authenticated;

-- Each authenticated member keeps one lightweight inbox subscription. This
-- updates the Forum sidebar without subscribing to every private room.
create or replace function public.appsync_can_access_channel(p_channel text, p_operation text default 'subscribe')
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_room uuid; v_registry public.realtime_channel_registry; v_inbox_user uuid;
begin
  if auth.uid() is null or p_channel is null then return false; end if;
  if p_channel ~ '^/inbox/[0-9a-f-]{36}$' then
    if p_operation = 'publish' then return false; end if;
    v_inbox_user := split_part(p_channel, '/', 3)::uuid;
    return v_inbox_user = auth.uid();
  end if;
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

create or replace function public.enqueue_chat_appsync_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_row public.messages; v_record jsonb; v_payload jsonb;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  v_record := case when tg_op = 'DELETE'
    then jsonb_build_object('id', old.id, 'room_id', old.room_id, 'created_at', old.created_at)
    else to_jsonb(new) end;
  v_payload := jsonb_build_object('source', 'chat', 'eventType', tg_op,
    case when tg_op = 'DELETE' then 'old' else 'new' end, v_record);

  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  values ('chat', v_row.id, '/chat/' || v_row.room_id::text, tg_op, v_payload);

  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  select 'chat', v_row.id, '/inbox/' || member.user_id::text, tg_op, v_payload
  from public.chat_members member
  where member.room_id = v_row.room_id;
  return null;
end;
$$;

drop trigger if exists enqueue_chat_appsync_event on public.messages;
create trigger enqueue_chat_appsync_event after insert or update or delete on public.messages
for each row execute function public.enqueue_chat_appsync_event();
