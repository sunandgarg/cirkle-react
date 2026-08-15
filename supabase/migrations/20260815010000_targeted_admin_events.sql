-- Admin-managed events with database-enforced audience targeting and scan audit history.

alter table public.events
  add column if not exists status text not null default 'published',
  add column if not exists audience_mode text not null default 'everyone',
  add column if not exists target_iits text[] not null default '{}',
  add column if not exists target_courses text[] not null default '{}',
  add column if not exists target_specialisations text[] not null default '{}',
  add column if not exists organizer text,
  add column if not exists registration_url text,
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_url text,
  add column if not exists source_fingerprint text,
  add column if not exists scan_run_id uuid,
  add column if not exists published_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.events add constraint events_status_check
    check (status in ('draft', 'published', 'archived'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.events add constraint events_audience_mode_check
    check (audience_mode in ('everyone', 'targeted'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.events add constraint events_source_type_check
    check (source_type in ('manual', 'scan'));
exception when duplicate_object then null; end $$;

update public.events
set published_at = coalesce(published_at, created_at)
where status = 'published' and published_at is null;

create table if not exists public.event_scan_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('openai', 'anthropic', 'gemini')),
  model text not null,
  source_urls text[] not null,
  instructions text,
  audience_mode text not null default 'everyone' check (audience_mode in ('everyone', 'targeted')),
  target_iits text[] not null default '{}',
  target_courses text[] not null default '{}',
  target_specialisations text[] not null default '{}',
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  discovered_count integer not null default 0,
  imported_count integer not null default 0,
  skipped_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.event_scan_runs
  add column if not exists audience_mode text not null default 'everyone',
  add column if not exists target_iits text[] not null default '{}',
  add column if not exists target_courses text[] not null default '{}',
  add column if not exists target_specialisations text[] not null default '{}';

do $$ begin
  alter table public.event_scan_runs add constraint event_scan_runs_audience_mode_check
    check (audience_mode in ('everyone', 'targeted'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.events add constraint events_scan_run_id_fkey
    foreign key (scan_run_id) references public.event_scan_runs(id) on delete set null;
exception when duplicate_object then null; end $$;

create unique index if not exists events_source_fingerprint_unique
  on public.events (source_fingerprint) where source_fingerprint is not null;
create index if not exists events_status_start_idx on public.events (status, start_time);
create index if not exists events_target_iits_gin on public.events using gin (target_iits);
create index if not exists events_target_courses_gin on public.events using gin (target_courses);
create index if not exists events_target_specs_gin on public.events using gin (target_specialisations);
create index if not exists event_scan_runs_requested_idx on public.event_scan_runs (requested_by, created_at desc);

do $$ begin
  alter table public.events add constraint events_registration_url_https_check
    check (registration_url is null or registration_url ~ '^https://');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.events add constraint events_end_after_start_check
    check (end_time is null or end_time >= start_time);
exception when duplicate_object then null; end $$;

create or replace function public.is_event_admin(p_user_id uuid default auth.uid())
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

create or replace function public.can_view_event(p_event_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.events ev
    where ev.id = p_event_id
      and p_user_id is not null
      and (
        public.is_event_admin(p_user_id)
        or (
          ev.status = 'published'
          and (
            ev.audience_mode = 'everyone'
            or exists (
              select 1
              from public.profiles p
              where p.user_id = p_user_id
                and p.is_verified = true
                and (
                  cardinality(ev.target_iits) = 0
                  or p.iit_name = any(ev.target_iits)
                )
                and (
                  (cardinality(ev.target_courses) = 0 and cardinality(ev.target_specialisations) = 0)
                  or exists (
                    select 1
                    from public.education edu
                    where edu.user_id = p_user_id
                      and (p.primary_education_id is null or edu.id = p.primary_education_id)
                      and (cardinality(ev.target_courses) = 0 or edu.degree = any(ev.target_courses))
                      and (cardinality(ev.target_specialisations) = 0 or edu.branch_area = any(ev.target_specialisations))
                  )
                )
            )
          )
        )
      )
  );
$$;

revoke all on function public.is_event_admin(uuid) from public;
revoke all on function public.can_view_event(uuid, uuid) from public;
grant execute on function public.is_event_admin(uuid) to authenticated, service_role;
grant execute on function public.can_view_event(uuid, uuid) to authenticated, service_role;

alter table public.events enable row level security;
alter table public.event_scan_runs enable row level security;
alter table public.rsvps enable row level security;

-- Replace legacy permissive event/RSVP policies so targeting cannot be bypassed.
do $$
declare policy_record record;
begin
  for policy_record in
    select tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('events', 'event_scan_runs', 'rsvps')
  loop
    execute format('drop policy if exists %I on public.%I', policy_record.policyname, policy_record.tablename);
  end loop;
end $$;

create policy events_read_eligible on public.events
  for select to authenticated using (public.can_view_event(id, auth.uid()));
create policy events_admin_insert on public.events
  for insert to authenticated with check (public.is_event_admin(auth.uid()) and created_by = auth.uid());
create policy events_admin_update on public.events
  for update to authenticated using (public.is_event_admin(auth.uid())) with check (public.is_event_admin(auth.uid()));
create policy events_admin_delete on public.events
  for delete to authenticated using (public.is_event_admin(auth.uid()));

create policy event_scan_runs_admin_read on public.event_scan_runs
  for select to authenticated using (public.is_event_admin(auth.uid()));
create policy event_scan_runs_admin_insert on public.event_scan_runs
  for insert to authenticated with check (public.is_event_admin(auth.uid()) and requested_by = auth.uid());
create policy event_scan_runs_admin_update on public.event_scan_runs
  for update to authenticated using (public.is_event_admin(auth.uid())) with check (public.is_event_admin(auth.uid()));

create policy rsvps_read_own_or_admin on public.rsvps
  for select to authenticated using (user_id = auth.uid() or public.is_event_admin(auth.uid()));
create policy rsvps_insert_eligible on public.rsvps
  for insert to authenticated with check (user_id = auth.uid() and public.can_view_event(event_id, auth.uid()));
create policy rsvps_update_eligible on public.rsvps
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_view_event(event_id, auth.uid()));
create policy rsvps_delete_own on public.rsvps
  for delete to authenticated using (user_id = auth.uid());

grant select on public.events to authenticated;
grant insert, update, delete on public.events to authenticated;
grant select, insert, update on public.event_scan_runs to authenticated;
grant select, insert, update, delete on public.rsvps to authenticated;
