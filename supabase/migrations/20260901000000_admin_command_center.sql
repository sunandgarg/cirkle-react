-- Expanded owner-only command centre analytics.
-- All values are computed server-side so raw auth and operational records never
-- need to be exposed to the browser.

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
      (select count(*) from auth.users where created_at >= now() - interval '7 days') as registrations_7d,
      (select count(*) from auth.users where created_at >= now() - interval '30 days') as registrations_30d,
      (select count(*) from public.profiles where is_verified) as verified_users,
      (select count(*) from public.profiles where onboarding_completed) as onboarding_completed,
      (select count(*) from public.profiles where is_mentor) as mentors,
      (select count(*) from public.user_activity_daily where activity_date = v_today) as active_users_today,
      (select count(distinct user_id) from public.user_activity_daily where activity_date >= v_today - 6) as active_users_7d,
      (select count(distinct user_id) from public.user_activity_daily where activity_date >= v_today - 29) as active_users_30d,
      (select coalesce(sum(session_count), 0) from public.user_activity_daily where activity_date = v_today) as sessions_today,
      (select coalesce(sum(page_view_count), 0) from public.user_activity_daily where activity_date = v_today) as page_views_today,
      (select count(*) from public.posts where (created_at at time zone 'Asia/Kolkata')::date = v_today) as forum_messages_today,
      (select count(*) from public.messages where (created_at at time zone 'Asia/Kolkata')::date = v_today) as direct_messages_today,
      (select count(*) from public.posts where created_at >= now() - interval '7 days') as forum_messages_7d,
      (select count(*) from public.messages where created_at >= now() - interval '7 days') as direct_messages_7d,
      (select count(*) from public.posts where created_at >= now() - interval '7 days')
        + (select count(*) from public.messages where created_at >= now() - interval '7 days') as messages_7d,
      (select count(*) from public.posts where created_at >= now() - interval '30 days')
        + (select count(*) from public.messages where created_at >= now() - interval '30 days') as messages_30d,
      (select count(*) from public.posts) + (select count(*) from public.messages) as messages_total,
      (select count(*) from public.connections where status = 'pending') as pending_connections,
      (select count(*) from public.connections where status = 'accepted') as accepted_connections,
      (select count(*) from public.reports) as open_reports,
      (select count(*) from public.document_verifications where status = 'pending') as pending_documents,
      (select count(*) from public.course_verification_requests where status = 'pending') as pending_courses,
      (select count(*) from public.jobs where status = 'published' and (expires_at is null or expires_at > now())) as published_jobs,
      (select count(*) from public.applications where (created_at at time zone 'Asia/Kolkata')::date = v_today) as applications_today,
      (select count(*) from public.applications where created_at >= now() - interval '7 days') as applications_7d,
      (select count(*) from public.events where status = 'published' and start_time >= now()) as upcoming_events,
      (select count(*) from public.rsvps where created_at >= now() - interval '30 days') as rsvps_30d,
      (select count(*) from public.consultations where status = 'pending') as pending_consultations,
      (select count(*) from public.consultations where status = 'completed') as completed_consultations,
      (select coalesce(sum(amount), 0) from public.consultations where status = 'completed') as consultation_revenue
  ),
  day_series as (
    select generate_series(v_today - (v_days - 1), v_today, interval '1 day')::date as day
  ),
  daily as (
    select d.day,
      (select count(*) from auth.users u where (u.created_at at time zone 'Asia/Kolkata')::date = d.day) as registrations,
      (select count(*) from public.user_activity_daily a where a.activity_date = d.day) as active_users,
      (select coalesce(sum(a.session_count), 0) from public.user_activity_daily a where a.activity_date = d.day) as sessions,
      (select count(*) from public.posts p where (p.created_at at time zone 'Asia/Kolkata')::date = d.day) as forum_messages,
      (select count(*) from public.messages m where (m.created_at at time zone 'Asia/Kolkata')::date = d.day) as direct_messages,
      (select count(*) from public.posts p where (p.created_at at time zone 'Asia/Kolkata')::date = d.day)
        + (select count(*) from public.messages m where (m.created_at at time zone 'Asia/Kolkata')::date = d.day) as messages,
      (select count(*) from public.applications a where (a.created_at at time zone 'Asia/Kolkata')::date = d.day) as applications
    from day_series d
  ),
  retention_offsets as (
    select unnest(array[1,2,3,7,14,30])::integer as day_offset
  ),
  retention as (
    select o.day_offset,
      count(u.id) filter (where (u.created_at at time zone 'Asia/Kolkata')::date <= v_today - o.day_offset) as eligible,
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
  ),
  top_iits as (
    select coalesce(nullif(trim(iit_name), ''), 'Not specified') as label, count(*) as value
    from public.profiles
    group by 1
    order by value desc, label
    limit 8
  ),
  member_status as (
    select coalesce(nullif(trim(student_status), ''), 'not specified') as label, count(*) as value
    from public.profiles
    group by 1
    order by value desc, label
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
    ), '[]'::jsonb) from retention),
    'top_iits', (select coalesce(jsonb_agg(to_jsonb(top_iits)), '[]'::jsonb) from top_iits),
    'member_status', (select coalesce(jsonb_agg(to_jsonb(member_status)), '[]'::jsonb) from member_status)
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_analytics(integer) from public;
grant execute on function public.get_admin_analytics(integer) to authenticated;
