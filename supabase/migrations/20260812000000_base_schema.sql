-- Foundational schema for fresh Supabase projects.
-- The application originally depended on dashboard-created tables that were not
-- represented in source control. Keep this migration before every feature
-- migration so a clean project can be reproduced without manual SQL.

create extension if not exists pgcrypto with schema extensions;

do $$ begin
  create type public.app_role as enum ('admin', 'moderator', 'user');
exception when duplicate_object then null;
end $$;

create table if not exists public.education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  institution text not null,
  degree text,
  branch_area text,
  passing_year text,
  location text,
  is_other_branch boolean default false,
  is_other_institution boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  avatar_url text,
  cover_photo_url text,
  bio text,
  headline text,
  location text,
  date_of_birth date,
  iit_email text,
  iit_name text,
  student_status text,
  community_id text not null default 'iit-community',
  role public.app_role not null default 'user',
  is_verified boolean not null default false,
  onboarding_completed boolean not null default false,
  is_mentor boolean not null default false,
  mentor_category text,
  mentor_price_audio numeric,
  mentor_price_chat numeric,
  mentor_price_video numeric,
  expertise text[],
  skills text[],
  experience jsonb,
  social_links jsonb,
  slug text unique,
  slug_updated_at timestamptz,
  primary_education_id uuid,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.profiles add constraint profiles_primary_education_id_fkey
    foreign key (primary_education_id) references public.education(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  unique (user_id, role)
);

create table if not exists public.professional_experience (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_name text not null,
  job_title text,
  location text,
  logo_url text,
  start_date date,
  end_date date,
  is_current boolean default false,
  is_other_company boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  community_id text not null default 'iit-community',
  content text not null default '',
  image_url text,
  tags text[],
  channel text,
  campus_filter text,
  degree_filter text,
  branch_filter text,
  batch_filter text,
  cohort_filter text,
  student_status_filter text,
  scope_type text,
  scope_key text,
  is_anonymous boolean not null default false,
  reply_to_id uuid references public.posts(id) on delete cascade,
  reshared_post_id uuid references public.posts(id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid references auth.users(id) on delete set null,
  deleted_for_users uuid[],
  is_deleted_for_everyone boolean not null default false,
  pinned_at timestamptz,
  seen_by uuid[],
  file_url text,
  file_name text,
  file_type text,
  file_size bigint,
  voice_url text,
  voice_duration integer,
  created_at timestamptz not null default now(),
  check (char_length(content) <= 20000)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  parent_comment_id uuid references public.comments(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.reactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  emoji text,
  created_at timestamptz not null default now(),
  unique (user_id, entity_type, entity_id, emoji)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.polls (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (post_id)
);

create table if not exists public.poll_votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  option_index integer not null check (option_index >= 0),
  created_at timestamptz not null default now(),
  unique (poll_id, user_id)
);

create table if not exists public.pinned_messages (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  pinned_by uuid not null references auth.users(id) on delete cascade,
  scope_type text,
  scope_key text,
  pinned_at timestamptz not null default now(),
  unique (post_id, scope_type, scope_key)
);

create table if not exists public.user_pinned_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.posts(id) on delete cascade,
  forum_scope_type text not null default 'GLOBAL',
  forum_scope_key text not null default 'IIT_ALL',
  pinned_at timestamptz not null default now(),
  unique (user_id, message_id)
);

create table if not exists public.connections (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  community_id text not null default 'iit-community',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  check (requester_id <> receiver_id)
);

create unique index if not exists connections_pair_unique
  on public.connections (least(requester_id, receiver_id), greatest(requester_id, receiver_id));

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  name text,
  is_group boolean not null default false,
  avatar_url text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  typing_at timestamptz,
  joined_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  status text not null default 'sent',
  reply_to_message_id uuid references public.messages(id) on delete set null,
  read_at timestamptz,
  read_by uuid[],
  created_at timestamptz not null default now()
);

