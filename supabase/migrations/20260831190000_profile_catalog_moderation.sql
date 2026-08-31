-- Moderated profile catalogs, verified education protection and company artwork.

alter table public.custom_options
  add column if not exists status text not null default 'pending',
  add column if not exists logo_url text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

update public.custom_options set status = 'approved' where status = 'pending';

do $$ begin
  alter table public.custom_options add constraint custom_options_status_check
    check (status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null;
end $$;

alter table public.education
  add column if not exists is_verified boolean not null default false,
  add column if not exists approval_status text not null default 'approved',
  add column if not exists institution_option_id uuid references public.custom_options(id) on delete set null,
  add column if not exists branch_option_id uuid references public.custom_options(id) on delete set null,
  add column if not exists location_option_id uuid references public.custom_options(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

alter table public.professional_experience
  add column if not exists approval_status text not null default 'approved',
  add column if not exists company_option_id uuid references public.custom_options(id) on delete set null,
  add column if not exists location_option_id uuid references public.custom_options(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

do $$ begin
  alter table public.education add constraint education_approval_status_check
    check (approval_status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.professional_experience add constraint experience_approval_status_check
    check (approval_status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null;
end $$;

update public.education e
set is_verified = true
from public.verified_academic_affiliations a
where a.source_education_id = e.id and a.verification_status = 'VERIFIED';

create table if not exists public.pending_profile_options (
  user_id uuid not null references auth.users(id) on delete cascade,
  field text not null check (field in ('location', 'mentor_category')),
  value text not null,
  option_id uuid not null references public.custom_options(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, field)
);

alter table public.pending_profile_options enable row level security;
drop policy if exists pending_profile_options_owner_read on public.pending_profile_options;
create policy pending_profile_options_owner_read on public.pending_profile_options
  for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

drop policy if exists custom_options_read on public.custom_options;
drop policy if exists custom_options_admin on public.custom_options;
drop policy if exists custom_options_visible on public.custom_options;
drop policy if exists custom_options_admin_manage on public.custom_options;
create policy custom_options_visible on public.custom_options
  for select to authenticated
  using (status = 'approved' or created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));
create policy custom_options_admin_manage on public.custom_options
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists education_read_authenticated on public.education;
drop policy if exists education_visible on public.education;
create policy education_visible on public.education
  for select to authenticated
  using (approval_status = 'approved' or user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

drop policy if exists experience_read_authenticated on public.professional_experience;
drop policy if exists experience_visible on public.professional_experience;
create policy experience_visible on public.professional_experience
  for select to authenticated
  using (approval_status = 'approved' or user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

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
      set status = 'pending', logo_url = coalesce(nullif(trim(p_logo_url), ''), logo_url),
          reviewed_by = null, reviewed_at = null, updated_at = now()
      where id = v_option.id returning * into v_option;
    elsif v_option.created_by = v_user and nullif(trim(p_logo_url), '') is not null then
      update public.custom_options set logo_url = trim(p_logo_url), updated_at = now()
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

create or replace function public.submit_profile_custom_value(p_field text, p_value text)
returns table(option_id uuid, option_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_field text := lower(trim(p_field));
  v_value text := trim(p_value);
  v_option public.custom_options%rowtype;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if v_field not in ('location', 'mentor_category') then raise exception 'Unsupported profile field'; end if;
  if length(v_value) < 2 or length(v_value) > 120 then raise exception 'Value must be 2 to 120 characters'; end if;

  select * into v_option from public.custom_options
  where category = v_field and lower(value) = lower(v_value)
  order by (status = 'approved') desc, created_at asc limit 1;

  if not found then
    insert into public.custom_options(category, value, created_by, status)
    values (v_field, v_value, v_user, 'pending') returning * into v_option;
  elsif v_option.created_by = v_user and v_option.status = 'rejected' then
    update public.custom_options set status = 'pending', reviewed_by = null, reviewed_at = null, updated_at = now()
    where id = v_option.id returning * into v_option;
  end if;

  if v_option.status = 'approved' then
    if v_field = 'location' then update public.profiles set location = v_option.value where user_id = v_user;
    else update public.profiles set mentor_category = v_option.value where user_id = v_user;
    end if;
    delete from public.pending_profile_options where user_id = v_user and field = v_field;
  else
    insert into public.pending_profile_options(user_id, field, value, option_id)
    values (v_user, v_field, v_value, v_option.id)
    on conflict (user_id, field) do update
      set value = excluded.value, option_id = excluded.option_id, updated_at = now();
  end if;

  return query select v_option.id, v_option.status;
end;
$$;

create or replace function public.review_custom_option(
  p_option_id uuid,
  p_status text,
  p_value text default null,
  p_logo_url text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_option public.custom_options%rowtype;
  v_status text := lower(trim(p_status));
  v_value text;
begin
  if not public.has_role(auth.uid(), 'admin') then raise exception 'Admin access required'; end if;
  if v_status not in ('approved', 'rejected') then raise exception 'Invalid review status'; end if;
  select * into v_option from public.custom_options where id = p_option_id for update;
  if not found then raise exception 'Suggestion not found'; end if;
  v_value := coalesce(nullif(trim(p_value), ''), v_option.value);

  update public.custom_options set
    value = v_value,
    logo_url = coalesce(nullif(trim(p_logo_url), ''), logo_url),
    status = v_status,
    reviewed_by = auth.uid(),
    reviewed_at = now(),
    updated_at = now()
  where id = p_option_id;

  if v_option.category = 'institution' then
    update public.education set institution = v_value, approval_status = v_status, updated_at = now()
    where institution_option_id = p_option_id;
  elsif v_option.category = 'branch' then
    update public.education set branch_area = v_value, approval_status = v_status, updated_at = now()
    where branch_option_id = p_option_id;
  elsif v_option.category = 'company' then
    update public.professional_experience
    set company_name = v_value,
        logo_url = coalesce(nullif(trim(p_logo_url), ''), logo_url),
        approval_status = v_status,
        updated_at = now()
    where company_option_id = p_option_id;
  elsif v_option.category = 'location' then
    update public.education set location = v_value, approval_status = v_status, updated_at = now()
    where location_option_id = p_option_id;
    update public.professional_experience set location = v_value, approval_status = v_status, updated_at = now()
    where location_option_id = p_option_id;
  end if;

  if v_status = 'approved' then
    update public.profiles p set location = v_value
    from public.pending_profile_options q
    where q.option_id = p_option_id and q.field = 'location' and p.user_id = q.user_id;
    update public.profiles p set mentor_category = v_value
    from public.pending_profile_options q
    where q.option_id = p_option_id and q.field = 'mentor_category' and p.user_id = q.user_id;
    delete from public.pending_profile_options where option_id = p_option_id;
  end if;
end;
$$;

create or replace function public.prepare_profile_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_institution_status text;
  v_branch_status text;
  v_company_status text;
  v_location_status text;
begin
  if tg_table_name = 'education' then
    if tg_op = 'UPDATE' and old.is_verified and auth.uid() is not null and not public.has_role(auth.uid(), 'admin')
      and (new.institution, new.degree, new.branch_area, new.passing_year, new.location)
        is distinct from (old.institution, old.degree, old.branch_area, old.passing_year, old.location)
    then
      raise exception 'Verified education cannot be edited';
    end if;
    if new.institution_option_id is not null then select status into v_institution_status from public.custom_options where id = new.institution_option_id; end if;
    if new.branch_option_id is not null then select status into v_branch_status from public.custom_options where id = new.branch_option_id; end if;
    if new.location_option_id is not null then select status into v_location_status from public.custom_options where id = new.location_option_id; end if;
    if coalesce(v_institution_status, 'approved') = 'rejected' or coalesce(v_branch_status, 'approved') = 'rejected' or coalesce(v_location_status, 'approved') = 'rejected' then new.approval_status := 'rejected';
    elsif coalesce(v_institution_status, 'approved') = 'pending' or coalesce(v_branch_status, 'approved') = 'pending' or coalesce(v_location_status, 'approved') = 'pending' then new.approval_status := 'pending';
    else new.approval_status := 'approved'; end if;
  else
    if new.company_option_id is not null then select status into v_company_status from public.custom_options where id = new.company_option_id; end if;
    if new.location_option_id is not null then select status into v_location_status from public.custom_options where id = new.location_option_id; end if;
    if coalesce(v_company_status, 'approved') = 'rejected' or coalesce(v_location_status, 'approved') = 'rejected' then new.approval_status := 'rejected';
    elsif coalesce(v_company_status, 'approved') = 'pending' or coalesce(v_location_status, 'approved') = 'pending' then new.approval_status := 'pending';
    else new.approval_status := 'approved'; end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prepare_education_profile_entry on public.education;
create trigger prepare_education_profile_entry before insert or update on public.education
for each row execute function public.prepare_profile_entry();
drop trigger if exists prepare_experience_profile_entry on public.professional_experience;
create trigger prepare_experience_profile_entry before insert or update on public.professional_experience
for each row execute function public.prepare_profile_entry();

create or replace function public.protect_verified_education_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.is_verified and auth.uid() is not null and not public.has_role(auth.uid(), 'admin') then
    raise exception 'Verified education cannot be deleted';
  end if;
  return old;
end;
$$;
drop trigger if exists protect_verified_education_delete_trigger on public.education;
create trigger protect_verified_education_delete_trigger before delete on public.education
for each row execute function public.protect_verified_education_delete();

create or replace function public.sync_verified_education_marker()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.source_education_id is not null then
    update public.education set is_verified = false where id = old.source_education_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.source_education_id is not null and new.verification_status = 'VERIFIED' then
    update public.education set is_verified = true where id = new.source_education_id;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists sync_verified_education_marker_trigger on public.verified_academic_affiliations;
create trigger sync_verified_education_marker_trigger
after insert or update or delete on public.verified_academic_affiliations
for each row execute function public.sync_verified_education_marker();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('entity-logos', 'entity-logos', true, 2097152, array['image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2097152, allowed_mime_types = array['image/webp'];

drop policy if exists entity_logos_read on storage.objects;
create policy entity_logos_read on storage.objects for select using (bucket_id = 'entity-logos');
drop policy if exists entity_logos_owner_insert on storage.objects;
create policy entity_logos_owner_insert on storage.objects for insert to authenticated
with check (bucket_id = 'entity-logos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists entity_logos_owner_update on storage.objects;
create policy entity_logos_owner_update on storage.objects for update to authenticated
using (bucket_id = 'entity-logos' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(), 'admin')))
with check (bucket_id = 'entity-logos' and ((storage.foldername(name))[1] = auth.uid()::text or public.has_role(auth.uid(), 'admin')));

grant select on public.pending_profile_options to authenticated;
grant execute on function public.submit_custom_option(text, text, text) to authenticated;
grant execute on function public.submit_profile_custom_value(text, text) to authenticated;
grant execute on function public.review_custom_option(uuid, text, text, text) to authenticated;

create index if not exists custom_options_moderation_idx on public.custom_options(status, category, created_at desc);
create index if not exists education_visibility_idx on public.education(user_id, approval_status, created_at desc);
create index if not exists experience_visibility_idx on public.professional_experience(user_id, approval_status, created_at desc);
