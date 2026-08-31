export type ConnectionRow = {
  id: string;
  requester_id: string;
  receiver_id: string;
  status: string;
  note?: string | null;
};

export type ConnectionState =
  | { kind: "none" }
  | { kind: "sent"; connection: ConnectionRow }
  | { kind: "received"; connection: ConnectionRow }
  | { kind: "connected"; connection: ConnectionRow };

export const resolveConnectionState = (
  connection: ConnectionRow | null | undefined,
  viewerId: string | null | undefined,
): ConnectionState => {
  if (!connection || !viewerId) return { kind: "none" };
  if (connection.status === "accepted") return { kind: "connected", connection };
  if (connection.status !== "pending") return { kind: "none" };
  return connection.requester_id === viewerId
    ? { kind: "sent", connection }
    : { kind: "received", connection };
};

