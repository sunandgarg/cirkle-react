import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import { optionalAuth } from "../security/middleware.js";
import { invokeFunction } from "../services/functions.js";
import { deliverSession } from "./auth.js";

export const functionsRouter: Router = Router();

functionsRouter.all("/:name", optionalAuth, asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().regex(/^[a-z][a-z0-9-]*$/) }).parse(req.params);
  const body = z.record(z.unknown()).parse(req.method === "GET" ? req.query : req.body ?? {});
  const result = await invokeFunction(name, body, req.auth ? { auth: req.auth, ip: req.ip, userAgent: req.get("user-agent") } : undefined, { ip: req.ip, userAgent: req.get("user-agent") });
  if (result.session) {
    deliverSession(res, result.session, true);
    return;
  }
  res.json({ data: result.payload });
}));
