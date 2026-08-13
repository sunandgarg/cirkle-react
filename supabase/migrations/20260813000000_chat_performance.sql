-- Chat v2: bounded reads, idempotent writes, efficient unread counts, and secure membership checks.
-- Apply with `supabase db push` after linking the target project.

alter table public.chat_rooms
  add column if not exists direct_key text;

alter table public.chat_members
  add column if not exists last_read_at timestamptz not null default now();

alter table public.messages
  add column if not exists client_id uuid,
  add column if not exists message_type text not null default 'text',
  add column if not exists media_url text;

create unique index if not exists chat_rooms_direct_key_uidx
  on public.chat_rooms (direct_key) where direct_key is not null;
create unique index if not exists chat_members_room_user_uidx
  on public.chat_members (room_id, user_id);
create unique index if not exists messages_sender_client_uidx
  on public.messages (sender_id, client_id) where client_id is not null;
create index if not exists messages_room_created_id_idx
  on public.messages (room_id, created_at desc, id desc);
create index if not exists chat_members_user_room_idx
  on public.chat_members (user_id, room_id);
create index if not exists connections_requester_status_idx
  on public.connections (requester_id, status, receiver_id);
create index if not exists connections_receiver_status_idx
  on public.connections (receiver_id, status, requester_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 20971520, array['image/webp', 'image/jpeg', 'image/png', 'image/gif'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'users_upload_own_post_images') then
    create policy users_upload_own_post_images on storage.objects for insert to authenticated
      with check (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'users_manage_own_post_images') then
    create policy users_manage_own_post_images on storage.objects for update to authenticated
      using (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'users_delete_own_post_images') then
    create policy users_delete_own_post_images on storage.objects for delete to authenticated
      using (bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;

create or replace function public.is_chat_member(p_room_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_members
    where room_id = p_room_id and user_id = p_user_id
  );
$$;

revoke all on function public.is_chat_member(uuid, uuid) from public;
grant execute on function public.is_chat_member(uuid, uuid) to authenticated;

create or replace function public.get_chat_inbox()
returns table (
  id uuid,
  name text,
  is_group boolean,
  avatar_url text,
  created_at timestamptz,
  created_by uuid,
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
  select
    r.id,
    r.name,
    r.is_group,
    r.avatar_url,
    r.created_at,
    r.created_by,
    case when r.is_group then coalesce(r.name, 'Group') else coalesce(other_profile.name, 'User') end,
    case when r.is_group then r.avatar_url else other_profile.avatar_url end,
    case when last_msg.id is null then null else jsonb_build_object(
      'id', last_msg.id,
      'content', last_msg.content,
      'created_at', last_msg.created_at,
      'sender_id', last_msg.sender_id,
      'message_type', last_msg.message_type,
      'media_url', last_msg.media_url
    ) end,
    (select count(*)
       from public.messages unread
      where unread.room_id = r.id
        and unread.created_at > me.last_read_at
        and unread.sender_id <> auth.uid())
  from public.chat_members me
  join public.chat_rooms r on r.id = me.room_id
  left join lateral (
    select p.name, p.avatar_url
      from public.chat_members cm
      join public.profiles p on p.user_id = cm.user_id
     where cm.room_id = r.id and cm.user_id <> auth.uid()
     order by cm.joined_at
     limit 1
  ) other_profile on true
  left join lateral (
    select m.id, m.content, m.created_at, m.sender_id, m.message_type, m.media_url
      from public.messages m
     where m.room_id = r.id
     order by m.created_at desc, m.id desc
     limit 1
  ) last_msg on true
  where me.user_id = auth.uid()
  order by coalesce(last_msg.created_at, r.created_at) desc;
$$;

revoke all on function public.get_chat_inbox() from public;
grant execute on function public.get_chat_inbox() to authenticated;

create or replace function public.get_or_create_direct_chat(p_peer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_key text;
  v_room_id uuid;
begin
  if v_me is null or p_peer_id is null or p_peer_id = v_me then
    raise exception 'Invalid chat peer';
  end if;

  if not exists (
    select 1 from public.connections
     where status = 'accepted'
       and ((requester_id = v_me and receiver_id = p_peer_id)
         or (requester_id = p_peer_id and receiver_id = v_me))
  ) then
    raise exception 'You can only message accepted connections';
  end if;

  v_key := least(v_me::text, p_peer_id::text) || ':' || greatest(v_me::text, p_peer_id::text);

  insert into public.chat_rooms (is_group, created_by, direct_key)
  values (false, v_me, v_key)
  on conflict (direct_key) where direct_key is not null
  do update set direct_key = excluded.direct_key
  returning id into v_room_id;

  insert into public.chat_members (room_id, user_id)
  values (v_room_id, v_me), (v_room_id, p_peer_id)
  on conflict (room_id, user_id) do nothing;

  return v_room_id;
end;
$$;

revoke all on function public.get_or_create_direct_chat(uuid) from public;
grant execute on function public.get_or_create_direct_chat(uuid) to authenticated;

create or replace function public.create_chat_group(p_name text, p_member_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_room_id uuid;
  v_peer uuid;
begin
  if v_me is null or nullif(trim(p_name), '') is null then
    raise exception 'A group name is required';
  end if;
  if coalesce(array_length(p_member_ids, 1), 0) < 1 or array_length(p_member_ids, 1) > 256 then
    raise exception 'Groups must have between 2 and 257 members';
  end if;

  foreach v_peer in array p_member_ids loop
    if v_peer = v_me or not exists (
      select 1 from public.connections
       where status = 'accepted'
         and ((requester_id = v_me and receiver_id = v_peer)
           or (requester_id = v_peer and receiver_id = v_me))
    ) then
      raise exception 'Every group member must be an accepted connection';
    end if;
  end loop;

  insert into public.chat_rooms (name, is_group, created_by)
  values (trim(p_name), true, v_me)
  returning id into v_room_id;

  insert into public.chat_members (room_id, user_id)
  select v_room_id, member_id
  from (select distinct unnest(array_append(p_member_ids, v_me)) as member_id) members;

  return v_room_id;
end;
$$;

revoke all on function public.create_chat_group(text, uuid[]) from public;
grant execute on function public.create_chat_group(text, uuid[]) to authenticated;

create or replace function public.mark_chat_read(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.chat_members
     set last_read_at = now()
   where room_id = p_room_id and user_id = auth.uid();
end;
$$;

revoke all on function public.mark_chat_read(uuid) from public;
grant execute on function public.mark_chat_read(uuid) to authenticated;

alter table public.chat_rooms enable row level security;
alter table public.chat_members enable row level security;
alter table public.messages enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_rooms' and policyname = 'members_read_rooms') then
    create policy members_read_rooms on public.chat_rooms for select to authenticated
      using (public.is_chat_member(id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_members' and policyname = 'members_read_memberships') then
    create policy members_read_memberships on public.chat_members for select to authenticated
      using (public.is_chat_member(room_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chat_members' and policyname = 'users_update_own_membership') then
    create policy users_update_own_membership on public.chat_members for update to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'members_read_messages') then
    create policy members_read_messages on public.messages for select to authenticated
      using (public.is_chat_member(room_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'members_send_messages') then
    create policy members_send_messages on public.messages for insert to authenticated
      with check (sender_id = auth.uid() and public.is_chat_member(room_id));
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
