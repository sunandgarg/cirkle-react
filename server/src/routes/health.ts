import { Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { asyncHandler } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { probeObjectStore } from "../services/objectStore.js";

export const healthRouter: Router = Router();

export const healthPayload = (uptimeSeconds = process.uptime()) => ({ status: "ok" as const, service: "cirkle-api", uptime_seconds: Math.floor(uptimeSeconds) });

export async function probeStorageRoot(rootValue = config.STORAGE_ROOT): Promise<void> {
  if (config.STORAGE_DRIVER === "s3" && rootValue === config.STORAGE_ROOT) return probeObjectStore();
  const root = path.resolve(rootValue);
  await mkdir(root, { recursive: true, mode: 0o750 });
  const probePath = path.join(root, `.cirkle-readiness-${randomUUID()}`);
  const expected = randomUUID();
  let created = false;
  try {
    await writeFile(probePath, expected, { flag: "wx", mode: 0o600 });
    created = true;
    if (await readFile(probePath, "utf8") !== expected) throw new Error("Storage readiness probe returned unexpected content");
  } finally {
    if (created) await unlink(probePath);
  }
}

healthRouter.get("/healthz", (_req, res) => res.json(healthPayload()));
healthRouter.get("/readyz", asyncHandler(async (_req, res) => {
  await Promise.all([prisma.$queryRaw`SELECT 1`, probeStorageRoot()]);
  res.json({ status: "ready", database: "ok", storage: "ok" });
}));
