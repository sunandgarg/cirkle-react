-- Preserve withdrawn requests as an immutable audit trail and allow a new submission.
alter table public.document_verifications
  drop constraint if exists document_verifications_status_check;

alter table public.document_verifications
  add constraint document_verifications_status_check
  check (status in ('pending', 'approved', 'rejected', 'withdrawn'));

-- Supports the bounded admin query (newest 200) without scanning the table.
create index if not exists document_verifications_created_idx
  on public.document_verifications (created_at desc);

create or replace function public.withdraw_document_verification(p_submission_id uuid)
returns public.document_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission public.document_verifications;
begin
  update public.document_verifications
  set status = 'withdrawn',
      review_notes = null,
      reviewed_by = null,
      reviewed_at = null,
      updated_at = now()
  where id = p_submission_id
    and user_id = auth.uid()
    and status = 'pending'
  returning * into v_submission;

  if v_submission.id is null then
    raise exception 'Pending submission not found';
  end if;

  return v_submission;
end;
$$;

revoke all on function public.withdraw_document_verification(uuid) from public;
grant execute on function public.withdraw_document_verification(uuid) to authenticated;
