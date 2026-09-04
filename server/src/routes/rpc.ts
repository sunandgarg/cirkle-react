import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import { requireAuth } from "../security/middleware.js";
import { callRpc } from "../services/rpc.js";

export const rpcRouter: Router = Router();

rpcRouter.post("/:name", requireAuth, asyncHandler(async (req, res) => {
  const { name } = z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/) }).parse(req.params);
  const args = z.record(z.unknown()).parse(req.body ?? {});
  res.json({ data: await callRpc(name, args, { auth: req.auth!, ip: req.ip, userAgent: req.get("user-agent") }) });
}));
