const expectedApiUrl = "https://api-react.cirkle.world";
const apiUrl = process.env.VITE_API_URL?.trim();
const realtimeProvider = process.env.VITE_CHAT_REALTIME_PROVIDER?.trim();
const appSyncHttpEndpoint = process.env.VITE_APPSYNC_HTTP_ENDPOINT?.trim();
const appSyncRealtimeEndpoint = process.env.VITE_APPSYNC_REALTIME_ENDPOINT?.trim();
const dailyCallsEnabled = process.env.VITE_DAILY_CALLS_ENABLED?.trim();
const allowedPublicVariables = new Set([
  "VITE_API_URL",
  "VITE_CHAT_REALTIME_PROVIDER",
  "VITE_APPSYNC_HTTP_ENDPOINT",
  "VITE_APPSYNC_REALTIME_ENDPOINT",
  "VITE_DAILY_CALLS_ENABLED",
]);
const unexpectedPublicVariables = Object.keys(process.env).filter((name) => name.startsWith("VITE_") && !allowedPublicVariables.has(name));

if (unexpectedPublicVariables.length) {
  throw new Error(`Cloudflare Pages builds refuse unreviewed public variables: ${unexpectedPublicVariables.sort().join(", ")}`);
}

if (apiUrl !== expectedApiUrl) {
  throw new Error(`Cloudflare Pages builds require VITE_API_URL=${expectedApiUrl}`);
}
if (realtimeProvider !== "socketio") {
  throw new Error("Cloudflare Pages builds require cost-bounded Socket.IO realtime");
}

if (appSyncHttpEndpoint || appSyncRealtimeEndpoint) {
  throw new Error("Cloudflare Pages builds refuse AppSync endpoints while Socket.IO is selected");
}
if (dailyCallsEnabled !== "true") {
  throw new Error("Cloudflare Pages builds require VITE_DAILY_CALLS_ENABLED=true");
}

const { build } = await import("vite");
// Production Pages builds consume only the allowlisted process variables above.
// Ignored local .env files may contain old endpoints and must never affect dist/.
await build({ mode: "production", envDir: false });
