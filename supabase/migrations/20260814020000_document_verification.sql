-- Private document verification workflow with atomic admin review.
create table if not exists public.document_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  iit_name text not null,
  student_status text not null check (student_status in ('current_student', 'alumni')),
  document_type text not null check (document_type in ('student_id', 'admission_letter', 'degree_certificate', 'other')),
  document_path text not null,
  original_filename text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_verifications_status_created_idx
  on public.document_verifications (status, created_at desc);
create index if not exists document_verifications_user_created_idx
  on public.document_verifications (user_id, created_at desc);
create unique index if not exists document_verifications_one_pending_per_user_idx
  on public.document_verifications (user_id) where status = 'pending';

alter table public.document_verifications enable row level security;

drop policy if exists users_create_own_document_verification on public.document_verifications;
create policy users_create_own_document_verification
  on public.document_verifications for insert to authenticated
  with check (auth.uid() = user_id and status = 'pending');

drop policy if exists users_read_own_document_verification on public.document_verifications;
create policy users_read_own_document_verification
  on public.document_verifications for select to authenticated
  using (
    auth.uid() = user_id or exists (
      select 1 from public.user_roles
      where user_id = auth.uid() and role = 'admin'
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verification-documents',
  'verification-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists users_upload_own_verification_documents on storage.objects;
create policy users_upload_own_verification_documents
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'verification-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists users_read_own_verification_documents on storage.objects;
create policy users_read_own_verification_documents
  on storage.objects for select to authenticated
  using (
    bucket_id = 'verification-documents'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.user_roles
        where user_id = auth.uid() and role = 'admin'
      )
    )
  );

drop policy if exists users_delete_own_verification_documents on storage.objects;
create policy users_delete_own_verification_documents
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'verification-documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create or replace function public.review_document_verification(
  p_submission_id uuid,
  p_status text,
  p_notes text default null
)
returns public.document_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_submission public.document_verifications;
begin
  if not exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Admin access required';
  end if;

  if p_status not in ('approved', 'rejected') then
    raise exception 'Review status must be approved or rejected';
  end if;

  if p_status = 'rejected' and nullif(trim(p_notes), '') is null then
    raise exception 'A rejection reason is required';
  end if;

  update public.document_verifications
  set status = p_status,
      review_notes = nullif(trim(p_notes), ''),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      updated_at = now()
  where id = p_submission_id and status = 'pending'
  returning * into v_submission;

  if v_submission.id is null then
    raise exception 'Pending submission not found';
  end if;

  if p_status = 'approved' then
    update public.profiles
    set iit_name = v_submission.iit_name,
        student_status = v_submission.student_status,
        is_verified = true
    where user_id = v_submission.user_id;
  end if;

  return v_submission;
end;
$$;

revoke all on function public.review_document_verification(uuid, text, text) from public;
grant execute on function public.review_document_verification(uuid, text, text) to authenticated;
