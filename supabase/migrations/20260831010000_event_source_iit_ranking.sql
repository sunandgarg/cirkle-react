-- Keep an event's originating institute separate from its viewing audience.
-- This allows all IITians to discover cross-campus events while the frontend
-- can rank and group events by their source institute.
alter table public.events
  add column if not exists source_iit text;

alter table public.event_scan_runs
  add column if not exists source_iit text;

create index if not exists events_published_source_iit_start_idx
  on public.events (source_iit, start_time)
  where status = 'published';

comment on column public.events.source_iit is
  'Institute hosting or originating the event; independent of audience access rules.';

comment on column public.event_scan_runs.source_iit is
  'Institute whose official sources were scanned in this run.';
