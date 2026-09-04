import { describe, expect, it } from "vitest";
import { accessTokenRemainingMs, bindingMatches, envelopeForChange, topicMatches, type Subscription } from "../src/realtime/socket.js";

const postgres = (channel: string, table: string): Subscription => ({
  channel,
  bindings: [{ type: "postgres_changes", filter: { table, event: "*" } }],
});

describe("realtime topic isolation", () => {
  it("expires established sockets when their access token expires", () => {
    expect(accessTokenRemainingMs(10_000, 9_250)).toBe(750);
    expect(accessTokenRemainingMs(10_000, 10_001)).toBe(0);
  });
  it("does not deliver another member's connection change to a broad binding", () => {
    const subscription = postgres("connections-11111111-1111-4111-8111-111111111111", "connections");
    expect(bindingMatches(subscription, {
      table: "connections", event: "INSERT",
      row: { requester_id: "22222222-2222-4222-8222-222222222222", receiver_id: "33333333-3333-4333-8333-333333333333" },
    })).toBe(false);
    expect(bindingMatches(subscription, {
      table: "connections", event: "UPDATE",
      row: { requester_id: "11111111-1111-4111-8111-111111111111", receiver_id: "33333333-3333-4333-8333-333333333333" },
    })).toBe(true);
  });

  it("uses derived room audiences for direct-message sidebar changes", () => {
    const channel = "direct-message-sidebar-11111111-1111-4111-8111-111111111111";
    const change = { table: "messages", event: "INSERT" as const, row: { room_id: "private-room" }, audience_ids: ["11111111-1111-4111-8111-111111111111"] };
    expect(topicMatches(channel, change)).toBe(true);
    expect(topicMatches("direct-message-sidebar-22222222-2222-4222-8222-222222222222", change)).toBe(false);
  });

  it("keeps forum changes inside their exact scope", () => {
    const change = { table: "posts", event: "INSERT" as const, row: { scope_type: "IIT", scope_key: "IIT_DELHI" } };
    expect(bindingMatches(postgres("forum:IIT:IIT_DELHI", "posts"), change)).toBe(true);
    expect(bindingMatches(postgres("forum:IIT:IIT_BOMBAY", "posts"), change)).toBe(false);
  });

  it("uses the matching database envelope on a mixed typing and message channel", () => {
    const subscription: Subscription = {
      channel: "room-room-id",
      bindings: [
        { type: "broadcast", filter: { event: "typing" } },
        { type: "postgres_changes", filter: { table: "messages", event: "*" } },
      ],
    };
    const envelope = envelopeForChange(subscription, {
      table: "messages", event: "INSERT", row: { room_id: "room-id", id: "message-id" },
    });
    expect(envelope).toMatchObject({ type: "postgres_changes", event: "INSERT", payload: { table: "messages", eventType: "INSERT" } });
  });
});
