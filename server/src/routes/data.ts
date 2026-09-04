import { Router } from "express";
import { serializedQuerySchema } from "../data/query.js";
import { asyncHandler } from "../lib/errors.js";
import { requireAuth } from "../security/middleware.js";
import { executeDataQuery } from "../services/data.js";

export const dataRouter: Router = Router();

dataRouter.post("/query", requireAuth, asyncHandler(async (req, res) => {
  const query = serializedQuerySchema.parse(req.body);
  const result = await executeDataQuery(query, { auth: req.auth!, ip: req.ip, userAgent: req.get("user-agent") });
  res.json(result);
}));
