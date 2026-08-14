-- Forum attachments and cross-browser voice notes.
-- Public buckets are intentional: forum posts store durable public URLs while
-- write/delete access remains restricted to the authenticated owner's folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'voice-notes',
    'voice-notes',
    true,
    15728640,
    array['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/x-m4a']
  ),
  (
    'forum-files',
    'forum-files',
    true,
    20971520,
    array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'application/zip',
      'application/x-zip-compressed'
    ]
  )
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists users_upload_own_forum_media on storage.objects;
create policy users_upload_own_forum_media
  on storage.objects for insert to authenticated
  with check (
    bucket_id in ('voice-notes', 'forum-files')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists users_update_own_forum_media on storage.objects;
create policy users_update_own_forum_media
  on storage.objects for update to authenticated
  using (
    bucket_id in ('voice-notes', 'forum-files')
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id in ('voice-notes', 'forum-files')
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists users_delete_own_forum_media on storage.objects;
create policy users_delete_own_forum_media
  on storage.objects for delete to authenticated
  using (
    bucket_id in ('voice-notes', 'forum-files')
    and (storage.foldername(name))[1] = auth.uid()::text
  );