create table if not exists public.message_deleted_for_user (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  deleted_at timestamptz not null default now(),
  unique (message_id, user_id)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  community_id text not null default 'iit-community',
  title text not null,
  company text not null,
  location text not null default '',
  description text,
  job_type text not null default 'full-time',
  category text,
  experience text,
  experience_level text,
  easy_apply boolean not null default false,
  apply_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  applicant_id uuid not null references auth.users(id) on delete cascade,
  note text,
  resume_url text,
  created_at timestamptz not null default now(),
  unique (job_id, applicant_id)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  community_id text not null default 'iit-community',
  title text not null,
  description text,
  start_time timestamptz not null,
  end_time timestamptz,
  location text,
  created_at timestamptz not null default now()
);

create table if not exists public.rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create table if not exists public.consultations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references auth.users(id) on delete cascade,
  consultant_id uuid not null references auth.users(id) on delete cascade,
  consultation_type text not null default 'chat',
  status text not null default 'pending',
  amount numeric,
  duration_minutes integer,
  scheduled_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  started_by uuid not null references auth.users(id) on delete cascade,
  daily_room_name text not null,
  mode text not null,
  participant_count integer,
  duration_seconds integer,
  failure_reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.call_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.call_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (session_id, user_id)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  message text,
  entity_id uuid,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.blogs (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null,
  category text,
  tags text[],
  cover_image_url text,
  status text not null default 'draft',
  published boolean default false,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.blog_comments (
  id uuid primary key default gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.blog_comments(id) on delete cascade,
  content text not null,
  is_hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.blog_likes (
  id uuid primary key default gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blog_id, user_id)
);

create table if not exists public.blog_bookmarks (
  id uuid primary key default gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blog_id, user_id)
);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text,
  image_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create table if not exists public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  scope_type text not null,
  scope_key text not null,
  filters_json jsonb,
  sort text,
  pinned boolean default false,
  created_at timestamptz not null default now()
);

create table if not exists public.custom_options (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  value text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (category, value)
);

