import { validatePagesBuildEnvironment } from "./lib/pages-build-config.mjs";

validatePagesBuildEnvironment(process.env);

const { build } = await import("vite");
// Production Pages builds consume only the allowlisted process variables above.
// Ignored local .env files may contain old endpoints and must never affect dist/.
await build({ mode: "production", envDir: false });
