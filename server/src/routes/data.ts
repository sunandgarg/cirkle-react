import { Router } from "express";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { serializedQuerySchema } from "../data/query.js";
import { asyncHandler } from "../lib/errors.js";
import { requireAuth } from "../security/middleware.js";
import { executeDataQuery } from "../services/data.js";
import { DATA_WRITE_WINDOW_MS, dataWriteLimitFor, globalDataWriteLimit } from "../security/writeLimits.js";

export const dataRouter: Router = Router();

const mutationLimit = rateLimit({
  windowMs: DATA_WRITE_WINDOW_MS,
  limit: (req) => dataWriteLimitFor(req.body?.table, config.NODE_ENV === "test"),
  keyGenerator: (req) => `member:${req.auth!.id}:${String(req.body?.table ?? "unknown")}`,
  skip: (req) => req.body?.operation === "select",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "write_rate_limited", message: "Too many changes. Please wait before trying again." } },
});

const memberMutationLimit = rateLimit({
  windowMs: DATA_WRITE_WINDOW_MS,
  limit: () => globalDataWriteLimit(config.NODE_ENV === "test"),
  keyGenerator: (req) => `member:${req.auth!.id}:all-data-writes`,
  skip: (req) => req.body?.operation === "select",
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "write_rate_limited", message: "Too many changes. Please wait before trying again." } },
});

dataRouter.post("/query", requireAuth, memberMutationLimit, mutationLimit, asyncHandler(async (req, res) => {
  const query = serializedQuerySchema.parse(req.body);
  const result = await executeDataQuery(query, { auth: req.auth!, ip: req.ip, userAgent: req.get("user-agent") });
  res.json(result);
}));
