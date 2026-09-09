export const DATA_WRITE_WINDOW_MS = 15 * 60_000;
export const STANDARD_DATA_WRITES_PER_WINDOW = 120;
export const CHAT_MESSAGES_PER_WINDOW = 300;
export const GLOBAL_DATA_WRITES_PER_WINDOW = 400;
export const CLIENT_ERRORS_PER_WINDOW = 20;
export const TELEMETRY_EVENTS_PER_WINDOW = 120;
export const GLOBAL_TELEMETRY_EVENTS_PER_WINDOW = 200;

export const dataWriteLimitFor = (table: unknown, testMode = false): number =>
  testMode ? 10_000 : table === "messages" ? CHAT_MESSAGES_PER_WINDOW : STANDARD_DATA_WRITES_PER_WINDOW;

export const globalDataWriteLimit = (testMode = false): number =>
  testMode ? 10_000 : GLOBAL_DATA_WRITES_PER_WINDOW;

export const telemetryLimitFor = (name: unknown, testMode = false): number =>
  testMode ? 10_000 : name === "log_client_error" ? CLIENT_ERRORS_PER_WINDOW : TELEMETRY_EVENTS_PER_WINDOW;

export const globalTelemetryLimit = (testMode = false): number =>
  testMode ? 10_000 : GLOBAL_TELEMETRY_EVENTS_PER_WINDOW;

export const isTelemetryRpc = (name: unknown): boolean =>
  typeof name === "string" && new Set(["log_client_error", "record_user_activity", "record_job_engagement"]).has(name);
