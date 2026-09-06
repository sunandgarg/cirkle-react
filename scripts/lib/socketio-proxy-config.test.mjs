import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "../..");
const bootstrapPath = resolve(root, "aws/hosting/bootstrap-lightsail.sh");
const bootstrap = readFileSync(bootstrapPath, "utf8");
const client = readFileSync(resolve(root, "src/integrations/api/realtime.ts"), "utf8");
const server = readFileSync(resolve(root, "server/src/realtime/socket.ts"), "utf8");

describe("Socket.IO reverse-proxy configuration", () => {
  it("keeps the client, server, and Lightsail proxy on /api/socket.io", () => {
    assert.match(client, /return "\/api\/socket\.io"/);
    assert.match(server, /path:\s*"\/api\/socket\.io"/);

    const socketLocation = bootstrap.match(/location \/api\/socket\.io\/ \{([\s\S]*?)\n  \}/)?.[1];
    assert.ok(socketLocation, "Lightsail must define a dedicated /api/socket.io/ location");
    assert.match(socketLocation, /proxy_http_version 1\.1;/);
    assert.match(socketLocation, /proxy_set_header Upgrade \\\$http_upgrade;/);
    assert.match(socketLocation, /proxy_set_header Connection \\\$connection_upgrade;/);
    assert.match(socketLocation, /proxy_read_timeout 3600s;/);
    assert.match(socketLocation, /proxy_pass http:\/\/127\.0\.0\.1:3001;/);

    assert.ok(
      bootstrap.indexOf("location /api/socket.io/ {") < bootstrap.indexOf("location /api/ {"),
      "the dedicated WebSocket location must precede the generic API proxy",
    );
  });

  it("keeps the Lightsail bootstrap script syntactically valid", () => {
    execFileSync("bash", ["-n", bootstrapPath], { stdio: "pipe" });
  });
});
