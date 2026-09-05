const EXPECTED_API_URL = "https://api-react.cirkle.world";
const ALLOWED_PUBLIC_VARIABLES = new Set([
  "VITE_API_URL",
  "VITE_CHAT_REALTIME_PROVIDER",
  "VITE_APPSYNC_HTTP_ENDPOINT",
  "VITE_APPSYNC_REALTIME_ENDPOINT",
  "VITE_DAILY_CALLS_ENABLED",
]);

export function validatePagesBuildEnvironment(environment) {
  const unexpectedPublicVariables = Object.keys(environment)
    .filter((name) => name.startsWith("VITE_") && !ALLOWED_PUBLIC_VARIABLES.has(name));
  if (unexpectedPublicVariables.length) {
    throw new Error(`Cloudflare Pages builds refuse unreviewed public variables: ${unexpectedPublicVariables.sort().join(", ")}`);
  }

  const apiUrl = environment.VITE_API_URL?.trim();
  if (apiUrl !== EXPECTED_API_URL) {
    throw new Error(`Cloudflare Pages builds require VITE_API_URL=${EXPECTED_API_URL}`);
  }
  if (environment.VITE_CHAT_REALTIME_PROVIDER?.trim() !== "socketio") {
    throw new Error("Cloudflare Pages builds require cost-bounded Socket.IO realtime");
  }
  if (environment.VITE_APPSYNC_HTTP_ENDPOINT?.trim() || environment.VITE_APPSYNC_REALTIME_ENDPOINT?.trim()) {
    throw new Error("Cloudflare Pages builds refuse AppSync endpoints while Socket.IO is selected");
  }

  const dailyCalls = environment.VITE_DAILY_CALLS_ENABLED?.trim();
  if (dailyCalls !== undefined && dailyCalls !== "" && dailyCalls !== "true" && dailyCalls !== "false") {
    throw new Error("VITE_DAILY_CALLS_ENABLED must be true, false, or omitted");
  }

  return {
    apiUrl,
    realtimeProvider: "socketio",
    // Omitted is deliberately equivalent to false. Even true remains gated by
    // GET /api/features, which only enables calls when DAILY_API_KEY exists.
    dailyCallsEnabled: dailyCalls === "true",
  };
}
