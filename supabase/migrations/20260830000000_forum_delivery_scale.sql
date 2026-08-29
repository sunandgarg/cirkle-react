-- Forum delivery, privacy and read-path hardening.
create extension if not exists pg_trgm;

alter table public.posts add column if not exists image_path text;
alter table public.posts add column if not exists file_path text;
alter table public.posts add column if not exists voice_path text;
alter table public.posts add column if not exists scope_identity text
  generated always as (coalesce(scope_type, '') || ':' || coalesce(scope_key, '')) stored;

create index if not exists posts_scope_identity_history_idx
  on public.posts (scope_identity, created_at desc, id desc)
  where reply_to_id is null and deleted_at is null;
create index if not exists posts_reply_history_idx
  on public.posts (reply_to_id, created_at desc, id desc)
  where reply_to_id is not null and deleted_at is null;
create index if not exists posts_content_trgm_idx
  on public.posts using gin (content gin_trgm_ops)
  where deleted_at is null;
create index if not exists reactions_entity_emoji_idx
  on public.reactions (entity_type, entity_id, emoji, user_id);

update public.posts set image_path = substring(image_url from '/object/public/post-images/([^?]+)')
where image_path is null and image_url like '%/object/public/post-images/%';
update public.posts set file_path = substring(file_url from '/object/public/forum-files/([^?]+)')
where file_path is null and file_url like '%/object/public/forum-files/%';
update public.posts set voice_path = substring(voice_url from '/object/public/voice-notes/([^?]+)')
where voice_path is null and voice_url like '%/object/public/voice-notes/%';

create table if not exists public.forum_deleted_for_user (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  unique (post_id, user_id)
);
alter table public.forum_deleted_for_user enable row level security;
drop policy if exists forum_deleted_own on public.forum_deleted_for_user;
create policy forum_deleted_own on public.forum_deleted_for_user for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create index if not exists forum_deleted_user_post_idx on public.forum_deleted_for_user(user_id, post_id);

update storage.buckets set public = false where id in ('post-images', 'forum-files', 'voice-notes');

drop policy if exists forum_media_member_read on storage.objects;
create policy forum_media_member_read on storage.objects for select to authenticated using (
  bucket_id in ('post-images', 'forum-files', 'voice-notes') and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.posts p
      where (p.image_path = name or p.file_path = name or p.voice_path = name)
        and (public.forum_is_admin() or public.forum_can_access_scope(p.scope_type, p.scope_key))
    )
  )
);

