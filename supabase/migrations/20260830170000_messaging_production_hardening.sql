-- Production hardening for forum anonymity, realtime fan-out, direct-chat
-- delivery/read receipts, private chat media and public login-OTP throttling.

-- Anonymous forum authors are kept in a server-only mapping. The public posts
-- row deliberately contains no user identifier for anonymous messages.
create table if not exists public.forum_anonymous_authors (
  post_id uuid primary key references public.posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.forum_anonymous_authors enable row level security;
revoke all on table public.forum_anonymous_authors from anon, authenticated;
grant all on table public.forum_anonymous_authors to service_role;
create index if not exists forum_anonymous_authors_author_idx
  on public.forum_anonymous_authors(author_id, created_at desc);

insert into public.forum_anonymous_authors(post_id, author_id, created_at)
select id, author_id, created_at from public.posts
where is_anonymous = true and author_id is not null
on conflict (post_id) do nothing;

alter table public.posts alter column author_id drop not null;
drop trigger if exists broadcast_forum_post_changes on public.posts;
update public.posts set author_id = null
where is_anonymous = true and author_id is not null;

create or replace function public.forum_viewer_is_author(p_post_id uuid, p_author_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    p_author_id = auth.uid()
    or exists (
      select 1 from public.forum_anonymous_authors a
      where a.post_id = p_post_id and a.author_id = auth.uid()
    )
  );
$$;
revoke all on function public.forum_viewer_is_author(uuid,uuid) from public;
grant execute on function public.forum_viewer_is_author(uuid,uuid) to authenticated;

create or replace function public.forum_post_json(p public.posts)
returns jsonb language sql stable security definer set search_path = public as $$
  select (to_jsonb(p) - 'author_id') || jsonb_build_object(
    'author_id', case
      when not p.is_anonymous then p.author_id
      when public.forum_viewer_is_author(p.id, p.author_id) or public.forum_is_admin() then (
        select a.author_id from public.forum_anonymous_authors a where a.post_id = p.id
      )
      else null
    end,
    'viewer_is_author', public.forum_viewer_is_author(p.id, p.author_id),
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
revoke all on function public.forum_post_json(public.posts) from public;
grant execute on function public.forum_post_json(public.posts) to authenticated;

-- All forum writes go through one idempotent server boundary. This prevents
-- forged anonymous identities and enforces both burst and configured slow mode.
create or replace function public.create_forum_post(
  p_id uuid,
  p_scope_type text,
  p_scope_key text,
  p_content text default '',
  p_is_anonymous boolean default false,
  p_reply_to_id uuid default null,
  p_image_path text default null,
  p_file_path text default null,
  p_file_name text default null,
  p_file_size bigint default null,
  p_file_type text default null,
  p_voice_path text default null,
  p_voice_duration integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_post public.posts;
  v_setting text;
  v_slow_enabled boolean := false;
  v_slow_seconds integer := 0;
  v_last_post timestamptz;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_id is null or nullif(trim(p_scope_type), '') is null or nullif(trim(p_scope_key), '') is null then
    raise exception 'Invalid forum destination';
  end if;
  if not public.forum_can_access_scope(p_scope_type, p_scope_key) and not public.forum_is_admin() then
    raise exception 'Forum membership required' using errcode = '42501';
  end if;
  if char_length(coalesce(p_content, '')) > 20000 then raise exception 'Message is too long'; end if;
  if nullif(trim(coalesce(p_content, '')), '') is null
    and p_image_path is null and p_file_path is null and p_voice_path is null then
    raise exception 'Message content is required';
  end if;
  if p_image_path is not null and p_image_path not like v_user_id::text || '/%' then raise exception 'Invalid image path'; end if;
  if p_file_path is not null and p_file_path not like v_user_id::text || '/%' then raise exception 'Invalid file path'; end if;
  if p_voice_path is not null and p_voice_path not like v_user_id::text || '/%' then raise exception 'Invalid voice path'; end if;
  if p_reply_to_id is not null and not exists (
    select 1 from public.posts parent
    where parent.id = p_reply_to_id and parent.scope_type = p_scope_type
      and parent.scope_key = p_scope_key and parent.reply_to_id is null and parent.deleted_at is null
  ) then raise exception 'Reply target is unavailable'; end if;

  select * into v_post from public.posts existing where existing.id = p_id;
  if found then
    if not public.forum_viewer_is_author(p_id, v_post.author_id) then raise exception 'Message identifier already exists'; end if;
    return public.forum_post_json(v_post);
  end if;

  if not public.forum_is_admin() then
    if (select count(*) from public.posts recent
        left join public.forum_anonymous_authors aa on aa.post_id = recent.id
        where coalesce(recent.author_id, aa.author_id) = v_user_id
          and recent.created_at > now() - interval '10 seconds') >= 8 then
      raise exception 'You are sending messages too quickly. Wait a moment.' using errcode = 'P0001';
    end if;
    select value into v_setting from public.app_settings
    where key in ('slow_mode_' || p_scope_type || '_' || p_scope_key, 'slow_mode_global')
    order by case when key = 'slow_mode_' || p_scope_type || '_' || p_scope_key then 0 else 1 end
    limit 1;
    if v_setting is not null then
      begin
        v_slow_enabled := coalesce((v_setting::jsonb ->> 'enabled')::boolean, false);
        v_slow_seconds := greatest(0, least(3600, coalesce((v_setting::jsonb ->> 'seconds')::integer, 30)));
      exception when others then
        v_slow_enabled := false;
      end;
    end if;
    if v_slow_enabled and v_slow_seconds > 0 then
      select max(recent.created_at) into v_last_post
      from public.posts recent
      left join public.forum_anonymous_authors aa on aa.post_id = recent.id
      where coalesce(recent.author_id, aa.author_id) = v_user_id
        and recent.scope_type = p_scope_type and recent.scope_key = p_scope_key;
      if v_last_post is not null and v_last_post > now() - make_interval(secs => v_slow_seconds) then
        raise exception 'Slow mode is active. Wait before sending another message.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  insert into public.posts(
    id, author_id, community_id, scope_type, scope_key, channel, content, is_anonymous,
    reply_to_id, image_path, file_path, file_name, file_size, file_type, voice_path, voice_duration
  ) values (
    p_id, case when p_is_anonymous then null else v_user_id end, 'default', p_scope_type, p_scope_key,
    lower(replace(p_scope_type, '_', '-')), coalesce(p_content, ''), p_is_anonymous,
    p_reply_to_id, p_image_path, p_file_path, p_file_name, p_file_size, p_file_type, p_voice_path, p_voice_duration
  ) returning * into v_post;

  if p_is_anonymous then
    insert into public.forum_anonymous_authors(post_id, author_id) values (v_post.id, v_user_id);
  end if;
  return public.forum_post_json(v_post);
end;
$$;
revoke all on function public.create_forum_post(uuid,text,text,text,boolean,uuid,text,text,text,bigint,text,text,integer) from public;
grant execute on function public.create_forum_post(uuid,text,text,text,boolean,uuid,text,text,text,bigint,text,text,integer) to authenticated;

drop policy if exists forum_posts_insert_by_scope on public.posts;
create policy forum_posts_insert_by_scope on public.posts for insert to authenticated with check (
  is_anonymous = false and author_id = auth.uid()
  and ((scope_type is null and channel is null) or public.forum_can_access_scope(scope_type, scope_key))
);
drop policy if exists forum_posts_update_owner_or_admin on public.posts;
create policy forum_posts_update_owner_or_admin on public.posts for update to authenticated
using (public.forum_viewer_is_author(id, author_id) or public.forum_is_admin())
with check (
  public.forum_is_admin()
  or (is_anonymous = false and author_id = auth.uid())
  or (is_anonymous = true and author_id is null and public.forum_viewer_is_author(id, author_id))
);
drop policy if exists forum_posts_delete_owner_or_admin on public.posts;
create policy forum_posts_delete_owner_or_admin on public.posts for delete to authenticated
using (public.forum_viewer_is_author(id, author_id) or public.forum_is_admin());
drop policy if exists polls_insert_post_owner on public.polls;
create policy polls_insert_post_owner on public.polls for insert to authenticated with check (
  exists (select 1 from public.posts p where p.id = post_id and public.forum_viewer_is_author(p.id, p.author_id))
);

-- Send root messages only to the room topic and replies only to the thread.
-- Anonymous payloads never contain an author UUID.
create or replace function public.broadcast_forum_post_changes()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare
  row_data public.posts;
  safe_new jsonb := null;
  safe_old jsonb := null;
  topic text;
begin
  row_data := case when tg_op = 'DELETE' then old else new end;
  if row_data.scope_type is null or row_data.scope_key is null then return null; end if;
  if tg_op <> 'DELETE' then
    safe_new := to_jsonb(new);
    if new.is_anonymous then safe_new := safe_new - 'author_id'; end if;
  end if;
  if tg_op <> 'INSERT' then
    safe_old := to_jsonb(old);
    if old.is_anonymous then safe_old := safe_old - 'author_id'; end if;
  end if;
  topic := case when row_data.reply_to_id is null
    then 'forum:' || row_data.scope_type || ':' || row_data.scope_key
    else 'forum-thread:' || row_data.reply_to_id::text end;
  perform realtime.send(
    jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op,
      'record', safe_new, 'old_record', safe_old),
    tg_op, topic, true
  );
  return null;
end;
$$;
create trigger broadcast_forum_post_changes
after insert or update or delete on public.posts
for each row execute function public.broadcast_forum_post_changes();

-- Direct chat: private media, deterministic pagination fields, read receipts
-- and database-level spam protection.
alter table public.messages add column if not exists media_path text;
alter table public.messages add column if not exists media_bucket text not null default 'chat-media';
alter table public.messages add column if not exists voice_duration integer;

update public.messages set
  media_path = substring(media_url from '/object/public/post-images/([^?]+)'),
  media_bucket = 'post-images'
where media_path is null and media_url like '%/object/public/post-images/%';

-- Extend the private forum-media read policy to legacy chat images that were
-- stored in post-images before the dedicated chat bucket existed.
drop policy if exists forum_media_member_read on storage.objects;
create policy forum_media_member_read on storage.objects for select to authenticated using (
  bucket_id in ('post-images', 'forum-files', 'voice-notes') and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (
      select 1 from public.posts p where (p.image_path = name or p.file_path = name or p.voice_path = name)
        and (public.forum_is_admin() or public.forum_can_access_scope(p.scope_type, p.scope_key))
    )
    or exists (
      select 1 from public.messages m where m.media_path = name and m.media_bucket = bucket_id
        and public.is_chat_member(m.room_id)
    )
  )
);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('chat-media', 'chat-media', false, 20971520,
  array['image/webp','image/jpeg','image/png','audio/webm','audio/mp4','audio/mpeg','audio/aac'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists chat_media_upload_own on storage.objects;
create policy chat_media_upload_own on storage.objects for insert to authenticated with check (
  bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists chat_media_read_members on storage.objects;
create policy chat_media_read_members on storage.objects for select to authenticated using (
  bucket_id = 'chat-media' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.messages m where m.media_path = name and public.is_chat_member(m.room_id))
  )
);
drop policy if exists chat_media_manage_own on storage.objects;
create policy chat_media_manage_own on storage.objects for update to authenticated
using (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists chat_media_delete_own on storage.objects;
create policy chat_media_delete_own on storage.objects for delete to authenticated using (
  bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text
);

create or replace function public.enforce_chat_message_rate()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if (select count(*) from public.messages m
      where m.sender_id = auth.uid() and m.created_at > now() - interval '10 seconds') >= 12 then
    raise exception 'You are sending messages too quickly. Wait a moment.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists enforce_chat_message_rate on public.messages;
create trigger enforce_chat_message_rate before insert on public.messages
for each row execute function public.enforce_chat_message_rate();

create or replace function public.mark_chat_read(p_room_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not public.is_chat_member(p_room_id, v_user_id) then raise exception 'Chat membership required'; end if;
  update public.chat_members set last_read_at = now()
  where room_id = p_room_id and user_id = v_user_id;
  update public.messages set
    read_by = case when v_user_id = any(coalesce(read_by, '{}'::uuid[])) then read_by
      else array_append(coalesce(read_by, '{}'::uuid[]), v_user_id) end,
    read_at = coalesce(read_at, now())
  where room_id = p_room_id and sender_id <> v_user_id
    and not (v_user_id = any(coalesce(read_by, '{}'::uuid[])));
end;
$$;
revoke all on function public.mark_chat_read(uuid) from public;
grant execute on function public.mark_chat_read(uuid) to authenticated;

create or replace function public.broadcast_chat_message_changes()
returns trigger language plpgsql security definer set search_path = public, realtime as $$
declare row_data public.messages;
begin
  row_data := case when tg_op = 'DELETE' then old else new end;
  perform realtime.send(
    jsonb_build_object('schema', tg_table_schema, 'table', tg_table_name, 'type', tg_op,
      'record', case when tg_op = 'DELETE' then null else to_jsonb(new) end,
      'old_record', case when tg_op = 'INSERT' then null else to_jsonb(old) end),
    tg_op, 'chat:' || row_data.room_id::text, true
  );
  return null;
end;
$$;
drop trigger if exists broadcast_chat_message_changes on public.messages;
create trigger broadcast_chat_message_changes after insert or update or delete on public.messages
for each row execute function public.broadcast_chat_message_changes();

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'realtime') then
    drop policy if exists chat_members_receive_broadcasts on realtime.messages;
    create policy chat_members_receive_broadcasts on realtime.messages for select to authenticated using (
      realtime.topic() ~ '^chat:[0-9a-f-]{36}$'
      and public.is_chat_member(split_part(realtime.topic(), ':', 2)::uuid)
    );
    drop policy if exists chat_members_send_broadcasts on realtime.messages;
    create policy chat_members_send_broadcasts on realtime.messages for insert to authenticated with check (
      realtime.topic() ~ '^chat:[0-9a-f-]{36}$'
      and public.is_chat_member(split_part(realtime.topic(), ':', 2)::uuid)
    );
  end if;
exception when insufficient_privilege then
  raise notice 'Skipping chat realtime policy: managed table ownership does not permit migration DDL';
end $$;

create or replace function public.chat_broadcast_ready()
returns boolean language sql stable security definer set search_path = public, realtime as $$
  select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'realtime' and p.proname = 'send');
$$;
revoke all on function public.chat_broadcast_ready() from public;
grant execute on function public.chat_broadcast_ready() to authenticated;

-- Public login OTP requests use hashes only and are rate limited before SES.
create table if not exists public.login_otp_rate_limits (
  id bigint generated by default as identity primary key,
  email_hash text not null,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
revoke all on table public.login_otp_rate_limits from anon, authenticated;
grant all on table public.login_otp_rate_limits to service_role;
create index if not exists login_otp_email_created_idx on public.login_otp_rate_limits(email_hash, created_at desc);
create index if not exists login_otp_ip_created_idx on public.login_otp_rate_limits(ip_hash, created_at desc);

create or replace function public.reserve_login_otp_attempt(p_email_hash text, p_ip_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Not authorized'; end if;
  delete from public.login_otp_rate_limits where created_at < now() - interval '1 day';
  if (select count(*) from public.login_otp_rate_limits where email_hash = p_email_hash and created_at > now() - interval '15 minutes') >= 5
    or (select count(*) from public.login_otp_rate_limits where ip_hash = p_ip_hash and created_at > now() - interval '15 minutes') >= 20 then
    return false;
  end if;
  insert into public.login_otp_rate_limits(email_hash, ip_hash) values (p_email_hash, p_ip_hash);
  return true;
end;
$$;
revoke all on function public.reserve_login_otp_attempt(text,text) from public, anon, authenticated;
grant execute on function public.reserve_login_otp_attempt(text,text) to service_role;
