import { describe, expect, it, vi } from "vitest";
import {
  assertBoundedJson,
  assertLegacyMutationInput,
  assertLegacyOwnerQuota,
  MAX_LEGACY_MUTATION_ROWS,
  MAX_LEGACY_OWNER_BYTES,
} from "../src/security/legacyWriteGuard.js";

describe("legacy write guard", () => {
  it("accepts a small, typed saved view", () => {
    expect(() => assertLegacyMutationInput("saved_views", "insert", {
      name: "Unread posts", scope_type: "GLOBAL", scope_key: "IIT_ALL",
      filters_json: { unread: true }, pinned: false,
    }, false)).not.toThrow();
  });

  it("accepts the production direct-message payload while rejecting extra fields", () => {
    expect(() => assertLegacyMutationInput("messages", "insert", {
      room_id: "room-id", sender_id: "member", client_id: "client-id", content: "Hello",
      reply_to_message_id: null, message_type: "text", media_url: null, media_path: null,
      media_bucket: "chat-media", voice_duration: null, status: "sent", read_by: ["member"],
    }, false)).not.toThrow();
    expect(() => assertLegacyMutationInput("messages", "insert", {
      room_id: "room-id", content: "Hello", arbitrary_payload: { padding: "x" },
    }, false)).toThrowError(/Invalid messages record/);
  });

  it("rejects unknown fields and near-megabyte padding", () => {
    expect(() => assertLegacyMutationInput("saved_views", "insert", {
      name: "Unsafe", scope_type: "GLOBAL", scope_key: "IIT_ALL", providerToken: "secret",
    }, false)).toThrowError(/Invalid saved_views record/);
    expect(() => assertLegacyMutationInput("saved_views", "insert", {
      name: "Huge", scope_type: "GLOBAL", scope_key: "IIT_ALL", filters_json: { padding: "x".repeat(900_000) },
    }, false)).toThrowError(/record is too large/);
  });

  it("rejects unapproved direct-write tables and oversized batches", () => {
    expect(() => assertLegacyMutationInput("pinned_messages", "insert", { id: "row" }, false)).toThrowError(/does not support direct member writes/);
    expect(() => assertLegacyMutationInput("saved_views", "insert", Array.from({ length: MAX_LEGACY_MUTATION_ROWS + 1 }, () => ({
      name: "view", scope_type: "GLOBAL", scope_key: "IIT_ALL",
    })), false)).toThrowError(/at most/);
    expect(() => assertLegacyMutationInput("call_sessions", "insert", { ended_at: null }, false))
      .toThrowError(/authorized call workflow/);
    expect(() => assertLegacyMutationInput("notifications", "insert", { is_read: false }, false))
      .toThrowError(/authorized server workflow/);
    expect(() => assertLegacyMutationInput("notifications", "update", { is_read: true }, false)).not.toThrow();
  });

  it("bounds telemetry metadata depth, arrays, strings, and bytes", () => {
    expect(assertBoundedJson({ route: "/forum", retry: 1 })).toEqual({ route: "/forum", retry: 1 });
    expect(() => assertBoundedJson({ padding: "x".repeat(5_000) })).toThrowError(/bounded JSON/);
    expect(() => assertBoundedJson({ values: Array.from({ length: 51 }, () => 1) })).toThrowError(/bounded JSON/);
  });

  it("enforces per-table row and total owner storage quotas", async () => {
    const rowLimited = {
      legacyRecord: { count: vi.fn().mockResolvedValue(100) },
      $queryRaw: vi.fn().mockResolvedValue([{ bytes_used: 1_000 }]),
    };
    await expect(assertLegacyOwnerQuota(rowLimited, "saved_views", "member", 100, 1))
      .rejects.toMatchObject({ status: 429, code: "record_quota_exceeded" });

    const storageLimited = {
      legacyRecord: { count: vi.fn().mockResolvedValue(1) },
      $queryRaw: vi.fn().mockResolvedValue([{ bytes_used: MAX_LEGACY_OWNER_BYTES }]),
    };
    await expect(assertLegacyOwnerQuota(storageLimited, "saved_views", "member", 1, 0))
      .rejects.toMatchObject({ status: 413, code: "storage_quota_exceeded" });
  });

  it("keeps chat sends fast by enforcing their row cap without an owner-wide JSON scan", async () => {
    const client = {
      legacyRecord: { count: vi.fn().mockResolvedValue(4) },
      $queryRaw: vi.fn(),
    };
    await expect(assertLegacyOwnerQuota(client, "messages", "member", 1_000, 1)).resolves.toBeUndefined();
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });
});
