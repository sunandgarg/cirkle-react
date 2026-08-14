-- Enforce forum membership from the user's verified IIT profile and primary education.
-- Scope keys match src/lib/forumScopes.ts.

create or replace function public.forum_scope_segment(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select regexp_replace(
    regexp_replace(upper(trim(coalesce(p_value, ''))), '[^A-Z0-9]+', '_', 'g'),
    '^_+|_+$', '', 'g'
  );
$$;

create or replace function public.forum_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'admin'
  );
$$;

create or replace function public.forum_can_access_scope(p_scope_type text, p_scope_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    left join lateral (
      select e.degree, e.branch_area, e.passing_year
      from public.education e
      where e.user_id = p.user_id
        and nullif(trim(e.degree), '') is not null
        and nullif(trim(e.branch_area), '') is not null
        and nullif(trim(e.passing_year), '') is not null
      order by (e.id = p.primary_education_id) desc, e.created_at desc
      limit 1
    ) e on true
    where p.user_id = (select auth.uid())
      and p.is_verified = true
      and p.student_status in ('current_student', 'alumni')
      and nullif(trim(p.iit_name), '') is not null
      and case p_scope_type
        when 'GLOBAL' then p_scope_key = 'IIT_ALL'
        when 'CAMPUS' then
          p_scope_key = public.forum_scope_segment(p.iit_name)
        when 'COURSE_CAMPUS' then
          p_scope_key = public.forum_scope_segment(p.iit_name) || '|' ||
            public.forum_scope_segment(e.degree) || '_' || public.forum_scope_segment(e.branch_area)
        when 'COURSE_GLOBAL' then
          p_scope_key = public.forum_scope_segment(e.degree) || '_' || public.forum_scope_segment(e.branch_area)
        when 'BATCH_CAMPUS' then
          p_scope_key = public.forum_scope_segment(p.iit_name) || '|' || public.forum_scope_segment(e.passing_year)
        when 'BATCH_GLOBAL' then
          p_scope_key = public.forum_scope_segment(e.passing_year)
        when 'COHORT' then
          p_scope_key = public.forum_scope_segment(p.iit_name) || '|' ||
            public.forum_scope_segment(e.degree) || '|' || public.forum_scope_segment(e.branch_area) || '|' ||
            public.forum_scope_segment(e.passing_year)
        when 'COHORT_GLOBAL' then
          p_scope_key = public.forum_scope_segment(e.degree) || '|' || public.forum_scope_segment(e.branch_area) || '|' ||
            public.forum_scope_segment(e.passing_year)
        else false
      end
  );
$$;

revoke all on function public.forum_scope_segment(text) from public;
revoke all on function public.forum_is_admin() from public;
revoke all on function public.forum_can_access_scope(text, text) from public;
grant execute on function public.forum_scope_segment(text) to authenticated;
grant execute on function public.forum_is_admin() to authenticated;
grant execute on function public.forum_can_access_scope(text, text) to authenticated;

-- Normalize legacy forum rows when enough filter information exists. Home-feed
-- posts have both channel and scope_type null and are intentionally untouched.
update public.posts
set scope_type = 'GLOBAL', scope_key = 'IIT_ALL'
where scope_type is null and channel in ('global', 'all-iit-global');

update public.posts
set scope_type = 'CAMPUS', scope_key = public.forum_scope_segment(campus_filter)
where scope_type is null and channel = 'my-campus' and nullif(trim(campus_filter), '') is not null;

update public.posts
set scope_type = 'COURSE_CAMPUS',
    scope_key = public.forum_scope_segment(campus_filter) || '|' ||
      public.forum_scope_segment(degree_filter) || '_' || public.forum_scope_segment(branch_filter)
where scope_type is null and channel = 'course-campus'
  and nullif(trim(campus_filter), '') is not null
  and nullif(trim(degree_filter), '') is not null
  and nullif(trim(branch_filter), '') is not null;

update public.posts
set scope_type = 'COURSE_GLOBAL',
    scope_key = public.forum_scope_segment(degree_filter) || '_' || public.forum_scope_segment(branch_filter)
where scope_type is null and channel = 'course-global'
  and nullif(trim(degree_filter), '') is not null
  and nullif(trim(branch_filter), '') is not null;

update public.posts
set scope_type = 'BATCH_CAMPUS',
    scope_key = public.forum_scope_segment(campus_filter) || '|' || public.forum_scope_segment(batch_filter)
where scope_type is null and channel = 'batch-campus'
  and nullif(trim(campus_filter), '') is not null
  and nullif(trim(batch_filter), '') is not null;

update public.posts
set scope_type = 'BATCH_GLOBAL', scope_key = public.forum_scope_segment(batch_filter)
where scope_type is null and channel = 'batch-global' and nullif(trim(batch_filter), '') is not null;

create index if not exists idx_posts_forum_scope_created
  on public.posts (scope_type, scope_key, created_at desc)
  where scope_type is not null and deleted_at is null;

create index if not exists idx_education_user_created
  on public.education (user_id, created_at desc);

alter table public.posts enable row level security;

-- Replace any permissive legacy policies so browser-side scope changes cannot
-- reveal or write messages outside the authenticated member's communities.
do $$
declare
  policy_record record;
begin
  for policy_record in
    select policyname from pg_policies where schemaname = 'public' and tablename = 'posts'
  loop
    execute format('drop policy %I on public.posts', policy_record.policyname);
  end loop;
end $$;

create policy forum_posts_read_by_scope
on public.posts for select to authenticated
using (
  public.forum_is_admin()
  or (scope_type is null and channel is null)
  or public.forum_can_access_scope(scope_type, scope_key)
);

create policy home_posts_public_read
on public.posts for select to anon
using (scope_type is null and channel is null);

create policy forum_posts_insert_by_scope
on public.posts for insert to authenticated
with check (
  author_id = (select auth.uid())
  and (
    (scope_type is null and channel is null)
    or public.forum_can_access_scope(scope_type, scope_key)
  )
);

create policy forum_posts_update_owner_or_admin
on public.posts for update to authenticated
using (author_id = (select auth.uid()) or public.forum_is_admin())
with check (author_id = (select auth.uid()) or public.forum_is_admin());

create policy forum_posts_delete_owner_or_admin
on public.posts for delete to authenticated
using (author_id = (select auth.uid()) or public.forum_is_admin());

create or replace function public.mark_forum_post_seen(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then
    raise exception 'Authentication required';
  end if;

  update public.posts
  set seen_by = case
    when viewer_id = any(coalesce(seen_by, '{}'::uuid[])) then seen_by
    else array_append(coalesce(seen_by, '{}'::uuid[]), viewer_id)
  end
  where id = p_post_id
    and (
      public.forum_is_admin()
      or (scope_type is null and channel is null)
      or public.forum_can_access_scope(scope_type, scope_key)
    );
end;
$$;

revoke all on function public.mark_forum_post_seen(uuid) from public;
grant execute on function public.mark_forum_post_seen(uuid) to authenticated;
