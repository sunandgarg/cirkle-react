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
  it("trusts only Cloudflare edge ranges and overwrites forwarded client identity", () => {
    const cloudflareIpv4 = [
      "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
      "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
      "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
      "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    ];
    const cloudflareIpv6 = [
      "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
      "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
    ];

    for (const range of [...cloudflareIpv4, ...cloudflareIpv6]) {
      assert.match(bootstrap, new RegExp(`set_real_ip_from ${range.replace(/[.:/]/g, "\\$&")};`));
    }
    assert.match(bootstrap, /real_ip_header CF-Connecting-IP;/);
    assert.match(bootstrap, /real_ip_recursive off;/);
    assert.equal((bootstrap.match(/proxy_set_header X-Real-IP \\\$remote_addr;/g) ?? []).length, 4);
    assert.equal((bootstrap.match(/proxy_set_header X-Forwarded-For \\\$remote_addr;/g) ?? []).length, 4);
    assert.doesNotMatch(bootstrap, /proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;/);
  });

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
