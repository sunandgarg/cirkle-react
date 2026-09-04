import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { healthPayload, healthRouter, probeStorageRoot } from "../src/routes/health.js";

describe("health endpoint", () => {
  it("reports the API process as alive with stable fields", () => {
    expect(healthPayload(12.9)).toEqual({ status: "ok", service: "cirkle-api", uptime_seconds: 12 });
  });

  it("proves the storage root supports create, read, and cleanup", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "cirkle-health-"));
    const root = path.join(parent, "uploads");
    try {
      await probeStorageRoot(root);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects a storage root that is an existing file", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "cirkle-health-"));
    const root = path.join(parent, "not-a-directory");
    try {
      await writeFile(root, "occupied");
      await expect(probeStorageRoot(root)).rejects.toThrow();
      expect(await readFile(root, "utf8")).toBe("occupied");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not expose the expensive readiness probe under the public API prefix", async () => {
    const appStack = (createApp() as unknown as { router: { stack: Array<{ handle: unknown; slash?: boolean }> } }).router.stack;
    const healthMount = appStack.find((layer) => layer.handle === healthRouter);
    const healthPaths = (healthRouter as unknown as { stack: Array<{ route?: { path?: string } }> }).stack.flatMap((layer) => layer.route?.path ?? []);
    expect(healthMount?.slash).toBe(true);
    expect(healthPaths).toContain("/readyz");
    expect(healthPaths).not.toContain("/api/readyz");
  });
});
