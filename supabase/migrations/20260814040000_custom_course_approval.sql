-- Approval workflow for courses not included in the standardized IIT program list.
create table if not exists public.course_verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  course_name text not null check (char_length(trim(course_name)) between 2 and 100),
  iit_name text not null,
  applicant_name text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  review_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists course_verification_user_created_idx
  on public.course_verification_requests (user_id, created_at desc);
create index if not exists course_verification_status_created_idx
  on public.course_verification_requests (status, created_at desc);
create index if not exists course_verification_created_idx
  on public.course_verification_requests (created_at desc);
create unique index if not exists course_verification_one_pending_per_user_idx
  on public.course_verification_requests (user_id) where status = 'pending';

alter table public.course_verification_requests enable row level security;

drop policy if exists users_create_own_course_request on public.course_verification_requests;
create policy users_create_own_course_request
  on public.course_verification_requests for insert to authenticated
  with check (auth.uid() = user_id and status = 'pending');

drop policy if exists users_read_own_course_request on public.course_verification_requests;
create policy users_read_own_course_request
  on public.course_verification_requests for select to authenticated
  using (
    auth.uid() = user_id or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and role = 'admin'
    )
  );

create or replace function public.withdraw_course_verification(p_request_id uuid)
returns public.course_verification_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.course_verification_requests;
begin
  update public.course_verification_requests
  set status = 'withdrawn', updated_at = now()
  where id = p_request_id and user_id = auth.uid() and status = 'pending'
  returning * into v_request;

  if v_request.id is null then raise exception 'Pending course request not found'; end if;
  return v_request;
end;
$$;

create or replace function public.review_course_verification(
  p_request_id uuid,
  p_status text,
  p_notes text default null
)
returns public.course_verification_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.course_verification_requests;
begin
  if not exists (
    select 1 from public.user_roles where user_id = auth.uid() and role = 'admin'
  ) then raise exception 'Admin access required'; end if;

  if p_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected';
  end if;
  if p_status = 'rejected' and nullif(trim(p_notes), '') is null then
    raise exception 'A rejection reason is required';
  end if;

  update public.course_verification_requests
  set status = p_status,
      review_notes = nullif(trim(p_notes), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_request_id and status = 'pending'
  returning * into v_request;

  if v_request.id is null then raise exception 'Pending course request not found'; end if;
  return v_request;
end;
$$;

revoke all on function public.withdraw_course_verification(uuid) from public;
revoke all on function public.review_course_verification(uuid, text, text) from public;
grant execute on function public.withdraw_course_verification(uuid) to authenticated;
grant execute on function public.review_course_verification(uuid, text, text) to authenticated;
