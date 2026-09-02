-- Privacy-conscious first-party job funnel analytics. Events are write-only to
-- the browser; the owner sees only aggregate metrics from the secure RPC.

create table if not exists public.job_engagement_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  event_name text not null,
  session_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint job_engagement_event_name_check check (event_name in (
    'jobs_page_view', 'job_view_click', 'job_easy_apply_click',
    'job_save', 'job_unsave', 'job_filter'
  )),
  constraint job_engagement_session_length check (char_length(session_id) between 8 and 100),
  constraint job_engagement_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists job_engagement_created_idx
  on public.job_engagement_events (created_at desc);
create index if not exists job_engagement_event_created_idx
  on public.job_engagement_events (event_name, created_at desc);
create index if not exists job_engagement_job_created_idx
  on public.job_engagement_events (job_id, created_at desc) where job_id is not null;
create index if not exists job_engagement_user_created_idx
  on public.job_engagement_events (user_id, created_at desc);

alter table public.job_engagement_events enable row level security;
revoke all on table public.job_engagement_events from anon, authenticated;

create or replace function public.record_job_engagement(
  p_event_name text,
  p_job_id uuid default null,
  p_session_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if p_event_name not in (
    'jobs_page_view', 'job_view_click', 'job_easy_apply_click',
    'job_save', 'job_unsave', 'job_filter'
  ) then raise exception 'Unsupported job engagement event'; end if;
  if p_session_id is null or char_length(p_session_id) not between 8 and 100 then
    raise exception 'Invalid job analytics session';
  end if;
  if p_job_id is not null and not exists (select 1 from public.jobs where id = p_job_id) then
    raise exception 'Unknown job';
  end if;
  if (
    select count(*) from public.job_engagement_events
    where user_id = v_user_id and created_at > now() - interval '1 minute'
  ) >= 120 then return; end if;

  insert into public.job_engagement_events (user_id, job_id, event_name, session_id, metadata)
  values (
    v_user_id, p_job_id, p_event_name, left(p_session_id, 100),
    case when jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) = 'object'
      then coalesce(p_metadata, '{}'::jsonb) else '{}'::jsonb end
  );
end;
$$;

revoke all on function public.record_job_engagement(text,uuid,text,jsonb) from public;
grant execute on function public.record_job_engagement(text,uuid,text,jsonb) to authenticated;

create or replace function public.get_admin_job_analytics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 90));
  v_since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 90)));
  v_result jsonb;
begin
  if not public.is_platform_owner() then raise exception 'Platform owner access required'; end if;

  with filtered as (
    select * from public.job_engagement_events where created_at >= v_since
  ),
  summary as (
    select
      count(*) filter (where event_name = 'jobs_page_view') as page_views,
      count(distinct user_id) filter (where event_name = 'jobs_page_view') as unique_visitors,
      count(distinct session_id) filter (where event_name = 'jobs_page_view') as unique_sessions,
      count(*) filter (where event_name = 'job_view_click') as view_job_clicks,
      count(*) filter (where event_name = 'job_easy_apply_click') as easy_apply_clicks,
      count(*) filter (where event_name = 'job_save') as saves,
      count(*) filter (where event_name = 'job_unsave') as unsaves,
      count(*) filter (where event_name = 'job_filter') as filter_uses
    from filtered
  ),
  daily as (
    select (created_at at time zone 'Asia/Kolkata')::date as day,
      count(*) filter (where event_name = 'jobs_page_view') as page_views,
      count(distinct user_id) filter (where event_name = 'jobs_page_view') as unique_visitors,
      count(*) filter (where event_name = 'job_view_click') as view_job_clicks,
      count(*) filter (where event_name = 'job_easy_apply_click') as easy_apply_clicks,
      count(*) filter (where event_name = 'job_save') as saves
    from filtered group by 1 order by 1
  ),
  top_jobs as (
    select j.id, j.title, j.company,
      count(*) filter (where f.event_name = 'job_view_click') as view_job_clicks,
      count(*) filter (where f.event_name = 'job_easy_apply_click') as easy_apply_clicks,
      count(*) filter (where f.event_name = 'job_save') as saves
    from filtered f join public.jobs j on j.id = f.job_id
    group by j.id, j.title, j.company
    order by (count(*) filter (where f.event_name in ('job_view_click', 'job_easy_apply_click'))) desc, saves desc
    limit 10
  ),
  top_companies as (
    select j.company as label, count(*) as value
    from filtered f join public.jobs j on j.id = f.job_id
    where f.event_name in ('job_view_click', 'job_easy_apply_click')
    group by j.company order by value desc, j.company limit 10
  )
  select jsonb_build_object(
    'generated_at', now(), 'days', v_days,
    'summary', (select to_jsonb(summary) from summary),
    'daily', (select coalesce(jsonb_agg(to_jsonb(daily) order by day), '[]'::jsonb) from daily),
    'top_jobs', (select coalesce(jsonb_agg(to_jsonb(top_jobs)), '[]'::jsonb) from top_jobs),
    'top_companies', (select coalesce(jsonb_agg(to_jsonb(top_companies)), '[]'::jsonb) from top_companies)
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.get_admin_job_analytics(integer) from public;
grant execute on function public.get_admin_job_analytics(integer) to authenticated;

