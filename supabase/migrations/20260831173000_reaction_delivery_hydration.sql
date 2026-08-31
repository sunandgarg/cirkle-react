-- Mark reaction-derived forum updates so the dispatcher can replace the
-- transaction-local aggregate with authoritative post-commit totals.
create or replace function public.enqueue_forum_reaction_realtime()
returns trigger
language plpgsql
security definer
set search_path = public, realtime
as $$
declare
  v_reaction public.reactions;
  v_post public.posts;
  v_record jsonb;
  v_reactions jsonb;
  v_channel text;
  v_topic text;
begin
  v_reaction := case when tg_op = 'DELETE' then old else new end;
  if v_reaction.entity_type <> 'forum_msg' then return null; end if;

  select * into v_post from public.posts where id = v_reaction.entity_id;
  if not found or v_post.scope_type is null or v_post.scope_key is null then return null; end if;

  select coalesce(jsonb_object_agg(summary.emoji, summary.total), '{}'::jsonb)
  into v_reactions
  from (
    select r.emoji, count(*) as total
    from public.reactions r
    where r.entity_type = 'forum_msg' and r.entity_id = v_post.id and r.emoji is not null
    group by r.emoji
  ) summary;

  v_record := to_jsonb(v_post) || jsonb_build_object('reactions', v_reactions);
  if v_post.is_anonymous then v_record := v_record - 'author_id'; end if;

  v_channel := case when v_post.reply_to_id is null
    then public.appsync_scope_channel('forum', v_post.scope_type, v_post.scope_key)
    else '/thread/' || v_post.reply_to_id::text end;
  v_topic := case when v_post.reply_to_id is null
    then 'forum:' || v_post.scope_type || ':' || v_post.scope_key
    else 'forum-thread:' || v_post.reply_to_id::text end;

  insert into public.realtime_channel_registry(channel, scope_type, scope_key)
  values (public.appsync_scope_channel('forum', v_post.scope_type, v_post.scope_key), v_post.scope_type, v_post.scope_key)
  on conflict (scope_type, scope_key) do nothing;

  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  values ('forum_reaction', v_post.id, v_channel, 'UPDATE',
    jsonb_build_object('source', 'forum', 'eventType', 'UPDATE', 'new', v_record));

  perform realtime.send(
    jsonb_build_object('schema', 'public', 'table', 'posts', 'type', 'UPDATE',
      'record', v_record, 'old_record', null),
    'UPDATE', v_topic, true
  );
  return null;
end;
$$;

revoke all on function public.enqueue_forum_reaction_realtime() from public;
