import { beforeEach, describe, expect, it, vi } from "vitest";

const publisherMocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteRecord: vi.fn(),
  updateRecord: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  config: {
    APPSYNC_ENABLED: true,
    APPSYNC_HTTP_ENDPOINT: "https://hzrd5pmdhvfobbzonf2hffeq5e.appsync-api.ap-south-1.amazonaws.com/event",
    APPSYNC_PUBLISH_TOKEN: "server-publisher-token-that-never-reaches-a-browser",
    APPSYNC_PUBLISH_TIMEOUT_MS: 4_000,
  },
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: {
    error: publisherMocks.loggerError,
    warn: publisherMocks.loggerWarn,
  },
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    legacyRecord: {
      findMany: publisherMocks.findMany,
      delete: publisherMocks.deleteRecord,
      update: publisherMocks.updateRecord,
    },
    $transaction: vi.fn(),
  },
}));

import { dispatchAppSyncOutbox } from "../src/realtime/appsyncPublisher.js";

const privateEvent = {
  schemaVersion: 1,
  eventId: "event-1",
  table: "messages",
  eventType: "INSERT",
  new: {
    id: "11111111-1111-4111-8111-111111111111",
    content: "private message body",
    media_path: "members/private-document.pdf",
  },
  old: {},
  occurredAt: "2026-09-06T00:00:00.000Z",
  providerToken: "must-not-leave-the-server",
};

const outboxRecord = (attempts: number) => ({
  id: "database-row-1",
  record_id: "outbox-record-1",
  created_at: new Date("2026-09-06T00:00:00.000Z"),
  data: {
    channel: "/chat/11111111-1111-4111-8111-111111111111",
    event: privateEvent,
    attempts,
    next_attempt_at: "2020-01-01T00:00:00.000Z",
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
  publisherMocks.findMany.mockReset();
  publisherMocks.deleteRecord.mockReset();
  publisherMocks.updateRecord.mockReset();
  publisherMocks.loggerError.mockReset();
  publisherMocks.loggerWarn.mockReset();
});

describe("AppSync publisher reliability", () => {
  it("publishes an allowlisted content-free envelope and removes the delivered outbox row", async () => {
    publisherMocks.findMany.mockResolvedValueOnce([outboxRecord(0)]);
    publisherMocks.deleteRecord.mockResolvedValue({});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(dispatchAppSyncOutbox()).resolves.toEqual({ delivered: 1, failed: 0 });

    const request = fetchMock.mock.calls[0];
    const options = request[1] as RequestInit;
    const published = JSON.parse(String(options.body));
    const envelope = JSON.parse(published.events[0]);
    expect(published.channel).toBe("/chat/11111111-1111-4111-8111-111111111111");
    expect(envelope).toEqual({
      schemaVersion: 1,
      eventId: "event-1",
      table: "messages",
      eventType: "INSERT",
      new: { id: "11111111-1111-4111-8111-111111111111" },
      old: {},
      occurredAt: "2026-09-06T00:00:00.000Z",
    });
    expect(JSON.stringify(published)).not.toContain("private message body");
    expect(JSON.stringify(published)).not.toContain("private-document.pdf");
    expect(JSON.stringify(published)).not.toContain("must-not-leave-the-server");
    expect(publisherMocks.deleteRecord).toHaveBeenCalledWith({ where: { id: "database-row-1" } });
    expect(publisherMocks.updateRecord).not.toHaveBeenCalled();
  });

  it("retains a failed HTTP publish with bounded retry metadata and sanitized logs", async () => {
    publisherMocks.findMany.mockResolvedValueOnce([outboxRecord(0)]);
    publisherMocks.updateRecord.mockResolvedValue({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream failure", {
      status: 503,
      headers: { "x-amzn-requestid": "aws-request-123" },
    }));

    await expect(dispatchAppSyncOutbox()).resolves.toEqual({ delivered: 0, failed: 1 });

    const update = publisherMocks.updateRecord.mock.calls[0][0];
    expect(update.where).toEqual({ id: "database-row-1" });
    expect(update.data.table_name).toBeUndefined();
    expect(update.data.data).toMatchObject({
      attempts: 1,
      last_error: "AppSync publish failed with 503 (aws-request-123)",
    });
    expect(Date.parse(update.data.data.next_attempt_at)).toBeGreaterThan(Date.now());
    expect(publisherMocks.deleteRecord).not.toHaveBeenCalled();
    const logged = JSON.stringify(publisherMocks.loggerWarn.mock.calls);
    expect(logged).not.toContain("server-publisher-token");
    expect(logged).not.toContain("private message body");
    expect(logged).not.toContain("private-document.pdf");
  });

  it("moves the twelfth failed delivery to dead letter instead of retrying forever", async () => {
    publisherMocks.findMany.mockResolvedValueOnce([outboxRecord(11)]);
    publisherMocks.updateRecord.mockResolvedValue({});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));

    await expect(dispatchAppSyncOutbox()).resolves.toEqual({ delivered: 0, failed: 1 });

    const update = publisherMocks.updateRecord.mock.calls[0][0];
    expect(update.data.table_name).toBe("appsync_realtime_dead_letter");
    expect(update.data.data).toMatchObject({
      attempts: 12,
      last_error: "AppSync publish failed with 503",
    });
    expect(Date.parse(update.data.data.failed_at)).not.toBeNaN();
    expect(publisherMocks.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 12, terminal: true }),
      "AppSync delivery deferred",
    );
  });

  it("never sends a malformed persisted envelope and dead-letters it at the retry limit", async () => {
    const record = outboxRecord(11);
    record.data.event = {
      schemaVersion: 0,
      table: "messages",
      eventType: "INSERT",
      content: "legacy private payload",
    } as typeof privateEvent;
    publisherMocks.findMany.mockResolvedValueOnce([record]);
    publisherMocks.updateRecord.mockResolvedValue({});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(dispatchAppSyncOutbox()).resolves.toEqual({ delivered: 0, failed: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
    const update = publisherMocks.updateRecord.mock.calls[0][0];
    expect(update.data.table_name).toBe("appsync_realtime_dead_letter");
    expect(update.data.data).toMatchObject({
      attempts: 12,
      last_error: "Invalid AppSync event envelope",
    });
  });
});
