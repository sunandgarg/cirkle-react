drop function if exists public.claim_realtime_delivery_batch(integer, uuid);

create function public.claim_realtime_delivery_batch(
  p_limit integer default 100,
  p_worker uuid default gen_random_uuid()
)
returns table(
  id bigint,
  event_id uuid,
  source text,
  aggregate_id uuid,
  channel text,
  payload jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  return query
  with candidates as (
    select o.id
    from public.realtime_delivery_outbox o
    where o.available_at <= now()
      and (o.status in ('pending','failed')
        or (o.status = 'processing' and o.locked_at < now() - interval '2 minutes'))
    order by o.id
    for update skip locked
    limit least(greatest(p_limit, 1), 500)
  ), claimed as (
    update public.realtime_delivery_outbox o
    set status = 'processing', locked_at = now(), locked_by = p_worker,
      attempts = o.attempts + 1
    from candidates c
    where o.id = c.id
    returning o.id, o.event_id, o.source, o.aggregate_id, o.channel, o.payload
  )
  select * from claimed;
end;
$$;

revoke all on function public.claim_realtime_delivery_batch(integer, uuid) from public;
grant execute on function public.claim_realtime_delivery_batch(integer, uuid) to service_role;
