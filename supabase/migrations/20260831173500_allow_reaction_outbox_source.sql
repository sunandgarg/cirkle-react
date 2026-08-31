alter table public.realtime_delivery_outbox
  drop constraint if exists realtime_delivery_outbox_source_check;

alter table public.realtime_delivery_outbox
  add constraint realtime_delivery_outbox_source_check
  check (source in ('forum', 'forum_reaction', 'chat'));
