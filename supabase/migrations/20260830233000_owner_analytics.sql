-- Owner analytics and lightweight first-party activity tracking.
-- Raw auth/user tables remain inaccessible to browsers; only the platform owner
-- can read the aggregate dashboard returned by get_admin_analytics().

create table if not exists public.user_activity_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_path text,
  primary key (user_id, session_id),
  check (char_length(session_id) between 8 and 100),
  check (last_path is null or char_length(last_path) <= 500)
);

create table if not exists public.user_activity_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_date date not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  session_count integer not null default 0 check (session_count >= 0),
  page_view_count integer not null default 0 check (page_view_count >= 0),
  primary key (user_id, activity_date)
);

create index if not exists user_activity_sessions_last_seen_idx
  on public.user_activity_sessions (last_seen_at desc);
create index if not exists user_activity_daily_date_idx
  on public.user_activity_daily (activity_date desc, user_id);

alter table public.user_activity_sessions enable row level security;
alter table public.user_activity_daily enable row level security;
revoke all on table public.user_activity_sessions from anon, authenticated;
revoke all on table public.user_activity_daily from anon, authenticated;

create or replace function public.record_user_activity(p_session_id text, p_path text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_date date := (now() at time zone 'Asia/Kolkata')::date;
  v_is_new integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_session_id is null or char_length(p_session_id) not between 8 and 100 then
    raise exception 'Invalid activity session';
  end if;

  insert into public.user_activity_sessions (user_id, session_id, started_at, last_seen_at, last_path)
  values (v_user_id, p_session_id, v_now, v_now, left(p_path, 500))
  on conflict (user_id, session_id) do nothing;
  get diagnostics v_is_new = row_count;

  if v_is_new = 0 then
    update public.user_activity_sessions
       set last_seen_at = v_now, last_path = left(p_path, 500)
     where user_id = v_user_id and session_id = p_session_id;
  end if;

  insert into public.user_activity_daily (
    user_id, activity_date, first_seen_at, last_seen_at, session_count, page_view_count
  ) values (
    v_user_id, v_date, v_now, v_now, v_is_new, 1
  )
  on conflict (user_id, activity_date) do update set
    first_seen_at = least(user_activity_daily.first_seen_at, excluded.first_seen_at),
    last_seen_at = greatest(user_activity_daily.last_seen_at, excluded.last_seen_at),
    session_count = user_activity_daily.session_count + excluded.session_count,
    page_view_count = user_activity_daily.page_view_count + 1;
end;
$$;
revoke all on function public.record_user_activity(text, text) from public;
grant execute on function public.record_user_activity(text, text) to authenticated;

-- Historical messages provide a useful pre-launch activity baseline. They do
-- not fabricate sessions/page views, and future browser visits are counted by
-- record_user_activity().
insert into public.user_activity_daily (
  user_id, activity_date, first_seen_at, last_seen_at, session_count, page_view_count
)
select user_id, activity_date, min(created_at), max(created_at), 0, 0
from (
  select author_id as user_id, (created_at at time zone 'Asia/Kolkata')::date as activity_date, created_at
  from public.posts
  union all
  select sender_id, (created_at at time zone 'Asia/Kolkata')::date, created_at
  from public.messages
) activity
where user_id is not null
group by user_id, activity_date
on conflict (user_id, activity_date) do update set
  first_seen_at = least(user_activity_daily.first_seen_at, excluded.first_seen_at),
  last_seen_at = greatest(user_activity_daily.last_seen_at, excluded.last_seen_at);

create or replace function public.get_admin_analytics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(7, least(coalesce(p_days, 30), 90));
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_result jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Platform owner access required'; end if;

  with
  summary as (
    select
      (select count(*) from auth.users) as total_users,
      (select count(*) from auth.users where (created_at at time zone 'Asia/Kolkata')::date = v_today) as registrations_today,
      (select count(*) from public.user_activity_daily where activity_date = v_today) as active_users_today,
      (select coalesce(sum(session_count), 0) from public.user_activity_daily where activity_date = v_today) as sessions_today,
      (select count(*) from public.posts where (created_at at time zone 'Asia/Kolkata')::date = v_today) as forum_messages_today,
      (select count(*) from public.messages where (created_at at time zone 'Asia/Kolkata')::date = v_today) as direct_messages_today,
      (select count(*) from public.posts where created_at >= now() - interval '7 days')
        + (select count(*) from public.messages where created_at >= now() - interval '7 days') as messages_7d,
      (select count(*) from public.posts) + (select count(*) from public.messages) as messages_total,
      (select count(*) from public.jobs where status = 'published' and (expires_at is null or expires_at > now())) as published_jobs,
      (select count(*) from public.applications where (created_at at time zone 'Asia/Kolkata')::date = v_today) as applications_today
  ),
  day_series as (
    select generate_series(v_today - (v_days - 1), v_today, interval '1 day')::date as day
  ),
  daily as (
    select d.day,
      (select count(*) from auth.users u where (u.created_at at time zone 'Asia/Kolkata')::date = d.day) as registrations,
      (select count(*) from public.user_activity_daily a where a.activity_date = d.day) as active_users,
      (select coalesce(sum(a.session_count), 0) from public.user_activity_daily a where a.activity_date = d.day) as sessions,
      (select count(*) from public.posts p where (p.created_at at time zone 'Asia/Kolkata')::date = d.day)
        + (select count(*) from public.messages m where (m.created_at at time zone 'Asia/Kolkata')::date = d.day) as messages
    from day_series d
  ),
  retention_offsets as (
    select unnest(array[1,2,3,7,14,30])::integer as day_offset
  ),
  retention as (
    select o.day_offset,
      count(u.id) filter (
        where (u.created_at at time zone 'Asia/Kolkata')::date <= v_today - o.day_offset
      ) as eligible,
      count(u.id) filter (
        where (u.created_at at time zone 'Asia/Kolkata')::date <= v_today - o.day_offset
          and exists (
            select 1 from public.user_activity_daily a
            where a.user_id = u.id
              and a.activity_date = (u.created_at at time zone 'Asia/Kolkata')::date + o.day_offset
          )
      ) as returned
    from retention_offsets o cross join auth.users u
    group by o.day_offset
  )
  select jsonb_build_object(
    'generated_at', now(),
    'timezone', 'Asia/Kolkata',
    'summary', (select to_jsonb(summary) from summary),
    'daily', (select coalesce(jsonb_agg(to_jsonb(daily) order by day), '[]'::jsonb) from daily),
    'retention', (select coalesce(jsonb_agg(
      jsonb_build_object(
        'day', day_offset,
        'eligible', eligible,
        'returned', returned,
        'rate', case when eligible = 0 then 0 else round((returned::numeric / eligible::numeric) * 100, 1) end
      ) order by day_offset
    ), '[]'::jsonb) from retention)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.get_admin_analytics(integer) from public;
grant execute on function public.get_admin_analytics(integer) to authenticated;

-- Keep the designated founder account durable across environments without
-- embedding any password or service credential in application code.
insert into public.platform_owners (user_id)
select id from auth.users where lower(email) = 'sunandgarg@gmail.com'
on conflict (user_id) do nothing;

insert into public.user_roles (user_id, role)
select id, 'admin'::public.app_role from auth.users where lower(email) = 'sunandgarg@gmail.com'
on conflict (user_id, role) do nothing;

update public.profiles p
set role = 'admin'::public.app_role
from auth.users u
where p.user_id = u.id and lower(u.email) = 'sunandgarg@gmail.com';
