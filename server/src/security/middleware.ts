import type { RequestHandler } from "express";
import { prisma } from "../lib/prisma.js";
import { ApiError, asyncHandler } from "../lib/errors.js";
import { verifyAccessToken } from "./tokens.js";
import type { Role } from "../types.js";

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

export const optionalAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) return next();
  const payload = verifyAccessToken(token);
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { profile: { select: { community_id: true, is_verified: true } } },
  });
  if (!user || user.status !== "active") throw new ApiError(401, "account_unavailable", "This account is unavailable");
  req.auth = {
    id: user.id,
    email: user.email,
    role: user.role as Role,
    community_id: user.profile?.community_id ?? "iit-community",
    is_verified: user.profile?.is_verified ?? false,
  };
  next();
});

const requireAuthGuard: RequestHandler = (req, _res, next) => req.auth
  ? next()
  : next(new ApiError(401, "authentication_required", "Authentication is required"));

export const requireAuth: RequestHandler[] = [optionalAuth, requireAuthGuard];

const requireVerifiedGuard: RequestHandler = (req, _res, next) => req.auth?.is_verified || req.auth?.role === "admin" || req.auth?.role === "owner"
  ? next()
  : next(new ApiError(403, "verification_required", "A verified community membership is required"));

export const requireVerified: RequestHandler[] = [optionalAuth, requireAuthGuard, requireVerifiedGuard];

const requireAdminGuard: RequestHandler = (req, _res, next) => req.auth?.role === "admin" || req.auth?.role === "owner"
  ? next()
  : next(new ApiError(403, "admin_required", "Administrator access is required"));

export const requireAdmin: RequestHandler[] = [optionalAuth, requireAuthGuard, requireAdminGuard];

const requireOwnerGuard: RequestHandler = (req, _res, next) => req.auth?.role === "owner"
  ? next()
  : next(new ApiError(403, "owner_required", "Platform owner access is required"));

export const requireOwner: RequestHandler[] = [optionalAuth, requireAuthGuard, requireOwnerGuard];
