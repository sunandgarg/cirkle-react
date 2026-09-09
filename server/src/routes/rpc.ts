import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/errors.js";
import { requireAuth } from "../security/middleware.js";
import { callRpc } from "../services/rpc.js";
import { DATA_WRITE_WINDOW_MS, globalTelemetryLimit, isTelemetryRpc, telemetryLimitFor } from "../security/writeLimits.js";

export const rpcRouter: Router = Router();

const telemetryLimit = rateLimit({
  windowMs: DATA_WRITE_WINDOW_MS,
  limit: (req) => telemetryLimitFor(req.params.name, config.NODE_ENV === "test"),
  keyGenerator: (req) => `member:${req.auth!.id}:telemetry:${req.params.name}`,
  skip: (req) => !isTelemetryRpc(req.params.name),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "telemetry_rate_limited", message: "Telemetry rate limit reached" } },
});

const memberTelemetryLimit = rateLimit({
  windowMs: DATA_WRITE_WINDOW_MS,
  limit: () => globalTelemetryLimit(config.NODE_ENV === "test"),
  keyGenerator: (req) => `member:${req.auth!.id}:all-telemetry`,
  skip: (req) => !isTelemetryRpc(req.params.name),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "telemetry_rate_limited", message: "Telemetry rate limit reached" } },
});

rpcRouter.post("/:name", requireAuth, memberTelemetryLimit, telemetryLimit, asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/) }).parse(req.params);
  const args = z.record(z.unknown()).parse(req.body ?? {});
  res.json({ data: await callRpc(name, args, { auth: req.auth!, ip: req.ip, userAgent: req.get("user-agent") }) });
}));
