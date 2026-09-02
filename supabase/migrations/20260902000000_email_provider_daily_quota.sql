-- Keep third-party transactional-email caps correct across concurrent Edge
-- Function instances. Reservations use India time because Cirkle's provider
-- accounts and operating team use that billing-day boundary.

create table if not exists public.email_provider_daily_usage (
  provider text not null,
  usage_date date not null,
  reserved_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (provider, usage_date),
  constraint email_provider_daily_usage_provider check (provider ~ '^[a-z0-9_-]{2,32}$'),
  constraint email_provider_daily_usage_count check (reserved_count >= 0)
);

alter table public.email_provider_daily_usage enable row level security;
revoke all on table public.email_provider_daily_usage from public, anon, authenticated;
grant select, insert, update on table public.email_provider_daily_usage to service_role;

create or replace function public.reserve_email_provider_daily_quota(
  p_provider text,
  p_daily_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_usage_date date := timezone('Asia/Kolkata', clock_timestamp())::date;
  v_reserved integer;
begin
  if v_provider !~ '^[a-z0-9_-]{2,32}$' then
    raise exception 'Invalid email provider';
  end if;
  if p_daily_limit < 1 or p_daily_limit > 1000000 then
    raise exception 'Invalid daily email limit';
  end if;

  insert into public.email_provider_daily_usage (provider, usage_date, reserved_count)
  values (v_provider, v_usage_date, 1)
  on conflict (provider, usage_date) do update
    set reserved_count = public.email_provider_daily_usage.reserved_count + 1,
        updated_at = now()
    where public.email_provider_daily_usage.reserved_count < p_daily_limit
  returning reserved_count into v_reserved;

  return v_reserved is not null;
end;
$$;

create or replace function public.release_email_provider_daily_quota(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text := lower(trim(coalesce(p_provider, '')));
  v_usage_date date := timezone('Asia/Kolkata', clock_timestamp())::date;
begin
  update public.email_provider_daily_usage
  set reserved_count = greatest(reserved_count - 1, 0),
      updated_at = now()
  where provider = v_provider and usage_date = v_usage_date;
end;
$$;

revoke all on function public.reserve_email_provider_daily_quota(text, integer) from public, anon, authenticated;
revoke all on function public.release_email_provider_daily_quota(text) from public, anon, authenticated;
grant execute on function public.reserve_email_provider_daily_quota(text, integer) to service_role;
grant execute on function public.release_email_provider_daily_quota(text) to service_role;

