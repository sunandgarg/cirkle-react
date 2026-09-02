-- Keep unstarted connections out of the DM thread list and expose a bounded,
-- server-authorized connection search for starting a private conversation.

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
      case when c.requester_id = auth.uid() then c.receiver_id else c.requester_id end as peer_id
    from public.connections c
    where c.status = 'accepted'
      and auth.uid() in (c.requester_id, c.receiver_id)
  )
  select
    accepted.connection_id,
    accepted.peer_id,
    room.id as room_id,
    coalesce(nullif(trim(profile.name), ''), 'Cirkle member') as display_name,
    profile.avatar_url as display_avatar,
    case when latest.id is null then null else jsonb_build_object(
      'id', latest.id,
      'content', latest.content,
      'created_at', latest.created_at,
      'sender_id', latest.sender_id,
      'message_type', latest.message_type
    ) end as last_message,
    (
      select count(*)
      from public.messages unread
      where unread.room_id = room.id
        and unread.sender_id <> auth.uid()
        and unread.created_at > coalesce(member.last_read_at, '-infinity'::timestamptz)
    ) as unread_count
  from accepted
  join public.profiles profile on profile.user_id = accepted.peer_id
  join public.chat_rooms room
    on room.is_group = false
   and room.direct_key = least(auth.uid()::text, accepted.peer_id::text) || ':' || greatest(auth.uid()::text, accepted.peer_id::text)
  left join public.chat_members member on member.room_id = room.id and member.user_id = auth.uid()
  left join lateral (
    select message.id, message.content, message.created_at, message.sender_id, message.message_type
    from public.messages message
    where message.room_id = room.id
    order by message.created_at desc, message.id desc
    limit 1
  ) latest on true
  order by coalesce(latest.created_at, room.created_at) desc, accepted.connection_id;
$$;

create or replace function public.search_my_connections(p_query text default '', p_limit integer default 8)
returns table (
  peer_id uuid,
  room_id uuid,
  display_name text,
  display_avatar text,
  headline text
)
language sql
stable
security definer
set search_path = public
as $$
  with input as (
    select lower(trim(coalesce(p_query, ''))) as query,
           greatest(1, least(coalesce(p_limit, 8), 20)) as result_limit
  ), accepted as (
    select case when c.requester_id = auth.uid() then c.receiver_id else c.requester_id end as peer_id
    from public.connections c
    where c.status = 'accepted'
      and auth.uid() in (c.requester_id, c.receiver_id)
  )
  select
    accepted.peer_id,
    room.id as room_id,
    coalesce(nullif(trim(profile.name), ''), 'Cirkle member') as display_name,
    profile.avatar_url as display_avatar,
    profile.headline
  from accepted
  join public.profiles profile on profile.user_id = accepted.peer_id
  cross join input
  left join public.chat_rooms room
    on room.is_group = false
   and room.direct_key = least(auth.uid()::text, accepted.peer_id::text) || ':' || greatest(auth.uid()::text, accepted.peer_id::text)
  where input.query = ''
     or position(input.query in lower(coalesce(profile.name, '') || ' ' || coalesce(profile.headline, ''))) > 0
  order by
    case when lower(coalesce(profile.name, '')) like input.query || '%' then 0 else 1 end,
    lower(coalesce(profile.name, '')),
    accepted.peer_id
  limit (select result_limit from input);
$$;

revoke all on function public.get_direct_message_sidebar() from public;
revoke all on function public.search_my_connections(text,integer) from public;
grant execute on function public.get_direct_message_sidebar() to authenticated;
grant execute on function public.search_my_connections(text,integer) to authenticated;
