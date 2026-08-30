-- Make the member gate authoritative across browsers and devices. A profile
-- read also repairs a stale verification flag when a trusted verification
-- record already proves that the same authenticated user was approved.

create or replace function public.get_my_profile_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles;
  v_verified_email text;
  v_document public.document_verifications;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = v_user_id;

  if not found then
    return null;
  end if;

  if not v_profile.is_verified then
    select iit_email_normalized into v_verified_email
    from public.verifications
    where user_id = v_user_id
      and upper(verified_status) = 'VERIFIED'
    order by email_verified_at desc nulls last, updated_at desc
    limit 1;

    if v_verified_email is not null then
      update public.profiles
      set is_verified = true,
          iit_email = coalesce(nullif(iit_email, ''), v_verified_email)
      where user_id = v_user_id
      returning * into v_profile;
    else
      select * into v_document
      from public.document_verifications
      where user_id = v_user_id
        and status = 'approved'
      order by reviewed_at desc nulls last, created_at desc
      limit 1;

      if found then
        update public.profiles
        set is_verified = true,
            iit_name = coalesce(nullif(iit_name, ''), v_document.iit_name),
            student_status = coalesce(nullif(student_status, ''), v_document.student_status)
        where user_id = v_user_id
        returning * into v_profile;
      end if;
    end if;
  end if;

  return to_jsonb(v_profile);
end;
$$;

revoke all on function public.get_my_profile_state() from public;
grant execute on function public.get_my_profile_state() to authenticated;

-- Profile changes made by verification functions or admins should reach an
-- already-open browser without requiring logout or a hard refresh.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end
$$;
