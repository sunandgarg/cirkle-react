import { describe, expect, it } from "vitest";
import { resolveConnectionState, type ConnectionRow } from "@/lib/connections";

const connection = (status: string): ConnectionRow => ({
  id: "connection-1",
  requester_id: "member-a",
  receiver_id: "member-b",
  status,
  note: "Same cohort",
});

describe("connection request lifecycle", () => {
  it("distinguishes sent and received requests for the two members", () => {
    expect(resolveConnectionState(connection("pending"), "member-a").kind).toBe("sent");
    expect(resolveConnectionState(connection("pending"), "member-b").kind).toBe("received");
  });

  it("unlocks messaging only for accepted connections", () => {
    expect(resolveConnectionState(connection("accepted"), "member-a").kind).toBe("connected");
    expect(resolveConnectionState(connection("declined"), "member-a").kind).toBe("none");
    expect(resolveConnectionState(connection("withdrawn"), "member-b").kind).toBe("none");
  });
});
