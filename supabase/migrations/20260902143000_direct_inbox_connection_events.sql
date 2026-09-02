-- Notify both members' single inbox channel when their connection lifecycle
-- changes, so an accepted connection appears without per-room subscriptions.
create or replace function public.enqueue_connection_appsync_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_row public.connections; v_record jsonb; v_payload jsonb;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  v_record := case when tg_op = 'DELETE'
    then jsonb_build_object('id', old.id, 'requester_id', old.requester_id, 'receiver_id', old.receiver_id)
    else jsonb_build_object('id', new.id, 'requester_id', new.requester_id, 'receiver_id', new.receiver_id, 'status', new.status) end;
  v_payload := jsonb_build_object('source', 'connection', 'eventType', tg_op,
    case when tg_op = 'DELETE' then 'old' else 'new' end, v_record);

  insert into public.realtime_delivery_outbox(source, aggregate_id, channel, event_type, payload)
  select 'chat', v_row.id, '/inbox/' || participant.user_id::text, tg_op, v_payload
  from (values (v_row.requester_id), (v_row.receiver_id)) participant(user_id);
  return null;
end;
$$;

drop trigger if exists enqueue_connection_appsync_event on public.connections;
create trigger enqueue_connection_appsync_event after insert or update or delete on public.connections
for each row execute function public.enqueue_connection_appsync_event();
