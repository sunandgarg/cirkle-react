import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { callRpc } from "../src/services/rpc.js";
import type { RequestContext } from "../src/types.js";

const ctx: RequestContext = {
  auth: { id: "member", email: "member@example.com", role: "member", community_id: "iit-community", is_verified: true },
};

afterEach(() => vi.restoreAllMocks());

describe("telemetry retention", () => {
  it("prunes expired and overflow client errors before storing a bounded event", async () => {
    const create = vi.fn().mockResolvedValue({});
    const deleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const findMany = vi.fn().mockResolvedValue([{ id: "overflow" }]);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      legacyRecord: { create, deleteMany, findMany },
    }));

    await expect(callRpc("log_client_error", {
      p_event_id: "event-id", p_flow: "forum", p_action: "load", p_message: "failed",
      p_metadata: { retry: 1 }, p_client_timestamp: "2026-09-09T10:00:00.000Z",
    }, ctx)).resolves.toBe("event-id");

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 199 }));
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      table_name: "client_error_logs", owner_id: ctx.auth.id, record_id: "event-id",
    }) }));
  });

  it("rejects oversized error metadata without touching the database", async () => {
    const transaction = vi.spyOn(prisma, "$transaction");
    await expect(callRpc("log_client_error", {
      p_event_id: "event-id", p_message: "failed", p_metadata: { padding: "x".repeat(5_000) },
    }, ctx)).rejects.toMatchObject({ status: 400, code: "invalid_metadata" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("rejects oversized client event identities before touching the database", async () => {
    const transaction = vi.spyOn(prisma, "$transaction");
    await expect(callRpc("log_client_error", {
      p_event_id: "x".repeat(101), p_message: "failed",
    }, ctx)).rejects.toMatchObject({ status: 400 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("removes stale activity rows and bounds browser sessions", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findMany = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ id: "session", data: { session_id: "session-123" } })
      .mockResolvedValueOnce({ id: "daily", data: { session_count: 1, page_view_count: 1 } });
    const update = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      legacyRecord: { deleteMany, findMany, findUnique, update, create: vi.fn() },
    }));

    await expect(callRpc("record_user_activity", { p_session_id: "session-123", p_path: "/forum" }, ctx)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 499 }));
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ owner_id: ctx.auth.id }) }));
    expect(update).toHaveBeenCalledTimes(2);
  });
});
