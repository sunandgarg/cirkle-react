-- Canonical academic identity for deterministic Forum communities.
-- Display names remain editable catalog data; authorization uses stable IDs.

create table if not exists public.academic_networks (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_institutes (
  id text primary key,
  network_id text not null references public.academic_networks(id),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_degrees (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_specialisations (
  degree_id text not null references public.academic_degrees(id),
  id text not null,
  name text not null,
  created_at timestamptz not null default now(),
  primary key (degree_id, id)
);

create table if not exists public.verified_academic_affiliations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  network_id text not null references public.academic_networks(id),
  institute_id text not null references public.academic_institutes(id),
  degree_id text not null references public.academic_degrees(id),
  specialisation_id text not null,
  graduation_year integer not null check (graduation_year between 1950 and 2100),
  member_status text not null check (member_status in ('current_student', 'alumni')),
  verification_status text not null default 'VERIFIED' check (verification_status in ('VERIFIED', 'SUSPENDED', 'REVOKED')),
  source_education_id uuid references public.education(id) on delete restrict,
  identity_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (degree_id, specialisation_id)
    references public.academic_specialisations(degree_id, id)
);

create table if not exists public.forum_room_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  scope_type text not null,
  scope_key text not null,
  last_read_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  notification_level text not null default 'all' check (notification_level in ('all', 'mentions', 'muted')),
  muted_until timestamptz,
  draft text not null default '',
  scroll_offset integer not null default 0 check (scroll_offset >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, scope_type, scope_key)
);

insert into public.academic_networks (id, name) values ('IIT', 'Indian Institutes of Technology')
on conflict (id) do nothing;

insert into public.academic_institutes (id, network_id, name) values
  ('IIT_BOMBAY','IIT','IIT Bombay'), ('IIT_DELHI','IIT','IIT Delhi'),
  ('IIT_MADRAS','IIT','IIT Madras'), ('IIT_KANPUR','IIT','IIT Kanpur'),
  ('IIT_KHARAGPUR','IIT','IIT Kharagpur'), ('IIT_ROORKEE','IIT','IIT Roorkee'),
  ('IIT_GUWAHATI','IIT','IIT Guwahati'), ('IIT_HYDERABAD','IIT','IIT Hyderabad'),
  ('IIT_BHU','IIT','IIT BHU'), ('IIT_INDORE','IIT','IIT Indore'),
  ('IIT_ROPAR','IIT','IIT Ropar'), ('IIT_PATNA','IIT','IIT Patna'),
  ('IIT_BHUBANESWAR','IIT','IIT Bhubaneswar'), ('IIT_GANDHINAGAR','IIT','IIT Gandhinagar'),
  ('IIT_JODHPUR','IIT','IIT Jodhpur'), ('IIT_MANDI','IIT','IIT Mandi'),
  ('IIT_TIRUPATI','IIT','IIT Tirupati'), ('IIT_PALAKKAD','IIT','IIT Palakkad'),
  ('IIT_DHARWAD','IIT','IIT Dharwad'), ('IIT_BHILAI','IIT','IIT Bhilai'),
  ('IIT_GOA','IIT','IIT Goa'), ('IIT_JAMMU','IIT','IIT Jammu'),
  ('IIT_DHANBAD_ISM','IIT','IIT Dhanbad (ISM)')
on conflict (id) do update set name = excluded.name;

insert into public.academic_degrees (id, name) values
  ('BTECH','BTech'), ('MTECH','MTech'), ('PHD','PhD'), ('MSC','MSc'), ('MBA','MBA'),
  ('DUAL_DEGREE','Dual Degree'), ('BS','BS'), ('MS','MS'), ('MA','MA'), ('BDES','BDes'),
  ('MDES','MDes'), ('BARCH','BArch'), ('MARCH','MArch'), ('MS_BY_RESEARCH','MS by Research'),
  ('MPP','MPP'), ('EXECUTIVE_MBA','Executive MBA'), ('INTEGRATED_DEGREE','Integrated Degree'),
  ('MCP','MCP'), ('MHRM','MHRM'), ('LLB','LLB'), ('LLM','LLM'), ('MMST','MMST'),
  ('MENGG','MEngg'), ('MDP','MDP'), ('BSC_BED','BSc-BEd'), ('B_CYBER','B.Cyber'),
  ('MDES_BY_RESEARCH','MDes by Research'), ('MA_BY_RESEARCH','MA by Research')
on conflict (id) do update set name = excluded.name;

-- A custom course becomes a community dimension only after an admin approves it.
insert into public.academic_degrees (id, name)
select distinct public.forum_scope_segment(course_name), trim(course_name)
from public.course_verification_requests
where status = 'approved'
on conflict (id) do update set name = excluded.name;

-- Catalog existing approved/selected specialisations before affiliation backfill.
insert into public.academic_specialisations (degree_id, id, name)
select distinct d.id, public.forum_scope_segment(e.branch_area), trim(e.branch_area)
from public.education e
join public.academic_degrees d on d.name = trim(e.degree)
where nullif(trim(e.branch_area), '') is not null
on conflict (degree_id, id) do nothing;

insert into public.academic_specialisations (degree_id, id, name)
select id, 'GENERAL', 'General' from public.academic_degrees
on conflict (degree_id, id) do nothing;

-- Backfill one locked primary affiliation per verified account.
insert into public.verified_academic_affiliations (
  user_id, network_id, institute_id, degree_id, specialisation_id,
  graduation_year, member_status, source_education_id
)
select p.user_id, i.network_id, i.id, d.id, public.forum_scope_segment(e.branch_area),
  e.passing_year::integer, p.student_status, e.id
from public.profiles p
join lateral (
  select ed.* from public.education ed
  where ed.user_id = p.user_id
    and nullif(trim(ed.degree), '') is not null
    and nullif(trim(ed.branch_area), '') is not null
    and trim(ed.passing_year) ~ '^[0-9]{4}$'
  order by (ed.id = p.primary_education_id) desc, ed.created_at desc
  limit 1
) e on true
join public.academic_institutes i on i.name = trim(p.iit_name)
join public.academic_degrees d on d.name = trim(e.degree)
where p.is_verified = true and p.student_status in ('current_student', 'alumni')
on conflict (user_id) do nothing;

-- Claim the first verified primary affiliation automatically. Later identity
-- changes do not rewrite it; an admin must approve corrections.
create or replace function public.claim_verified_academic_affiliation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  edu public.education%rowtype;
  institute_key text;
  degree_key text;
  specialisation_key text;
begin
  if new.is_verified is not true
    or new.student_status not in ('current_student', 'alumni')
    or new.primary_education_id is null
    or exists (select 1 from public.verified_academic_affiliations where user_id = new.user_id)
  then
    return new;
  end if;

  select * into edu from public.education
  where id = new.primary_education_id and user_id = new.user_id;
  if not found or nullif(trim(edu.degree), '') is null
    or nullif(trim(edu.branch_area), '') is null
    or trim(edu.passing_year) !~ '^[0-9]{4}$'
  then
    return new;
  end if;

  select id into institute_key from public.academic_institutes where name = trim(new.iit_name);
  select id into degree_key from public.academic_degrees where name = trim(edu.degree);
  specialisation_key := public.forum_scope_segment(edu.branch_area);
  if institute_key is null or degree_key is null then return new; end if;

  insert into public.academic_specialisations (degree_id, id, name)
  values (degree_key, specialisation_key, trim(edu.branch_area))
  on conflict (degree_id, id) do nothing;

  insert into public.verified_academic_affiliations (
    user_id, network_id, institute_id, degree_id, specialisation_id,
    graduation_year, member_status, source_education_id
  ) values (
    new.user_id, 'IIT', institute_key, degree_key, specialisation_key,
    edu.passing_year::integer, new.student_status, edu.id
  ) on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists claim_verified_academic_affiliation_trigger on public.profiles;
create trigger claim_verified_academic_affiliation_trigger
after insert or update of is_verified, student_status, primary_education_id on public.profiles
for each row execute function public.claim_verified_academic_affiliation();

-- Retry a previously blocked custom-course claim as soon as an admin approves it.
create or replace function public.claim_affiliation_after_course_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from new.status then
    insert into public.academic_degrees (id, name)
    values (public.forum_scope_segment(new.course_name), trim(new.course_name))
    on conflict (id) do update set name = excluded.name;

    update public.profiles
    set primary_education_id = primary_education_id
    where user_id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists claim_affiliation_after_course_approval_trigger on public.course_verification_requests;
create trigger claim_affiliation_after_course_approval_trigger
after update of status on public.course_verification_requests
for each row execute function public.claim_affiliation_after_course_approval();

create index if not exists idx_affiliation_access_dimensions
  on public.verified_academic_affiliations
  (verification_status, network_id, institute_id, degree_id, specialisation_id, graduation_year);
create index if not exists idx_forum_room_state_opened
  on public.forum_room_state (user_id, last_opened_at desc);

alter table public.academic_networks enable row level security;
alter table public.academic_institutes enable row level security;
alter table public.academic_degrees enable row level security;
alter table public.academic_specialisations enable row level security;
alter table public.verified_academic_affiliations enable row level security;
alter table public.forum_room_state enable row level security;

create policy academic_catalog_read on public.academic_networks for select using (true);
create policy institute_catalog_read on public.academic_institutes for select using (true);
create policy degree_catalog_read on public.academic_degrees for select using (true);
create policy specialisation_catalog_read on public.academic_specialisations for select using (true);
create policy users_read_own_affiliation on public.verified_academic_affiliations for select to authenticated
  using (user_id = (select auth.uid()) or public.forum_is_admin());
create policy admins_manage_affiliations on public.verified_academic_affiliations for all to authenticated
  using (public.forum_is_admin()) with check (public.forum_is_admin());
create policy users_manage_own_forum_state on public.forum_room_state for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Replace string-derived authorization with the locked canonical affiliation.
create or replace function public.forum_can_access_scope(p_scope_type text, p_scope_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.verified_academic_affiliations a
    where a.user_id = (select auth.uid())
      and a.verification_status = 'VERIFIED'
      and a.member_status in ('current_student', 'alumni')
      and case p_scope_type
        when 'GLOBAL' then p_scope_key = a.network_id || '_ALL'
        when 'CAMPUS' then p_scope_key = a.institute_id
        when 'COURSE_CAMPUS' then p_scope_key = a.institute_id || '|' || a.degree_id || '_' || a.specialisation_id
        when 'COURSE_GLOBAL' then p_scope_key = a.degree_id || '_' || a.specialisation_id
        when 'BATCH_CAMPUS' then p_scope_key = a.institute_id || '|' || a.graduation_year::text
        when 'BATCH_GLOBAL' then p_scope_key = a.graduation_year::text
        when 'COHORT' then p_scope_key = a.institute_id || '|' || a.degree_id || '|' || a.specialisation_id || '|' || a.graduation_year::text
        when 'COHORT_GLOBAL' then p_scope_key = a.degree_id || '|' || a.specialisation_id || '|' || a.graduation_year::text
        else false
      end
  );
$$;

-- Tighten owner updates too: a sender may edit content, but cannot move a post
-- into a community they do not belong to by changing its scope columns.
drop policy if exists forum_posts_update_owner_or_admin on public.posts;
create policy forum_posts_update_owner_or_admin
on public.posts for update to authenticated
using (author_id = (select auth.uid()) or public.forum_is_admin())
with check (
  public.forum_is_admin()
  or (
    author_id = (select auth.uid())
    and ((scope_type is null and channel is null) or public.forum_can_access_scope(scope_type, scope_key))
  )
);

create or replace function public.get_my_academic_identity()
returns table (
  network_id text, institute_id text, institute_name text, degree_id text,
  degree_name text, specialisation_id text, specialisation_name text,
  graduation_year integer, member_status text
)
language sql
stable
security definer
set search_path = public
as $$
  select a.network_id, a.institute_id, i.name, a.degree_id, d.name,
    a.specialisation_id, s.name, a.graduation_year, a.member_status
  from public.verified_academic_affiliations a
  join public.academic_institutes i on i.id = a.institute_id
  join public.academic_degrees d on d.id = a.degree_id
  join public.academic_specialisations s on s.degree_id = a.degree_id and s.id = a.specialisation_id
  where a.user_id = (select auth.uid()) and a.verification_status = 'VERIFIED';
$$;

create or replace function public.mark_forum_scope_read(p_scope_type text, p_scope_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.forum_can_access_scope(p_scope_type, p_scope_key) then
    raise exception 'Forum community access denied';
  end if;
  insert into public.forum_room_state (user_id, scope_type, scope_key, last_read_at, last_opened_at)
  values (auth.uid(), p_scope_type, p_scope_key, now(), now())
  on conflict (user_id, scope_type, scope_key) do update
    set last_read_at = excluded.last_read_at, last_opened_at = excluded.last_opened_at, updated_at = now();
end;
$$;

create or replace function public.save_forum_room_state(
  p_scope_type text, p_scope_key text, p_draft text default '', p_scroll_offset integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.forum_can_access_scope(p_scope_type, p_scope_key) then
    raise exception 'Forum community access denied';
  end if;
  insert into public.forum_room_state (user_id, scope_type, scope_key, draft, scroll_offset, last_opened_at)
  values (auth.uid(), p_scope_type, p_scope_key, left(coalesce(p_draft, ''), 4000), greatest(p_scroll_offset, 0), now())
  on conflict (user_id, scope_type, scope_key) do update
    set draft = excluded.draft, scroll_offset = excluded.scroll_offset,
        last_opened_at = excluded.last_opened_at, updated_at = now();
end;
$$;

create or replace function public.get_forum_room_state(p_scope_type text, p_scope_key text)
returns table (draft text, scroll_offset integer, last_read_at timestamptz, notification_level text)
language sql
stable
security definer
set search_path = public
as $$
  select s.draft, s.scroll_offset, s.last_read_at, s.notification_level
  from public.forum_room_state s
  where s.user_id = (select auth.uid())
    and s.scope_type = p_scope_type and s.scope_key = p_scope_key
    and public.forum_can_access_scope(p_scope_type, p_scope_key);
$$;

-- Return only a boolean dot for each deterministic room. EXISTS can stop at
-- the first indexed post and avoids expensive unread COUNT(*) scans.
create or replace function public.get_my_forum_unread()
returns table (scope_type text, scope_key text, has_unread boolean)
language sql
stable
security definer
set search_path = public
as $$
  with identity as (
    select * from public.verified_academic_affiliations
    where user_id = (select auth.uid()) and verification_status = 'VERIFIED'
  ), scopes(scope_type, scope_key) as (
    select 'GLOBAL', network_id || '_ALL' from identity
    union all select 'CAMPUS', institute_id from identity
    union all select 'COURSE_CAMPUS', institute_id || '|' || degree_id || '_' || specialisation_id from identity
    union all select 'COURSE_GLOBAL', degree_id || '_' || specialisation_id from identity
    union all select 'BATCH_CAMPUS', institute_id || '|' || graduation_year::text from identity
    union all select 'BATCH_GLOBAL', graduation_year::text from identity
    union all select 'COHORT', institute_id || '|' || degree_id || '|' || specialisation_id || '|' || graduation_year::text from identity
    union all select 'COHORT_GLOBAL', degree_id || '|' || specialisation_id || '|' || graduation_year::text from identity
  )
  select sc.scope_type, sc.scope_key,
    exists (
      select 1 from public.posts p
      where p.scope_type = sc.scope_type and p.scope_key = sc.scope_key
        and p.deleted_at is null
        and p.author_id <> (select auth.uid())
        and p.created_at > coalesce(rs.last_read_at, 'epoch'::timestamptz)
      limit 1
    ) as has_unread
  from scopes sc
  left join public.forum_room_state rs
    on rs.user_id = (select auth.uid())
   and rs.scope_type = sc.scope_type and rs.scope_key = sc.scope_key;
$$;

revoke all on function public.get_my_academic_identity() from public;
revoke all on function public.mark_forum_scope_read(text, text) from public;
revoke all on function public.save_forum_room_state(text, text, text, integer) from public;
revoke all on function public.get_forum_room_state(text, text) from public;
revoke all on function public.get_my_forum_unread() from public;
grant execute on function public.get_my_academic_identity() to authenticated;
grant execute on function public.mark_forum_scope_read(text, text) to authenticated;
grant execute on function public.save_forum_room_state(text, text, text, integer) to authenticated;
grant execute on function public.get_forum_room_state(text, text) to authenticated;
grant execute on function public.get_my_forum_unread() to authenticated;
