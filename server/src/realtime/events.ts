import { EventEmitter } from "node:events";

export interface DbChangeEvent {
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  row: Record<string, unknown>;
  actor_id?: string;
  room?: string;
  audience_ids?: string[];
}

export const realtimeEvents = new EventEmitter();
realtimeEvents.setMaxListeners(20);

export const emitDbChange = (change: DbChangeEvent): void => {
  realtimeEvents.emit("db-change", change);
};
