import { describe, expect, it } from "vitest";
import {
  CHAT_MESSAGES_PER_WINDOW,
  CLIENT_ERRORS_PER_WINDOW,
  dataWriteLimitFor,
  globalDataWriteLimit,
  globalTelemetryLimit,
  GLOBAL_DATA_WRITES_PER_WINDOW,
  GLOBAL_TELEMETRY_EVENTS_PER_WINDOW,
  isTelemetryRpc,
  STANDARD_DATA_WRITES_PER_WINDOW,
  telemetryLimitFor,
  TELEMETRY_EVENTS_PER_WINDOW,
} from "../src/security/writeLimits.js";

describe("per-member write limits", () => {
  it("gives chat its own bounded allowance and keeps other mutations tighter", () => {
    expect(dataWriteLimitFor("messages")).toBe(CHAT_MESSAGES_PER_WINDOW);
    expect(dataWriteLimitFor("saved_views")).toBe(STANDARD_DATA_WRITES_PER_WINDOW);
    expect(globalDataWriteLimit()).toBe(GLOBAL_DATA_WRITES_PER_WINDOW);
    expect(dataWriteLimitFor("messages", true)).toBe(10_000);
  });

  it("uses a tight error limit without throttling unrelated RPCs", () => {
    expect(isTelemetryRpc("log_client_error")).toBe(true);
    expect(isTelemetryRpc("get_forum_posts")).toBe(false);
    expect(telemetryLimitFor("log_client_error")).toBe(CLIENT_ERRORS_PER_WINDOW);
    expect(telemetryLimitFor("record_user_activity")).toBe(TELEMETRY_EVENTS_PER_WINDOW);
    expect(globalTelemetryLimit()).toBe(GLOBAL_TELEMETRY_EVENTS_PER_WINDOW);
  });
});
