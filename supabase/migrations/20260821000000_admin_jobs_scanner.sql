-- Admin-managed jobs with review states, scanner source registry and scan audit history.

alter table public.jobs
  add column if not exists status text not null default 'published',
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_url text,
  add column if not exists source_fingerprint text,
  add column if not exists scan_run_id uuid,
  add column if not exists salary_text text,
  add column if not exists skills text[] not null default '{}',
  add column if not exists expires_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.jobs add constraint jobs_status_check
    check (status in ('draft', 'published', 'archived', 'closed'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.jobs add constraint jobs_source_type_check
    check (source_type in ('manual', 'scan', 'community'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.jobs add constraint jobs_apply_url_https_check
    check (apply_url is null or apply_url ~* '^https://') not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.jobs add constraint jobs_source_url_https_check
    check (source_url is null or source_url ~* '^https://') not valid;
exception when duplicate_object then null; end $$;

update public.jobs
set published_at = coalesce(published_at, created_at)
where status = 'published' and published_at is null;

create table if not exists public.job_scan_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini', 'custom')),
  model text not null,
  company text,
  source_urls text[] not null,
  instructions text,
  publish_mode text not null default 'draft' check (publish_mode in ('draft', 'published')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  discovered_count integer not null default 0,
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.job_scan_sources (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  source_url text not null unique,
  provider text not null default 'gemini' check (provider in ('openai', 'anthropic', 'gemini', 'custom')),
  model text not null,
  instructions text,
  auto_publish boolean not null default false,
  is_active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete cascade,
  last_scanned_at timestamptz,
  last_scan_status text check (last_scan_status is null or last_scan_status in ('completed', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_scan_sources_https_check check (source_url ~ '^https://')
);

do $$ begin
  alter table public.jobs add constraint jobs_scan_run_id_fkey
    foreign key (scan_run_id) references public.job_scan_runs(id) on delete set null;
exception when duplicate_object then null; end $$;

create unique index if not exists jobs_source_fingerprint_unique
  on public.jobs (source_fingerprint) where source_fingerprint is not null;
create index if not exists jobs_public_feed_idx
  on public.jobs (published_at desc, created_at desc) where status = 'published';
create index if not exists jobs_company_status_idx on public.jobs (company, status, created_at desc);
create index if not exists jobs_skills_gin on public.jobs using gin (skills);
create index if not exists job_scan_runs_requested_idx on public.job_scan_runs (requested_by, created_at desc);
create index if not exists job_scan_sources_active_idx on public.job_scan_sources (is_active, updated_at desc);

create or replace function public.is_job_admin(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = p_user_id and role = 'admin'
  );
$$;

create or replace function public.can_apply_job(p_job_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id is not null and exists (
    select 1 from public.jobs job
    where job.id = p_job_id
      and job.status = 'published'
      and (job.expires_at is null or job.expires_at > now())
      and exists (
        select 1 from public.profiles profile
        where profile.user_id = p_user_id and profile.is_verified = true
      )
  );
$$;

revoke all on function public.is_job_admin(uuid) from public;
revoke all on function public.can_apply_job(uuid, uuid) from public;
grant execute on function public.is_job_admin(uuid) to anon, authenticated, service_role;
grant execute on function public.can_apply_job(uuid, uuid) to authenticated, service_role;

alter table public.jobs enable row level security;
alter table public.applications enable row level security;
alter table public.job_scan_runs enable row level security;
alter table public.job_scan_sources enable row level security;

do $$
declare policy_record record;
begin
  for policy_record in
    select tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('jobs', 'applications', 'job_scan_runs', 'job_scan_sources')
  loop
    execute format('drop policy if exists %I on public.%I', policy_record.policyname, policy_record.tablename);
  end loop;
end $$;

create policy jobs_read_published_or_admin on public.jobs
  for select to anon, authenticated
  using (
    public.is_job_admin(auth.uid())
    or (status = 'published' and (expires_at is null or expires_at > now()))
  );
create policy jobs_admin_insert on public.jobs
  for insert to authenticated
  with check (public.is_job_admin(auth.uid()) and created_by = auth.uid());
create policy jobs_admin_update on public.jobs
  for update to authenticated
  using (public.is_job_admin(auth.uid()))
  with check (public.is_job_admin(auth.uid()));
create policy jobs_admin_delete on public.jobs
  for delete to authenticated using (public.is_job_admin(auth.uid()));

create policy applications_read_parties_or_admin on public.applications
  for select to authenticated
  using (
    applicant_id = auth.uid()
    or public.is_job_admin(auth.uid())
    or exists (select 1 from public.jobs where id = job_id and created_by = auth.uid())
  );
create policy applications_insert_eligible on public.applications
  for insert to authenticated
  with check (applicant_id = auth.uid() and public.can_apply_job(job_id, auth.uid()));
create policy applications_update_own on public.applications
  for update to authenticated
  using (applicant_id = auth.uid())
  with check (applicant_id = auth.uid() and public.can_apply_job(job_id, auth.uid()));
create policy applications_delete_own_or_admin on public.applications
  for delete to authenticated using (applicant_id = auth.uid() or public.is_job_admin(auth.uid()));

create policy job_scan_runs_admin_all on public.job_scan_runs
  for all to authenticated
  using (public.is_job_admin(auth.uid()))
  with check (public.is_job_admin(auth.uid()));
create policy job_scan_sources_admin_all on public.job_scan_sources
  for all to authenticated
  using (public.is_job_admin(auth.uid()))
  with check (public.is_job_admin(auth.uid()));

grant select on public.jobs to anon, authenticated;
grant insert, update, delete on public.jobs to authenticated;
grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, update, delete on public.job_scan_runs to authenticated;
grant select, insert, update, delete on public.job_scan_sources to authenticated;