create table if not exists public.custom_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.nav_config (
  id uuid primary key default gen_random_uuid(),
  tab_key text not null unique,
  label text not null,
  icon_url text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ad_messages (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  image_url text,
  link_url text,
  scope_type text,
  scope_key text,
  is_active boolean not null default true,
  expires_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz default now()
);

create table if not exists public.verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  iit_email text not null,
  iit_email_normalized text not null unique,
  iit_domain text,
  locked_to_phone text,
  verified_status text not null default 'pending',
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.verification_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  used boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create table if not exists public.verification_audit_log (
  id uuid primary key default gen_random_uuid(),
  iit_email text not null,
  old_phone text,
  new_phone text,
  actor text,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists education_user_created_idx on public.education (user_id, created_at desc);
create index if not exists professional_experience_user_idx on public.professional_experience (user_id, created_at desc);
create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists comments_post_created_idx on public.comments (post_id, created_at);
create index if not exists messages_room_created_idx on public.messages (room_id, created_at desc);
create index if not exists notifications_user_created_idx on public.notifications (user_id, created_at desc);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role);
$$;

create or replace function public.generate_profile_slug(p_name text, p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base text := trim(both '-' from regexp_replace(lower(coalesce(p_name, 'member')), '[^a-z0-9]+', '-', 'g'));
  v_slug text;
begin
  if v_base = '' then v_base := 'member'; end if;
  v_slug := v_base || '-' || left(replace(p_user_id::text, '-', ''), 8);
  return v_slug;
end;
$$;

revoke all on function public.has_role(uuid, public.app_role) from public;
grant execute on function public.has_role(uuid, public.app_role) to authenticated;
revoke all on function public.generate_profile_slug(text, uuid) from public;
grant execute on function public.generate_profile_slug(text, uuid) to authenticated;

-- All API-facing tables are protected by RLS. Service-role calls bypass these
-- policies; browser clients only receive the minimum access required below.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'education','profiles','user_roles','professional_experience','posts','comments','reactions','reports',
    'polls','poll_votes','pinned_messages','user_pinned_messages','connections','chat_rooms','chat_members',
    'messages','message_deleted_for_user','jobs','applications','events','rsvps','consultations','call_sessions',
    'call_participants','notifications','blogs','blog_comments','blog_likes','blog_bookmarks','stories','saved_views',
    'custom_options','custom_skills','nav_config','ad_messages','app_settings','verifications','verification_codes',
    'verification_audit_log'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
  end loop;
end $$;

create policy profiles_read_authenticated on public.profiles for select to authenticated using (true);
create policy profiles_insert_own on public.profiles for insert to authenticated with check (user_id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy education_read_authenticated on public.education for select to authenticated using (true);
create policy education_insert_own on public.education for insert to authenticated with check (user_id = auth.uid());
create policy education_update_own on public.education for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy education_delete_own on public.education for delete to authenticated using (user_id = auth.uid());

create policy experience_read_authenticated on public.professional_experience for select to authenticated using (true);
create policy experience_insert_own on public.professional_experience for insert to authenticated with check (user_id = auth.uid());
create policy experience_update_own on public.professional_experience for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy experience_delete_own on public.professional_experience for delete to authenticated using (user_id = auth.uid());

create policy roles_read_own_or_admin on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy posts_read_authenticated on public.posts for select to authenticated using (true);
create policy posts_insert_own on public.posts for insert to authenticated with check (author_id = auth.uid());
create policy posts_update_own on public.posts for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy posts_delete_own on public.posts for delete to authenticated using (author_id = auth.uid());

create policy comments_read_authenticated on public.comments for select to authenticated using (true);
create policy comments_insert_own on public.comments for insert to authenticated with check (author_id = auth.uid());
create policy comments_update_own on public.comments for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy comments_delete_own on public.comments for delete to authenticated using (author_id = auth.uid());

create policy reactions_read_authenticated on public.reactions for select to authenticated using (true);
create policy reactions_insert_own on public.reactions for insert to authenticated with check (user_id = auth.uid());
create policy reactions_delete_own on public.reactions for delete to authenticated using (user_id = auth.uid());
create policy reports_insert_own on public.reports for insert to authenticated with check (reporter_id = auth.uid());
create policy reports_read_admin on public.reports for select to authenticated using (public.has_role(auth.uid(), 'admin'));

create policy polls_read_authenticated on public.polls for select to authenticated using (true);
create policy polls_insert_post_owner on public.polls for insert to authenticated
  with check (exists (select 1 from public.posts where id = post_id and author_id = auth.uid()));
create policy poll_votes_read_authenticated on public.poll_votes for select to authenticated using (true);
create policy poll_votes_insert_own on public.poll_votes for insert to authenticated with check (user_id = auth.uid());
create policy poll_votes_update_own on public.poll_votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy poll_votes_delete_own on public.poll_votes for delete to authenticated using (user_id = auth.uid());

create policy pins_read_authenticated on public.pinned_messages for select to authenticated using (true);
create policy pins_manage_admin on public.pinned_messages for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy user_pins_own on public.user_pinned_messages for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy connections_read_participants on public.connections for select to authenticated
  using (requester_id = auth.uid() or receiver_id = auth.uid());

create policy deleted_messages_own on public.message_deleted_for_user for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy jobs_read_authenticated on public.jobs for select to authenticated using (true);
create policy jobs_insert_own on public.jobs for insert to authenticated with check (created_by = auth.uid());
create policy jobs_update_own on public.jobs for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy jobs_delete_own on public.jobs for delete to authenticated using (created_by = auth.uid());
create policy applications_read_parties on public.applications for select to authenticated
  using (applicant_id = auth.uid() or exists (select 1 from public.jobs where id = job_id and created_by = auth.uid()));
create policy applications_insert_own on public.applications for insert to authenticated with check (applicant_id = auth.uid());
create policy applications_update_own on public.applications for update to authenticated using (applicant_id = auth.uid()) with check (applicant_id = auth.uid());
create policy applications_delete_own on public.applications for delete to authenticated using (applicant_id = auth.uid());

create policy events_read_authenticated on public.events for select to authenticated using (true);
create policy events_insert_own on public.events for insert to authenticated with check (created_by = auth.uid());
create policy events_update_own on public.events for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy events_delete_own on public.events for delete to authenticated using (created_by = auth.uid());
create policy rsvps_own on public.rsvps for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy consultations_participants on public.consultations for select to authenticated using (client_id = auth.uid() or consultant_id = auth.uid());
create policy consultations_insert_client on public.consultations for insert to authenticated with check (client_id = auth.uid());
create policy consultations_update_participants on public.consultations for update to authenticated
  using (client_id = auth.uid() or consultant_id = auth.uid()) with check (client_id = auth.uid() or consultant_id = auth.uid());

create policy call_sessions_room_members on public.call_sessions for select to authenticated
  using (exists (select 1 from public.chat_members where room_id = call_sessions.room_id and user_id = auth.uid()));
create policy call_sessions_start_by_self on public.call_sessions for insert to authenticated with check (started_by = auth.uid());
create policy call_participants_room_members on public.call_participants for select to authenticated
  using (exists (select 1 from public.call_sessions s join public.chat_members m on m.room_id = s.room_id where s.id = session_id and m.user_id = auth.uid()));
create policy call_participants_own on public.call_participants for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy notifications_own on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy blogs_read_published_or_own on public.blogs for select to authenticated using (published = true or author_id = auth.uid());
create policy blogs_insert_own on public.blogs for insert to authenticated with check (author_id = auth.uid());
create policy blogs_update_own on public.blogs for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy blogs_delete_own on public.blogs for delete to authenticated using (author_id = auth.uid());
create policy blog_comments_read on public.blog_comments for select to authenticated using (not is_hidden or author_id = auth.uid());
create policy blog_comments_insert_own on public.blog_comments for insert to authenticated with check (author_id = auth.uid());
create policy blog_comments_update_own on public.blog_comments for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy blog_comments_delete_own on public.blog_comments for delete to authenticated using (author_id = auth.uid());
create policy blog_likes_read on public.blog_likes for select to authenticated using (true);
create policy blog_likes_own on public.blog_likes for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy blog_bookmarks_own on public.blog_bookmarks for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy stories_read_active on public.stories for select to authenticated using (expires_at > now() or user_id = auth.uid());
create policy stories_own on public.stories for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy saved_views_own on public.saved_views for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy custom_options_read on public.custom_options for select to authenticated using (true);
create policy custom_options_admin on public.custom_options for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy custom_skills_read on public.custom_skills for select to authenticated using (true);
create policy custom_skills_admin on public.custom_skills for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy nav_config_read on public.nav_config for select to authenticated using (true);
create policy nav_config_admin on public.nav_config for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy ads_read_active on public.ad_messages for select to authenticated using (is_active and (expires_at is null or expires_at > now()));
create policy ads_admin on public.ad_messages for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
create policy settings_read on public.app_settings for select to authenticated using (true);
create policy settings_admin on public.app_settings for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create policy verifications_read_own_or_admin on public.verifications for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy audit_read_admin on public.verification_audit_log for select to authenticated using (public.has_role(auth.uid(), 'admin'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/webp','image/jpeg','image/png']),
  ('nav-icons', 'nav-icons', true, 2097152, array['image/webp','image/jpeg','image/png','image/svg+xml'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy users_upload_own_avatars on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy users_update_own_avatars on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy users_delete_own_avatars on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy admins_manage_nav_icons on storage.objects for all to authenticated
  using (bucket_id = 'nav-icons' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'nav-icons' and public.has_role(auth.uid(), 'admin'));

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages') then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;
