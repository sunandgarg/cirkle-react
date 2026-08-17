-- Remove client-side authentication/verification bypasses and protect security-sensitive fields.

alter table public.verification_codes add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.verification_codes add column if not exists attempts integer not null default 0;
create index if not exists verification_codes_user_email_created_idx
  on public.verification_codes (user_id, email, created_at desc);

revoke all on table public.verification_codes from anon, authenticated;
revoke insert, update, delete on table public.verifications from anon, authenticated;
grant select on table public.verifications to authenticated;

delete from public.app_settings
where key in ('test_mode', 'verification_test_mode', 'sms_api_key', 'sms_provider');

drop function if exists public.ensure_super_admin(uuid);

create table if not exists public.platform_owners (
  user_id uuid primary key references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.platform_owners enable row level security;
revoke all on table public.platform_owners from anon, authenticated;

-- Preserve current operators without encoding a phone number or email in shipped code.
insert into public.platform_owners (user_id)
select user_id from public.user_roles where role = 'admin'
on conflict (user_id) do nothing;

create or replace function public.is_platform_owner()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_owners where user_id = auth.uid());
$$;
revoke all on function public.is_platform_owner() from public;
grant execute on function public.is_platform_owner() to authenticated;

create or replace function public.grant_admin_role(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner() then raise exception 'Platform owner access required'; end if;
  if not exists (select 1 from auth.users where id = p_target_user_id) then raise exception 'User not found'; end if;
  if not exists (select 1 from public.user_roles where user_id = p_target_user_id and role = 'admin') then
    insert into public.user_roles (user_id, role) values (p_target_user_id, 'admin');
  end if;
end;
$$;

create or replace function public.revoke_admin_role(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_platform_owner() then raise exception 'Platform owner access required'; end if;
  if exists (select 1 from public.platform_owners where user_id = p_target_user_id) then
    raise exception 'Platform owners cannot be demoted from the client';
  end if;
  delete from public.user_roles where user_id = p_target_user_id and role = 'admin';
end;
$$;
revoke all on function public.grant_admin_role(uuid) from public;
revoke all on function public.revoke_admin_role(uuid) from public;
grant execute on function public.grant_admin_role(uuid) to authenticated;
grant execute on function public.revoke_admin_role(uuid) to authenticated;

create or replace function public.set_member_verification(p_target_user_id uuid, p_verified boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'admin') then
    raise exception 'Admin access required';
  end if;
  update public.profiles set is_verified = p_verified where user_id = p_target_user_id;
  if not found then raise exception 'Profile not found'; end if;
end;
$$;
revoke all on function public.set_member_verification(uuid, boolean) from public;
grant execute on function public.set_member_verification(uuid, boolean) to authenticated;

-- Users may edit presentation fields only. Verification, IIT identity, role and onboarding
-- status are owned by trusted RPCs/Edge Functions.
revoke insert, update on table public.profiles from authenticated;
grant update (
  name, headline, bio, location, date_of_birth, skills, expertise, social_links,
  is_mentor, mentor_category, mentor_price_chat, mentor_price_audio, mentor_price_video,
  slug, slug_updated_at, avatar_url, cover_photo_url
) on table public.profiles to authenticated;

create or replace function public.complete_iit_email_verification(
  p_code_id uuid,
  p_user_id uuid,
  p_email text,
  p_iit_name text,
  p_student_status text,
  p_locked_phone text,
  p_display_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_code_count integer;
begin
  if p_student_status not in ('current_student', 'alumni') then raise exception 'Invalid member status'; end if;
  if exists (
    select 1 from public.verifications
    where iit_email_normalized = v_email and verified_status = 'VERIFIED' and user_id <> p_user_id
  ) then raise exception 'IIT email already linked'; end if;

  update public.verification_codes set used = true
  where id = p_code_id and user_id = p_user_id and email = v_email and used = false and expires_at > now();
  get diagnostics v_code_count = row_count;
  if v_code_count <> 1 then raise exception 'Verification code is no longer valid'; end if;

  if exists (select 1 from public.verifications where user_id = p_user_id) then
    update public.verifications set
      iit_email = v_email, iit_email_normalized = v_email, iit_domain = split_part(v_email, '@', 2),
      email_verified_at = now(), verified_status = 'VERIFIED', locked_to_phone = p_locked_phone, updated_at = now()
    where user_id = p_user_id;
  else
    insert into public.verifications (
      user_id, iit_email, iit_email_normalized, iit_domain, email_verified_at,
      verified_status, locked_to_phone, updated_at
    ) values (
      p_user_id, v_email, v_email, split_part(v_email, '@', 2), now(),
      'VERIFIED', p_locked_phone, now()
    );
  end if;

  if exists (select 1 from public.profiles where user_id = p_user_id) then
    update public.profiles set
      iit_name = trim(p_iit_name), student_status = p_student_status, iit_email = v_email,
      is_verified = true, onboarding_completed = false
    where user_id = p_user_id;
  else
    insert into public.profiles (
      user_id, name, iit_name, student_status, iit_email, is_verified, onboarding_completed
    ) values (
      p_user_id, nullif(trim(p_display_name), ''), trim(p_iit_name), p_student_status, v_email, true, false
    );
  end if;
end;
$$;
revoke all on function public.complete_iit_email_verification(uuid,uuid,text,text,text,text,text) from public;
grant execute on function public.complete_iit_email_verification(uuid,uuid,text,text,text,text,text) to service_role;
