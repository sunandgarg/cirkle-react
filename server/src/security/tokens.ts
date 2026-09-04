import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";

interface AccessPayload extends JwtPayload {
  sub: string;
  email: string;
  role: string;
  typ: "access";
}

interface RefreshPayload extends JwtPayload {
  sub: string;
  sid: string;
  family: string;
  typ: "refresh";
}

const common = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE } as const;

export function signAccessToken(input: { id: string; email: string; role: string }): string {
  return jwt.sign(
    { email: input.email, role: input.role, typ: "access" },
    config.JWT_ACCESS_SECRET,
    { ...common, subject: input.id, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, algorithm: "HS256" },
  );
}

export function signRefreshToken(input: { id: string; sessionId: string; familyId: string; issuedAt?: number }): string {
  return jwt.sign(
    { sid: input.sessionId, family: input.familyId, typ: "refresh", ...(input.issuedAt === undefined ? {} : { iat: input.issuedAt }) },
    config.JWT_REFRESH_SECRET,
    {
      ...common,
      subject: input.id,
      jwtid: input.sessionId,
      expiresIn: `${config.REFRESH_TOKEN_TTL_DAYS}d`,
      algorithm: "HS256",
    },
  );
}

function requirePayload(value: string | JwtPayload, type: "access" | "refresh"): JwtPayload {
  if (typeof value === "string" || !value.sub || value.typ !== type) {
    throw new ApiError(401, "invalid_token", "The authentication token is invalid");
  }
  return value;
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return requirePayload(jwt.verify(token, config.JWT_ACCESS_SECRET, { ...common, algorithms: ["HS256"] }), "access") as AccessPayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_token", "The access token is invalid or expired");
  }
}

export function verifyRefreshToken(token: string): RefreshPayload {
  try {
    return requirePayload(jwt.verify(token, config.JWT_REFRESH_SECRET, { ...common, algorithms: ["HS256"] }), "refresh") as RefreshPayload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, "invalid_refresh_token", "The refresh token is invalid or expired");
  }
}
