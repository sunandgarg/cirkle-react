const expectedApiUrl = "https://api.cirkle.world";
const apiUrl = process.env.VITE_API_URL?.trim();
const realtimeProvider = process.env.VITE_CHAT_REALTIME_PROVIDER?.trim();
const dailyCallsEnabled = process.env.VITE_DAILY_CALLS_ENABLED?.trim();
const allowedPublicVariables = new Set(["VITE_API_URL", "VITE_CHAT_REALTIME_PROVIDER", "VITE_DAILY_CALLS_ENABLED"]);
const unexpectedPublicVariables = Object.keys(process.env).filter((name) => name.startsWith("VITE_") && !allowedPublicVariables.has(name));

if (unexpectedPublicVariables.length) {
  throw new Error(`Cloudflare Pages builds refuse unreviewed public variables: ${unexpectedPublicVariables.sort().join(", ")}`);
}

if (apiUrl !== expectedApiUrl) {
  throw new Error(`Cloudflare Pages builds require VITE_API_URL=${expectedApiUrl}`);
}
if (realtimeProvider !== "socketio") {
  throw new Error("Cloudflare Pages builds require VITE_CHAT_REALTIME_PROVIDER=socketio");
}
if (dailyCallsEnabled !== "true") {
  throw new Error("Cloudflare Pages builds require VITE_DAILY_CALLS_ENABLED=true");
}

const { build } = await import("vite");
// Production Pages builds consume only the allowlisted process variables above.
// Ignored local .env files may contain old endpoints and must never affect dist/.
await build({ mode: "production", envDir: false });
