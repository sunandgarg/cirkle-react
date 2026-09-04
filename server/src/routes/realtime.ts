import { timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError, asyncHandler } from "../lib/errors.js";
import { canSubscribeAppSyncChannel } from "../realtime/appsyncAccess.js";
import { AppSyncFixedWindowRateLimiter } from "../realtime/appsyncRateLimit.js";
import { requireAuth } from "../security/middleware.js";

export const realtimeRouter: Router = Router();

const authorizerLimiter = new AppSyncFixedWindowRateLimiter(60_000, 240);

const secureEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const requireAppSyncAuthorizer: RequestHandler = (req, _res, next) => {
  const supplied = req.get("x-cirkle-appsync-secret") || "";
  if (!config.APPSYNC_ENABLED || !config.APPSYNC_AUTHORIZER_SECRET || !secureEqual(supplied, config.APPSYNC_AUTHORIZER_SECRET)) {
    next(new ApiError(401, "appsync_authorizer_denied", "AppSync authorizer credentials were rejected"));
    return;
  }
  next();
};

const authorizationInput = z.object({
  operation: z.enum(["EVENT_CONNECT", "EVENT_SUBSCRIBE"]),
  channel: z.string().max(300).optional(),
}).strict();

realtimeRouter.post("/appsync/authorize", requireAppSyncAuthorizer, requireAuth, asyncHandler(async (req, res) => {
  const input = authorizationInput.parse(req.body ?? {});
  const rate = authorizerLimiter.take(req.auth!.id);
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSeconds));
    throw new ApiError(429, "appsync_authorizer_rate_limited", "Too many realtime authorization requests");
  }
  const allowed = input.operation === "EVENT_CONNECT"
    ? true
    : Boolean(input.channel && await canSubscribeAppSyncChannel(req.auth!, input.channel));
  res.setHeader("Cache-Control", "no-store");
  res.status(allowed ? 200 : 403).json({ allowed, user_id: allowed ? req.auth!.id : undefined });
}));