create or replace function public.forum_post_json(p public.posts)
returns jsonb language sql stable security invoker set search_path = public as $$
  select to_jsonb(p) || jsonb_build_object(
    'profile', case when p.is_anonymous then null else (
      select jsonb_build_object('user_id', pr.user_id, 'name', pr.name, 'avatar_url', pr.avatar_url, 'slug', pr.slug)
      from public.profiles pr where pr.user_id = p.author_id
    ) end,
    'poll', (select to_jsonb(po) from public.polls po where po.post_id = p.id limit 1),
    'replyCount', (select count(*) from public.posts r where r.reply_to_id = p.id and r.deleted_at is null),
    'reactions', coalesce((
      select jsonb_object_agg(x.emoji, x.total) from (
        select re.emoji, count(*) as total from public.reactions re
        where re.entity_type = 'forum_msg' and re.entity_id = p.id group by re.emoji
      ) x
    ), '{}'::jsonb),
    'myReactions', coalesce((
      select jsonb_agg(re.emoji) from public.reactions re
      where re.entity_type = 'forum_msg' and re.entity_id = p.id and re.user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

create or replace function public.get_forum_posts_page(
  p_scope_type text, p_scope_key text, p_limit integer default 50,
  p_before_created_at timestamptz default null, p_before_id uuid default null
) returns table(post jsonb) language sql stable security invoker set search_path = public as $$
  select public.forum_post_json(p)
  from public.posts p
  where p.scope_type = p_scope_type and p.scope_key = p_scope_key
    and p.reply_to_id is null and p.deleted_at is null
    and not exists (select 1 from public.forum_deleted_for_user d where d.post_id = p.id and d.user_id = auth.uid())
    and (p_before_created_at is null or (p.created_at, p.id) < (p_before_created_at, p_before_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.get_forum_thread_page(
  p_parent_id uuid, p_limit integer default 50,
  p_before_created_at timestamptz default null, p_before_id uuid default null
) returns table(post jsonb) language sql stable security invoker set search_path = public as $$
  select public.forum_post_json(p)
  from public.posts p
  where p.reply_to_id = p_parent_id and p.deleted_at is null
    and not exists (select 1 from public.forum_deleted_for_user d where d.post_id = p.id and d.user_id = auth.uid())
    and (p_before_created_at is null or (p.created_at, p.id) < (p_before_created_at, p_before_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(p_limit, 1), 100);
$$;

create or replace function public.search_forum_posts(
  p_scope_type text, p_scope_key text, p_query text default '', p_kind text default 'messages',
  p_limit integer default 50, p_before_created_at timestamptz default null, p_before_id uuid default null
) returns table(post jsonb) language sql stable security invoker set search_path = public as $$
  select public.forum_post_json(p)
  from public.posts p
  where p.scope_type = p_scope_type and p.scope_key = p_scope_key
    and p.reply_to_id is null and p.deleted_at is null
    and not exists (select 1 from public.forum_deleted_for_user d where d.post_id = p.id and d.user_id = auth.uid())
    and (coalesce(trim(p_query), '') = '' or p.content ilike '%' || trim(p_query) || '%' or exists (
      select 1 from public.profiles pr where pr.user_id = p.author_id and not p.is_anonymous
        and pr.name ilike '%' || trim(p_query) || '%'
    ))
    and (p_kind = 'messages'
      or (p_kind = 'media' and (p.image_path is not null or p.image_url is not null or p.voice_path is not null or p.voice_url is not null))
      or (p_kind = 'links' and p.content ~* 'https?://')
      or (p_kind = 'pins' and (p.pinned_at is not null or exists (
        select 1 from public.user_pinned_messages up where up.message_id = p.id and up.user_id = auth.uid()
      )))
    )
    and (p_before_created_at is null or (p.created_at, p.id) < (p_before_created_at, p_before_id))
  order by p.created_at desc, p.id desc
  limit least(greatest(p_limit, 1), 100);
$$;

grant execute on function public.get_forum_posts_page(text,text,integer,timestamptz,uuid) to authenticated;
grant execute on function public.get_forum_thread_page(uuid,integer,timestamptz,uuid) to authenticated;
grant execute on function public.search_forum_posts(text,text,text,text,integer,timestamptz,uuid) to authenticated;
revoke all on function public.forum_post_json(public.posts) from public;
grant execute on function public.forum_post_json(public.posts) to authenticated;

create or replace function public.broadcast_forum_post_changes()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare row_data public.posts; room_topic text;
begin
  row_data := case when tg_op = 'DELETE' then old else new end;
  if row_data.scope_type is null or row_data.scope_key is null then return null; end if;
  room_topic := 'forum:' || row_data.scope_type || ':' || row_data.scope_key;
  perform realtime.broadcast_changes(room_topic, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  if row_data.reply_to_id is not null then
    perform realtime.broadcast_changes('forum-thread:' || row_data.reply_to_id::text, tg_op, tg_op, tg_table_name, tg_table_schema, new, old);
  end if;
  return null;
end;
$$;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'realtime') then
    drop policy if exists forum_members_receive_room_broadcasts on realtime.messages;
    create policy forum_members_receive_room_broadcasts on realtime.messages for select to authenticated using (
      (realtime.topic() like 'forum:%' and realtime.topic() not like 'forum-thread:%'
        and public.forum_can_access_scope(split_part(realtime.topic(), ':', 2), split_part(realtime.topic(), ':', 3)))
      or (realtime.topic() ~ '^forum-thread:[0-9a-f-]{36}$' and exists (
        select 1 from public.posts p where p.id = split_part(realtime.topic(), ':', 2)::uuid
          and public.forum_can_access_scope(p.scope_type, p.scope_key)
      ))
    );
  end if;
exception when insufficient_privilege then
  raise notice 'Skipping realtime.messages policy: managed table ownership does not permit migration DDL';
end $$;
