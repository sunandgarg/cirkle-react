const expectedApiUrl = "https://api.cirkle.world";
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
if (realtimeProvider !== "appsync") {
  throw new Error("Cloudflare Pages builds require VITE_CHAT_REALTIME_PROVIDER=appsync");
}

const assertAppSyncEndpoint = (raw, protocol, hostPattern, pathname, variableName) => {
  try {
    const endpoint = new URL(raw);
    if (endpoint.protocol !== protocol || endpoint.username || endpoint.password
      || endpoint.pathname !== pathname || endpoint.search || endpoint.hash
      || !hostPattern.test(endpoint.hostname)) throw new Error("invalid");
  } catch {
    throw new Error(`${variableName} must be the ap-south-1 AWS AppSync Events ${protocol === "wss:" ? "WebSocket" : "HTTP"} endpoint`);
  }
};

assertAppSyncEndpoint(
  appSyncHttpEndpoint,
  "https:",
  /^[a-z0-9-]+\.appsync-api\.ap-south-1\.amazonaws\.com$/i,
  "/event",
  "VITE_APPSYNC_HTTP_ENDPOINT",
);
assertAppSyncEndpoint(
  appSyncRealtimeEndpoint,
  "wss:",
  /^[a-z0-9-]+\.appsync-realtime-api\.ap-south-1\.amazonaws\.com$/i,
  "/event/realtime",
  "VITE_APPSYNC_REALTIME_ENDPOINT",
);
if (new URL(appSyncHttpEndpoint).hostname.split(".")[0] !== new URL(appSyncRealtimeEndpoint).hostname.split(".")[0]) {
  throw new Error("The AppSync HTTP and realtime endpoints must belong to the same Event API");
}
if (dailyCallsEnabled !== "true") {
  throw new Error("Cloudflare Pages builds require VITE_DAILY_CALLS_ENABLED=true");
}

const { build } = await import("vite");
// Production Pages builds consume only the allowlisted process variables above.
// Ignored local .env files may contain old endpoints and must never affect dist/.
await build({ mode: "production", envDir: false });
