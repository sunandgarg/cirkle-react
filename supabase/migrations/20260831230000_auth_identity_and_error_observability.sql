-- Reject orphaned browser sessions before profile writes and persist compact,
-- flow-aware client errors for owner/admin troubleshooting.

create table if not exists public.client_error_logs (
  event_id uuid primary key,
  user_id uuid references auth.users(id) on delete set null,
  flow text not null,
  action text not null,
  severity text not null default 'error',
  message text not null,
  error_code text,
  stack text,
  route text,
  metadata jsonb not null default '{}'::jsonb,
  client_timestamp timestamptz,
  created_at timestamptz not null default now(),
  constraint client_error_logs_severity check (severity in ('warning', 'error', 'fatal')),
  constraint client_error_logs_flow_length check (length(flow) between 1 and 100),
  constraint client_error_logs_action_length check (length(action) between 1 and 100),
  constraint client_error_logs_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists client_error_logs_created_idx
  on public.client_error_logs (created_at desc);
create index if not exists client_error_logs_flow_created_idx
  on public.client_error_logs (flow, created_at desc);
create index if not exists client_error_logs_user_created_idx
  on public.client_error_logs (user_id, created_at desc) where user_id is not null;

alter table public.client_error_logs enable row level security;
revoke all on table public.client_error_logs from anon, authenticated;
grant select on table public.client_error_logs to authenticated;

drop policy if exists admins_read_client_error_logs on public.client_error_logs;
create policy admins_read_client_error_logs
  on public.client_error_logs for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create or replace function public.log_client_error(
  p_event_id uuid,
  p_flow text,
  p_action text,
  p_severity text,
  p_message text,
  p_error_code text default null,
  p_stack text default null,
  p_route text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_client_timestamp timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed_user_id uuid := auth.uid();
  v_user_id uuid;
begin
  if v_claimed_user_id is null then raise exception 'Authentication required'; end if;
  select id into v_user_id from auth.users where id = v_claimed_user_id;

  if (
    select count(*) from public.client_error_logs
    where user_id is not distinct from v_user_id and created_at > now() - interval '1 minute'
  ) >= 30 then
    return p_event_id;
  end if;

  insert into public.client_error_logs (
    event_id, user_id, flow, action, severity, message, error_code,
    stack, route, metadata, client_timestamp
  ) values (
    p_event_id,
    v_user_id,
    left(coalesce(nullif(trim(p_flow), ''), 'unknown'), 100),
    left(coalesce(nullif(trim(p_action), ''), 'unknown'), 100),
    case when p_severity in ('warning', 'error', 'fatal') then p_severity else 'error' end,
    left(coalesce(nullif(p_message, ''), 'Unknown application error'), 4000),
    left(p_error_code, 100),
    left(p_stack, 8000),
    left(p_route, 500),
    case when jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) = 'object' then coalesce(p_metadata, '{}'::jsonb) else '{}'::jsonb end,
    p_client_timestamp
  ) on conflict (event_id) do nothing;

  return p_event_id;
end;
$$;

revoke all on function public.log_client_error(uuid,text,text,text,text,text,text,text,jsonb,timestamptz) from public;
grant execute on function public.log_client_error(uuid,text,text,text,text,text,text,text,jsonb,timestamptz) to authenticated;

create or replace function public.save_account_details(
  p_name text,
  p_phone_country_code text default null,
  p_phone text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_country text := nullif(trim(coalesce(p_phone_country_code, '')), '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'AUTH_ACCOUNT_NOT_FOUND: Your sign-in session no longer belongs to an active account';
  end if;
  if length(v_name) < 2 then raise exception 'A valid full name is required'; end if;
  if length(v_phone) <> 10 then raise exception 'A valid 10-digit phone number is required'; end if;
  if v_country is null or v_country !~ '^\+[0-9]{1,4}$' then raise exception 'Choose a valid country code'; end if;

  insert into public.profiles (
    user_id, name, phone_country_code, phone_number, phone_full
  ) values (
    v_user_id, v_name, v_country, v_phone, v_country || v_phone
  )
  on conflict (user_id) do update set
    name = excluded.name,
    phone_country_code = excluded.phone_country_code,
    phone_number = excluded.phone_number,
    phone_full = excluded.phone_full;
end;
$$;

revoke all on function public.save_account_details(text,text,text) from public;
grant execute on function public.save_account_details(text,text,text) to authenticated;
