-- Scalable, room-scoped forum delivery using Supabase Realtime Broadcast.
-- Postgres Changes remains a client fallback until this migration is applied.

create or replace function public.broadcast_forum_post_changes()
returns trigger
security definer
language plpgsql
set search_path = public, realtime
as $$
declare
  row_scope_type text := coalesce(new.scope_type, old.scope_type);
  row_scope_key text := coalesce(new.scope_key, old.scope_key);
begin
  -- Home-feed posts are intentionally outside the academic forum room model.
  if row_scope_type is null or row_scope_key is null then
    return null;
  end if;

  perform realtime.broadcast_changes(
    'forum:' || row_scope_type || ':' || row_scope_key,
    tg_op,
    tg_op,
    tg_table_name,
    tg_table_schema,
    new,
    old
  );
  return null;
end;
$$;

drop trigger if exists broadcast_forum_post_changes on public.posts;
create trigger broadcast_forum_post_changes
after insert or update or delete on public.posts
for each row execute function public.broadcast_forum_post_changes();

create or replace function public.forum_broadcast_ready()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select true $$;

revoke all on function public.forum_broadcast_ready() from public;
grant execute on function public.forum_broadcast_ready() to authenticated;

alter table realtime.messages enable row level security;

drop policy if exists forum_members_receive_room_broadcasts on realtime.messages;
create policy forum_members_receive_room_broadcasts
on realtime.messages
for select
to authenticated
using (
  realtime.topic() like 'forum:%'
  and public.forum_can_access_scope(
    split_part(realtime.topic(), ':', 2),
    split_part(realtime.topic(), ':', 3)
  )
);
