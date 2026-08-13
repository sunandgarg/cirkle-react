-- Public IIT logo storage with admin-only writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'institute-logos',
  'institute-logos',
  true,
  2097152,
  array['image/webp', 'image/png', 'image/jpeg', 'image/svg+xml']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'admins_manage_institute_logos'
  ) then
    create policy admins_manage_institute_logos
      on storage.objects
      for all
      to authenticated
      using (
        bucket_id = 'institute-logos'
        and exists (
          select 1 from public.user_roles
          where user_id = auth.uid() and role = 'admin'
        )
      )
      with check (
        bucket_id = 'institute-logos'
        and exists (
          select 1 from public.user_roles
          where user_id = auth.uid() and role = 'admin'
        )
      );
  end if;
end $$;
