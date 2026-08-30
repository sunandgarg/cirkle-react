-- Durable onboarding checkpoints, required contact details, and auditable
-- document-decision notifications for the public launch flow.

create table if not exists public.onboarding_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  flow_step text not null default 'verification:account_details',
  progress_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint onboarding_progress_step_length check (length(flow_step) between 1 and 80),
  constraint onboarding_progress_data_object check (jsonb_typeof(progress_data) = 'object')
);

alter table public.onboarding_progress enable row level security;

drop policy if exists members_read_own_onboarding_progress on public.onboarding_progress;
create policy members_read_own_onboarding_progress
  on public.onboarding_progress for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists members_create_own_onboarding_progress on public.onboarding_progress;
create policy members_create_own_onboarding_progress
  on public.onboarding_progress for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists members_update_own_onboarding_progress on public.onboarding_progress;
create policy members_update_own_onboarding_progress
  on public.onboarding_progress for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists members_delete_own_onboarding_progress on public.onboarding_progress;
create policy members_delete_own_onboarding_progress
  on public.onboarding_progress for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.onboarding_progress to authenticated;

alter table public.document_verifications
  add column if not exists decision_notified_at timestamptz,
  add column if not exists decision_notification_error text;

create or replace function public.save_account_details(
  p_name text,
  p_phone_country_code text default null,
  p_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_country text := nullif(trim(coalesce(p_phone_country_code, '')), '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if length(v_name) < 2 then raise exception 'A valid full name is required'; end if;
  if length(v_phone) <> 10 then raise exception 'A valid 10-digit phone number is required'; end if;
  if v_country is null or v_country !~ '^\+[0-9]{1,4}$' then raise exception 'Choose a valid country code'; end if;

  insert into public.profiles (
    user_id, name, phone_country_code, phone_number, phone_full
  ) values (
    v_user_id, v_name, v_country, v_phone, v_country || v_phone
  )
  on conflict (user_id) do update set
    name = excluded.name,
    phone_country_code = excluded.phone_country_code,
    phone_number = excluded.phone_number,
    phone_full = excluded.phone_full;
end;
$$;

revoke all on function public.save_account_details(text,text,text) from public;
grant execute on function public.save_account_details(text,text,text) to authenticated;

-- Keep historical nullable rows valid, while preventing a new onboarding
-- completion from bypassing the required phone captured on the first screen.
create or replace function public.complete_member_onboarding(
  p_name text,
  p_iit_name text,
  p_degree text,
  p_specialisation text,
  p_passing_year text,
  p_location text default null,
  p_linkedin text default null,
  p_company text default null,
  p_phone_country_code text default null,
  p_phone text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_education_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_country text := nullif(trim(coalesce(p_phone_country_code, '')), '');
  v_saved_phone text;
  v_saved_country text;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'A valid name is required'; end if;
  if length(trim(coalesce(p_degree, ''))) < 2 or length(trim(coalesce(p_specialisation, ''))) < 2 then
    raise exception 'Course and specialisation are required';
  end if;
  if trim(coalesce(p_passing_year, '')) !~ '^[0-9]{4}$' then raise exception 'A valid passing year is required'; end if;
  if v_phone <> '' and length(v_phone) <> 10 then raise exception 'Enter a valid 10-digit phone number'; end if;
  if v_phone <> '' and (v_country is null or v_country !~ '^\+[0-9]{1,4}$') then raise exception 'Choose a valid country code'; end if;

  select phone_number, phone_country_code into v_saved_phone, v_saved_country
  from public.profiles where user_id = v_user_id;
  if coalesce(nullif(v_phone, ''), v_saved_phone) is null
    or length(coalesce(nullif(v_phone, ''), v_saved_phone)) <> 10
    or coalesce(v_country, v_saved_country) is null
  then
    raise exception 'A verified phone number is required before completing your profile';
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = v_user_id and is_verified = true and trim(iit_name) = trim(p_iit_name)
  ) then raise exception 'Verified institute identity required'; end if;

  select id into v_education_id
  from public.education
  where user_id = v_user_id and trim(institution) = trim(p_iit_name)
  order by created_at desc limit 1
  for update;

  if v_education_id is null then
    insert into public.education (user_id, institution, degree, branch_area, passing_year)
    values (v_user_id, trim(p_iit_name), trim(p_degree), trim(p_specialisation), trim(p_passing_year))
    returning id into v_education_id;
  else
    update public.education set
      degree = trim(p_degree), branch_area = trim(p_specialisation), passing_year = trim(p_passing_year)
    where id = v_education_id;
  end if;

  update public.profiles set
    name = trim(p_name),
    location = nullif(trim(coalesce(p_location, '')), ''),
    phone_country_code = coalesce(v_country, phone_country_code),
    phone_number = coalesce(nullif(v_phone, ''), phone_number),
    phone_full = coalesce(
      case when v_phone = '' then null else v_country || v_phone end,
      phone_full
    ),
    social_links = case when nullif(trim(coalesce(p_linkedin, '')), '') is null
      then social_links else coalesce(social_links, '{}'::jsonb) || jsonb_build_object('linkedin', trim(p_linkedin)) end,
    primary_education_id = v_education_id,
    onboarding_completed = true
  where user_id = v_user_id;

  if nullif(trim(coalesce(p_company, '')), '') is not null
    and not exists (select 1 from public.professional_experience where user_id = v_user_id and is_current = true and lower(company_name) = lower(trim(p_company)))
  then
    insert into public.professional_experience (user_id, company_name, is_current)
    values (v_user_id, trim(p_company), true);
  end if;

  delete from public.onboarding_progress where user_id = v_user_id;
  return v_education_id;
end;
$$;

revoke all on function public.complete_member_onboarding(text,text,text,text,text,text,text,text,text,text) from public;
grant execute on function public.complete_member_onboarding(text,text,text,text,text,text,text,text,text,text) to authenticated;
