type ErrorSeverity = "warning" | "error" | "fatal";

export interface ErrorFlowContext {
  flow: string;
  action: string;
  severity?: ErrorSeverity;
  metadata?: Record<string, unknown>;
}

export interface ClientErrorEvent {
  eventId: string;
  flow: string;
  action: string;
  severity: ErrorSeverity;
  message: string;
  code: string | null;
  stack: string | null;
  route: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

type ErrorTransport = (event: ClientErrorEvent) => PromiseLike<{ error?: { message?: string } | null } | void>;
let errorTransport: ErrorTransport | null = null;

export const configureErrorTelemetryTransport = (transport: ErrorTransport) => {
  errorTransport = transport;
};

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|otp|code_verifier/i;
const MAX_TEXT = 4_000;

const clip = (value: unknown, max = MAX_TEXT) => String(value ?? "").slice(0, max);

const sanitizeMetadata = (metadata: Record<string, unknown> = {}) => Object.fromEntries(
  Object.entries(metadata).slice(0, 30).map(([key, value]) => {
    if (SENSITIVE_KEY.test(key)) return [key, "[redacted]"];
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return [key, clip(value, 500)];
    if (Array.isArray(value)) return [key, value.slice(0, 20).map((item) => clip(item, 200))];
    return [key, clip(JSON.stringify(value), 1_000)];
  }),
);

export const buildClientErrorEvent = (error: unknown, context: ErrorFlowContext): ClientErrorEvent => {
  const record = typeof error === "object" && error ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : clip(record.message || error || "Unknown application error");
  const stack = error instanceof Error ? error.stack : record.stack;
  return {
    eventId: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    flow: clip(context.flow, 100) || "unknown",
    action: clip(context.action, 100) || "unknown",
    severity: context.severity || "error",
    message: clip(message),
    code: record.code || record.error_code ? clip(record.code || record.error_code, 100) : null,
    stack: stack ? clip(stack, 8_000) : null,
    route: typeof window !== "undefined" ? clip(`${window.location.pathname}${window.location.search}`, 500) : "server",
    metadata: sanitizeMetadata(context.metadata),
    occurredAt: new Date().toISOString(),
  };
};

export const reportError = (error: unknown, context: ErrorFlowContext) => {
  const event = buildClientErrorEvent(error, context);
  console.error(`[Cirkle:${event.flow}:${event.action}]`, event);

  if (typeof window !== "undefined" && navigator.onLine && errorTransport) {
    void Promise.resolve(errorTransport(event))
      .then((result) => {
        if (!result) return;
        if (result.error && import.meta.env.DEV) console.warn("Error telemetry delivery failed", result.error.message);
      })
      .catch(() => undefined);
  }
  return event.eventId;
};

export const createSupabaseErrorTransport = (rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error?: { message?: string } | null }>) =>
  (event: ClientErrorEvent) => rpc("log_client_error", {
    p_event_id: event.eventId,
    p_flow: event.flow,
    p_action: event.action,
    p_severity: event.severity,
    p_message: event.message,
    p_error_code: event.code,
    p_stack: event.stack,
    p_route: event.route,
    p_metadata: event.metadata,
    p_client_timestamp: event.occurredAt,
  });

let globalTelemetryInstalled = false;

export const installGlobalErrorTelemetry = () => {
  if (globalTelemetryInstalled || typeof window === "undefined") return;
  globalTelemetryInstalled = true;
  window.addEventListener("error", (event) => {
    reportError(event.error || event.message, {
      flow: "browser_runtime",
      action: "window_error",
      severity: "fatal",
      metadata: { filename: event.filename, line: event.lineno, column: event.colno },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason, { flow: "browser_runtime", action: "unhandled_promise", severity: "fatal" });
  });
};
