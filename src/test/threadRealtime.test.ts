import { describe, expect, it, vi } from "vitest";
import { reconcileThreadSnapshot, resolveThreadAppSyncInvalidation } from "@/lib/threadRealtime";

const parentId = "11111111-1111-4111-8111-111111111111";
const replyId = "22222222-2222-4222-8222-222222222222";

describe("AppSync thread invalidation hydration", () => {
  it("refetches INSERT/UPDATE identities before exposing a reply", async () => {
    const fetchReply = vi.fn(async () => ({
      id: replyId,
      reply_to_id: parentId,
      content: "Authorized complete reply",
      author_id: "member-1",
    }));

    await expect(resolveThreadAppSyncInvalidation({
      table: "posts", eventType: "INSERT", new: { id: replyId },
    }, parentId, fetchReply)).resolves.toEqual({
      eventType: "INSERT",
      row: {
        id: replyId,
        reply_to_id: parentId,
        content: "Authorized complete reply",
        author_id: "member-1",
      },
    });
    expect(fetchReply).toHaveBeenCalledWith(replyId);
  });

  it("uses a DELETE identity without attempting an impossible refetch", async () => {
    const fetchReply = vi.fn();
    await expect(resolveThreadAppSyncInvalidation({
      table: "posts", eventType: "DELETE", old: { id: replyId },
    }, parentId, fetchReply)).resolves.toEqual({ eventType: "DELETE", row: { id: replyId } });
    expect(fetchReply).not.toHaveBeenCalled();
  });

  it("rejects missing, deleted, and cross-thread rows", async () => {
    await expect(resolveThreadAppSyncInvalidation({
      table: "posts", eventType: "UPDATE", new: { id: replyId },
    }, parentId, async () => ({ id: replyId, reply_to_id: "another-thread", content: "private" }))).resolves.toBeNull();
    await expect(resolveThreadAppSyncInvalidation({
      table: "posts", eventType: "INSERT", new: { id: replyId },
    }, parentId, async () => ({ id: replyId, reply_to_id: parentId, deleted_at: new Date().toISOString() }))).resolves.toBeNull();
    await expect(resolveThreadAppSyncInvalidation({
      table: "messages", eventType: "INSERT", new: { id: replyId },
    }, parentId, async () => null)).resolves.toBeNull();
  });
});

describe("thread foreground reconciliation", () => {
  it("applies an older loaded edit and removes replies omitted after a missed delete", () => {
    const authoritative = reconcileThreadSnapshot([
      {
        id: "older-edited",
        reply_to_id: parentId,
        content: "after edit",
        created_at: "2026-09-05T01:00:00.000Z",
      },
      {
        id: "newest",
        reply_to_id: parentId,
        content: "latest",
        created_at: "2026-09-05T03:00:00.000Z",
      },
      // A different thread must never enter this cache during recovery.
      {
        id: "cross-thread",
        reply_to_id: "33333333-3333-4333-8333-333333333333",
        content: "private elsewhere",
        created_at: "2026-09-05T04:00:00.000Z",
      },
    ], parentId);

    // The former `older-deleted` row is absent from the authoritative input,
    // so exact replacement evicts it instead of retaining stale cache state.
    expect(authoritative.map((reply) => reply.id)).toEqual(["newest", "older-edited"]);
    expect(authoritative.find((reply) => reply.id === "older-edited")?.content).toBe("after edit");
    expect(authoritative.some((reply) => reply.id === "older-deleted")).toBe(false);
  });

  it("accepts an authoritative empty thread and excludes tombstones", () => {
    expect(reconcileThreadSnapshot([], parentId)).toEqual([]);
    expect(reconcileThreadSnapshot([{
      id: replyId,
      reply_to_id: parentId,
      deleted_at: "2026-09-05T03:00:00.000Z",
    }], parentId)).toEqual([]);
  });
});
