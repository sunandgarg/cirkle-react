-- A company logo belongs to the first catalog submission. Members may select
-- the company later, but only admins can replace its canonical artwork.
create or replace function public.submit_custom_option(
  p_category text,
  p_value text,
  p_logo_url text default null
)
returns table(option_id uuid, option_status text, option_value text, option_logo_url text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_category text := lower(trim(p_category));
  v_value text := trim(p_value);
  v_option public.custom_options%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_category not in ('institution', 'branch', 'company', 'location', 'mentor_category') then
    raise exception 'Unsupported option category';
  end if;
  if length(v_value) < 2 or length(v_value) > 120 then
    raise exception 'Custom value must be 2 to 120 characters';
  end if;

  select * into v_option from public.custom_options
  where category = v_category and lower(value) = lower(v_value)
  order by (status = 'approved') desc, created_at asc
  limit 1;

  if found then
    if v_option.created_by = v_user and v_option.status = 'rejected' then
      update public.custom_options
      set status = 'pending', reviewed_by = null, reviewed_at = null, updated_at = now()
      where id = v_option.id returning * into v_option;
    end if;
  else
    insert into public.custom_options(category, value, created_by, logo_url, status)
    values (v_category, v_value, v_user, nullif(trim(p_logo_url), ''), 'pending')
    returning * into v_option;
  end if;

  return query select v_option.id, v_option.status, v_option.value, v_option.logo_url;
end;
$$;

revoke all on function public.submit_custom_option(text, text, text) from public;
grant execute on function public.submit_custom_option(text, text, text) to authenticated;

-- Resolve the canonical graduation year from a verified affiliation, the
-- primary education record, or the latest usable education record.
create or replace function public.member_graduation_year(
  p_user_id uuid,
  p_primary_education_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select a.graduation_year
       from public.verified_academic_affiliations a
      where a.user_id = p_user_id),
    (select e.passing_year::integer
       from public.education e
      where e.id = p_primary_education_id
        and e.user_id = p_user_id
        and trim(e.passing_year) ~ '^[0-9]{4}$'),
    (select e.passing_year::integer
       from public.education e
      where e.user_id = p_user_id
        and trim(e.passing_year) ~ '^[0-9]{4}$'
      order by e.is_verified desc, e.created_at desc
      limit 1)
  );
$$;

revoke all on function public.member_graduation_year(uuid, uuid) from public;

create or replace function public.enforce_alumni_profile_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer;
  v_today date := timezone('Asia/Kolkata', now())::date;
begin
  if new.student_status = 'current_student' then
    v_year := public.member_graduation_year(new.user_id, new.primary_education_id);
    if v_year between 1950 and 2100 and v_today >= make_date(v_year, 7, 1) then
      new.student_status := 'alumni';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_alumni_profile_status_trigger on public.profiles;
create trigger enforce_alumni_profile_status_trigger
before insert or update of student_status, primary_education_id on public.profiles
for each row execute function public.enforce_alumni_profile_status();

create or replace function public.promote_member_after_education_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer;
  v_today date := timezone('Asia/Kolkata', now())::date;
begin
  if trim(coalesce(new.passing_year, '')) ~ '^[0-9]{4}$' then
    v_year := trim(new.passing_year)::integer;
    if v_year between 1950 and 2100 and v_today >= make_date(v_year, 7, 1) then
      update public.profiles
      set student_status = 'alumni'
      where user_id = new.user_id and student_status = 'current_student';

      update public.verified_academic_affiliations
      set member_status = 'alumni', identity_version = identity_version + 1, updated_at = now()
      where user_id = new.user_id and member_status = 'current_student';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists promote_member_after_education_change_trigger on public.education;
create trigger promote_member_after_education_change_trigger
after insert or update of passing_year on public.education
for each row execute function public.promote_member_after_education_change();

create or replace function public.sync_alumni_affiliation_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.student_status = 'alumni' and old.student_status is distinct from new.student_status then
    update public.verified_academic_affiliations
    set member_status = 'alumni', identity_version = identity_version + 1, updated_at = now()
    where user_id = new.user_id and member_status = 'current_student';
  end if;
  return new;
end;
$$;

drop trigger if exists sync_alumni_affiliation_status_trigger on public.profiles;
create trigger sync_alumni_affiliation_status_trigger
after update of student_status on public.profiles
for each row execute function public.sync_alumni_affiliation_status();

create or replace function public.promote_graduated_students(
  p_as_of date default timezone('Asia/Kolkata', now())::date
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_promoted integer := 0;
begin
  with eligible as (
    select p.user_id
    from public.profiles p
    cross join lateral (
      select public.member_graduation_year(p.user_id, p.primary_education_id) as graduation_year
    ) resolved
    where p.student_status = 'current_student'
      and resolved.graduation_year between 1950 and 2100
      and p_as_of >= make_date(resolved.graduation_year, 7, 1)
  )
  update public.profiles p
  set student_status = 'alumni'
  from eligible e
  where p.user_id = e.user_id;

  get diagnostics v_promoted = row_count;

  update public.verified_academic_affiliations a
  set member_status = 'alumni', identity_version = identity_version + 1, updated_at = now()
  where a.member_status = 'current_student'
    and p_as_of >= make_date(a.graduation_year, 7, 1);

  return v_promoted;
end;
$$;

revoke all on function public.promote_graduated_students(date) from public;

-- Immediately correct existing rows, including the 2026 cohort after July.
select public.promote_graduated_students(timezone('Asia/Kolkata', now())::date);

-- Reconcile once per day so dormant accounts and late data imports transition
-- without relying on a browser session.
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname = 'cirkle-promote-graduates'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'cirkle-promote-graduates',
    '15 18 * * *',
    'select public.promote_graduated_students(timezone(''Asia/Kolkata'', now())::date);'
  );
end;
$$;

