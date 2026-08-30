-- profiles.is_verified is the canonical access decision. Trusted email and
-- document workflows update it atomically; preserving that single authority
-- also ensures an explicit admin revocation cannot be undone by an older
-- verification record.

create or replace function public.get_my_profile_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.profiles;
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

  return to_jsonb(v_profile);
end;
$$;

revoke all on function public.get_my_profile_state() from public;
grant execute on function public.get_my_profile_state() to authenticated;
