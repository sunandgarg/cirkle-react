-- Run at 00:00 Asia/Kolkata (18:30 UTC) so a graduating cohort changes at
-- the first instant of 1 July in Cirkle's operating timezone.
do $$
declare
  v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname = 'cirkle-promote-graduates'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'cirkle-promote-graduates',
    '30 18 * * *',
    'select public.promote_graduated_students(timezone(''Asia/Kolkata'', now())::date);'
  );
end;
$$;

