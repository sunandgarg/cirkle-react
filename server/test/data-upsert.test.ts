import { describe, expect, it } from "vitest";
import { conflictIdentity, resolveConflictKeys } from "../src/services/data.js";

describe("ownership-safe upsert identities", () => {
  it("keeps two RSVPs by one member independent", () => {
    const keys = resolveConflictKeys("rsvps", "event_id,user_id", [["event_id", "user_id"]]);
    const first = conflictIdentity({ event_id: "event-one", user_id: "member-one", status: "going" }, keys);
    const second = conflictIdentity({ event_id: "event-two", user_id: "member-one", status: "interested" }, keys);
    expect(first).toEqual({ event_id: "event-one", user_id: "member-one" });
    expect(second).toEqual({ event_id: "event-two", user_id: "member-one" });
    expect(first).not.toEqual(second);
  });

  it("rejects an unsafe conflict target", () => {
    expect(() => resolveConflictKeys("rsvps", "user_id", [["event_id", "user_id"]])).toThrow(/Unsupported upsert conflict key/);
  });
});
