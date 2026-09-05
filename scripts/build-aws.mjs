const allowedPublicVariables = new Set(["VITE_API_URL", "VITE_CHAT_REALTIME_PROVIDER", "VITE_DAILY_CALLS_ENABLED"]);
const unexpected = Object.keys(process.env).filter((name) => name.startsWith("VITE_") && !allowedPublicVariables.has(name));
if (unexpected.length) throw new Error(`AWS builds refuse unreviewed public variables: ${unexpected.sort().join(", ")}`);
if (process.env.VITE_API_URL !== "") throw new Error("AWS CloudFront builds require same-origin VITE_API_URL to be explicitly empty");
if (process.env.VITE_CHAT_REALTIME_PROVIDER !== "socketio") throw new Error("AWS builds require Socket.IO until the separate AppSync account is connected");
if (process.env.VITE_DAILY_CALLS_ENABLED !== "true") throw new Error("AWS builds require the reviewed Daily calls flag");
const { build } = await import("vite");
await build({ mode: "production", envDir: false });
