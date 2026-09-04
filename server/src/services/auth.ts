import { OAuth2Client } from "google-auth-library";
import type { RefreshSession, User } from "@prisma/client";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import {
  hashOtp,
  hashPassword,
  constantTimeEquals,
  keyedHash,
  newId,
  randomOtp,
  randomToken,
  sha256,
  verifyOtpHash,
  verifyPassword,
} from "../security/crypto.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../security/tokens.js";
import { sendLoginCode, sendPasswordReset } from "./mail.js";
import { writeAudit } from "./audit.js";

export interface SessionMeta { ip?: string; userAgent?: string }

export interface SessionResult {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  token_type: "bearer";
  user: ReturnType<typeof publicUser>;
}

type RefreshSessionWithUser = RefreshSession & { user: User };

export const REFRESH_ROTATION_GRACE_MS = 10_000;

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();

export function publicUser(user: Pick<User, "id" | "email" | "phone" | "role" | "status" | "email_verified_at" | "phone_verified_at" | "created_at" | "updated_at">) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    email_verified_at: user.email_verified_at,
    phone_verified_at: user.phone_verified_at,
    created_at: user.created_at,
    updated_at: user.updated_at,
    app_metadata: { role: user.role },
    user_metadata: { ...(user.phone ? { phone: user.phone } : {}) },
  };
}

function refreshSessionMaterial(user: User, meta: SessionMeta, familyId: string, parentId?: string) {
  const id = newId();
  const issuedAt = Math.floor(Date.now() / 1000);
  const createdAt = new Date(issuedAt * 1000);
  const refreshToken = signRefreshToken({ id: user.id, sessionId: id, familyId, issuedAt });
  const expiresAt = new Date(createdAt.getTime() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  return {
    id,
    refreshToken,
    data: {
      id,
      user_id: user.id,
      family_id: familyId,
      token_hash: sha256(refreshToken),
      parent_id: parentId,
      user_agent: meta.userAgent?.slice(0, 512),
      ip_hash: meta.ip ? keyedHash(meta.ip) : undefined,
      expires_at: expiresAt,
      created_at: createdAt,
    },
  };
}

function sessionResult(user: User, refreshToken: string): SessionResult {
  return {
    access_token: signAccessToken(user),
    refresh_token: refreshToken,
    expires_in: config.ACCESS_TOKEN_TTL_SECONDS,
    token_type: "bearer",
    user: publicUser(user),
  };
}

export async function createSession(user: User, meta: SessionMeta, familyId = newId(), parentId?: string): Promise<SessionResult> {
  const material = refreshSessionMaterial(user, meta, familyId, parentId);
  await prisma.refreshSession.create({
    data: material.data,
  });
  return sessionResult(user, material.refreshToken);
}

export async function registerWithPassword(emailValue: string, password: string, name: string | undefined, meta: SessionMeta): Promise<{ debug_code?: string }> {
  const email = normalizeEmail(emailValue);
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing?.email_verified_at) throw new ApiError(409, "email_in_use", "An account already exists for this email");
  const password_hash = await hashPassword(password);
  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data: { password_hash } })
    : await prisma.user.create({ data: { email, password_hash, status: "pending", profile: { create: { name, community_id: config.DEFAULT_COMMUNITY_ID } } } });
  if (existing && name) {
    await prisma.profile.upsert({ where: { user_id: user.id }, create: { user_id: user.id, name }, update: { name } });
  }
  return issueEmailOtp(email, "registration", meta);
}

export async function passwordLogin(emailValue: string, password: string, meta: SessionMeta): Promise<SessionResult> {
  const email = normalizeEmail(emailValue);
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = user?.password_hash ? await verifyPassword(password, user.password_hash) : false;
  if (!user || !valid) throw new ApiError(401, "invalid_credentials", "Email or password is incorrect");
  if (user.status !== "active" || !user.email_verified_at) throw new ApiError(403, "email_verification_required", "Verify your email before signing in");
  const updated = await prisma.user.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
  await writeAudit({ actor_id: user.id, action: "auth.password_login", resource_type: "user", resource_id: user.id, ip: meta.ip });
  return createSession(updated, meta);
}

export async function issueEmailOtp(emailValue: string, purpose: "login" | "registration" | "institute", meta: SessionMeta): Promise<{ debug_code?: string }> {
  const email = normalizeEmail(emailValue);
  const destination_hash = keyedHash(email);
  const ip_hash = meta.ip ? keyedHash(meta.ip) : undefined;
  const since = new Date(Date.now() - 15 * 60_000);
  const [emailCount, ipCount] = await Promise.all([
    prisma.emailOtp.count({ where: { destination_hash, purpose, created_at: { gte: since } } }),
    ip_hash ? prisma.emailOtp.count({ where: { ip_hash, created_at: { gte: since } } }) : Promise.resolve(0),
  ]);
  if (emailCount >= 5 || ipCount >= 20) throw new ApiError(429, "otp_rate_limited", "Too many code requests. Try again later");

  const code = randomOtp();
  const user = await prisma.user.findUnique({ where: { email } });
  await prisma.emailOtp.create({
    data: {
      user_id: user?.id,
      email,
      destination_hash,
      code_hash: await hashOtp(code),
      purpose,
      expires_at: new Date(Date.now() + 10 * 60_000),
      ip_hash,
    },
  });
  await sendLoginCode(email, code);
  return config.NODE_ENV === "production" ? {} : { debug_code: code };
}

export async function verifyEmailOtp(emailValue: string, code: string, purpose: "login" | "registration", meta: SessionMeta): Promise<SessionResult> {
  const email = normalizeEmail(emailValue);
  const challenge = await prisma.emailOtp.findFirst({
    where: { destination_hash: keyedHash(email), purpose, consumed_at: null },
    orderBy: { created_at: "desc" },
  });
  if (!challenge || challenge.expires_at <= new Date() || challenge.attempts >= challenge.max_attempts) {
    throw new ApiError(400, "invalid_otp", "The code is invalid or expired");
  }

  await prisma.emailOtp.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
  if (!(await verifyOtpHash(code, challenge.code_hash))) throw new ApiError(400, "invalid_otp", "The code is invalid or expired");

  const user = await prisma.$transaction(async (tx) => {
    const current = await tx.user.findUnique({ where: { email } });
    const verified = current
      ? await tx.user.update({ where: { id: current.id }, data: { email_verified_at: new Date(), status: "active", last_login_at: new Date() } })
      : await tx.user.create({ data: { email, email_verified_at: new Date(), status: "active", last_login_at: new Date(), profile: { create: { community_id: config.DEFAULT_COMMUNITY_ID } } } });
    await tx.emailOtp.update({ where: { id: challenge.id }, data: { consumed_at: new Date(), user_id: verified.id } });
    return verified;
  });
  await writeAudit({ actor_id: user.id, action: "auth.otp_login", resource_type: "user", resource_id: user.id, ip: meta.ip });
  return createSession(user, meta);
}

function refreshSessionMatchesToken(session: RefreshSession, payload: ReturnType<typeof verifyRefreshToken>): boolean {
  return session.id === payload.sid && session.user_id === payload.sub && session.family_id === payload.family;
}

function reconstructedRefreshToken(session: RefreshSession): string | null {
  const issuedAt = Math.floor(session.created_at.getTime() / 1000);
  const token = signRefreshToken({ id: session.user_id, sessionId: session.id, familyId: session.family_id, issuedAt });
  return constantTimeEquals(sha256(token), session.token_hash) ? token : null;
}

function refreshSessionMetaMatches(session: RefreshSession, meta: SessionMeta): boolean {
  const userAgent = meta.userAgent?.slice(0, 512);
  if (!session.user_agent || !userAgent || session.user_agent !== userAgent) return false;
  if (!session.ip_hash || !meta.ip) return false;
  return constantTimeEquals(session.ip_hash, keyedHash(meta.ip));
}

async function concurrentRotationResult(session: RefreshSessionWithUser, meta: SessionMeta, now: Date): Promise<SessionResult | null> {
  let current = session;
  for (let depth = 0; depth < 5; depth += 1) {
    if (
      current.revoke_reason !== "rotated"
      || !current.revoked_at
      || !current.replaced_by_id
      || now.getTime() - current.revoked_at.getTime() > REFRESH_ROTATION_GRACE_MS
      || !refreshSessionMetaMatches(current, meta)
    ) return null;

    const successor = await prisma.refreshSession.findUnique({ where: { id: current.replaced_by_id }, include: { user: true } });
    if (
      !successor
      || successor.parent_id !== current.id
      || successor.family_id !== current.family_id
      || successor.user_id !== current.user_id
      || successor.expires_at <= now
      || successor.user.status !== "active"
    ) return null;

    const token = reconstructedRefreshToken(successor);
    if (!token) return null;
    if (!successor.revoked_at) return sessionResult(successor.user, token);
    current = successor;
  }
  return null;
}

async function rejectRefreshReuse(session: RefreshSession): Promise<never> {
  await prisma.refreshSession.updateMany({
    where: { family_id: session.family_id, revoked_at: null },
    data: { revoked_at: new Date(), revoke_reason: "refresh_token_reuse" },
  });
  throw new ApiError(401, "refresh_token_reused", "This session was revoked because a refresh token was reused");
}

export async function rotateRefreshToken(token: string, meta: SessionMeta): Promise<SessionResult> {
  const payload = verifyRefreshToken(token);
  const session = await prisma.refreshSession.findUnique({ where: { token_hash: sha256(token) }, include: { user: true } });
  if (!session || !refreshSessionMatchesToken(session, payload)) {
    throw new ApiError(401, "invalid_refresh_token", "The refresh token is invalid");
  }

  const now = new Date();
  if (session.expires_at <= now || session.user.status !== "active") {
    throw new ApiError(401, "session_expired", "The session has expired");
  }
  if (session.revoked_at) {
    const concurrent = await concurrentRotationResult(session, meta, now);
    if (concurrent) return concurrent;
    return rejectRefreshReuse(session);
  }

  const next = refreshSessionMaterial(session.user, meta, session.family_id, session.id);
  const rotated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshSession.updateMany({
      where: { id: session.id, revoked_at: null, expires_at: { gt: now } },
      data: { revoked_at: now, revoke_reason: "rotated", last_used_at: now },
    });
    if (claimed.count !== 1) return false;
    await tx.refreshSession.create({ data: next.data });
    await tx.refreshSession.update({ where: { id: session.id }, data: { replaced_by_id: next.id } });
    return true;
  });
  if (rotated) return sessionResult(session.user, next.refreshToken);

  const current = await prisma.refreshSession.findUnique({ where: { id: session.id }, include: { user: true } });
  if (current) {
    const concurrent = await concurrentRotationResult(current, meta, new Date());
    if (concurrent) return concurrent;
  }
  return rejectRefreshReuse(session);
}

export async function revokeRefreshToken(token: string | undefined, userId?: string): Promise<void> {
  if (!token) return;
  const hash = sha256(token);
  const session = await prisma.refreshSession.findUnique({ where: { token_hash: hash } });
  if (!session || (userId && session.user_id !== userId)) return;
  await prisma.refreshSession.updateMany({ where: { family_id: session.family_id, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: "logout" } });
}

export async function requestPasswordReset(emailValue: string): Promise<{ debug_token?: string }> {
  const email = normalizeEmail(emailValue);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== "active") return {};

  const recent = await prisma.passwordReset.count({ where: { user_id: user.id, created_at: { gte: new Date(Date.now() - 15 * 60_000) } } });
  if (recent >= 3) return {};
  const token = randomToken();
  await prisma.passwordReset.create({ data: { user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + 30 * 60_000) } });
  const resetUrl = new URL("/reset-password", config.FRONTEND_URL);
  resetUrl.searchParams.set("token", token);
  await sendPasswordReset(email, resetUrl.toString());
  return config.NODE_ENV === "production" ? {} : { debug_token: token };
}

export async function completePasswordReset(token: string, password: string): Promise<void> {
  const reset = await prisma.passwordReset.findUnique({ where: { token_hash: sha256(token) } });
  if (!reset || reset.used_at || reset.expires_at <= new Date()) throw new ApiError(400, "invalid_reset_token", "The reset link is invalid or expired");
  const password_hash = await hashPassword(password);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordReset.updateMany({
      where: { id: reset.id, used_at: null, expires_at: { gt: now } },
      data: { used_at: now },
    });
    if (claimed.count !== 1) throw new ApiError(400, "invalid_reset_token", "The reset link is invalid or expired");
    await tx.user.update({ where: { id: reset.user_id }, data: { password_hash, status: "active" } });
    await tx.refreshSession.updateMany({
      where: { user_id: reset.user_id, revoked_at: null },
      data: { revoked_at: now, revoke_reason: "password_reset" },
    });
  });
}

export async function exchangePasswordReset(token: string, meta: SessionMeta): Promise<SessionResult> {
  const reset = await prisma.passwordReset.findUnique({ where: { token_hash: sha256(token) }, include: { user: true } });
  if (!reset || reset.used_at || reset.expires_at <= new Date() || reset.user.status !== "active") {
    throw new ApiError(400, "invalid_reset_token", "The reset link is invalid or expired");
  }
  const claimed = await prisma.passwordReset.updateMany({ where: { id: reset.id, used_at: null, expires_at: { gt: new Date() } }, data: { used_at: new Date() } });
  if (claimed.count !== 1) throw new ApiError(400, "invalid_reset_token", "The reset link is invalid or expired");
  return createSession(reset.user, meta);
}

export async function updateAuthenticatedPassword(userId: string, password: string): Promise<void> {
  const password_hash = await hashPassword(password);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { password_hash } }),
    prisma.refreshSession.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date(), revoke_reason: "password_changed" } }),
  ]);
}

export const GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS = 20_000;

export function googleOAuthTransportOptions(signal: AbortSignal) {
  return {
    timeout: GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS,
    signal,
    retry: false,
    retryConfig: { retry: 0, noResponseRetries: 0 },
  } as const;
}

function googleClient(signal?: AbortSignal): OAuth2Client {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
    throw new ApiError(503, "google_auth_not_configured", "Google authentication is not configured");
  }
  return new OAuth2Client({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
    ...(signal ? { transporterOptions: googleOAuthTransportOptions(signal) } : {}),
  });
}

function googleProviderTimeoutError(): ApiError {
  return new ApiError(504, "google_provider_timeout", "Google sign-in did not respond in time. Start Google sign-in again");
}

function isRetryableGoogleOAuthError(error: unknown): boolean {
  return error instanceof ApiError && new Set([
    "google_provider_timeout",
    "google_provider_unavailable",
    "google_auth_not_configured",
  ]).has(error.code);
}

function transientGoogleProviderFailure(error: unknown): boolean {
  if (isRetryableGoogleOAuthError(error)) return true;
  const candidate = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = candidate.response && typeof candidate.response === "object" ? candidate.response as Record<string, unknown> : {};
  const status = typeof candidate.status === "number" ? candidate.status : typeof response.status === "number" ? response.status : undefined;
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  return new Set(["ABORT_ERR", "ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "TIMEOUTERROR"]).has(code);
}

function normalizedGoogleProviderError(error: unknown, stage: "exchange" | "verification"): ApiError {
  if (error instanceof ApiError) return error;
  if (transientGoogleProviderFailure(error)) {
    return new ApiError(502, "google_provider_unavailable", "Google sign-in is temporarily unavailable. Start Google sign-in again");
  }
  return new ApiError(
    401,
    stage === "exchange" ? "google_code_rejected" : "google_identity_invalid",
    stage === "exchange" ? "Google rejected the sign-in code" : "Google could not verify the identity token",
  );
}

export async function withGoogleOAuthProviderDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(googleProviderTimeoutError());
  }, GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS);
  timer.unref();
  try {
    const provider = Promise.resolve().then(() => operation(controller.signal));
    const aborted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason ?? googleProviderTimeoutError());
      else controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? googleProviderTimeoutError()), { once: true });
    });
    return await Promise.race([provider, aborted]);
  } catch (error) {
    if (timedOut) throw googleProviderTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function safeFrontendRedirect(input: string | undefined): string {
  try {
    const fallback = new URL("/auth", config.FRONTEND_URL);
    const candidate = input ? new URL(input, config.FRONTEND_URL) : fallback;
    const allowedOrigins = new Set([config.FRONTEND_URL, ...config.corsOrigins].flatMap((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? [url.origin] : [];
      } catch {
        return [];
      }
    }));
    if (
      (candidate.protocol !== "http:" && candidate.protocol !== "https:")
      || candidate.username
      || candidate.password
      || (config.NODE_ENV === "production" && candidate.protocol !== "https:")
      || !allowedOrigins.has(candidate.origin)
    ) throw new Error("unsafe redirect");
    return candidate.toString();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_redirect", "The OAuth redirect is not allowed");
  }
}

interface GoogleOAuthStateContext {
  version: 1;
  redirect: string;
  nonce_hash: string;
}

export function encodeGoogleOAuthStateContext(redirect: string, nonce: string): string {
  const context: GoogleOAuthStateContext = { version: 1, redirect, nonce_hash: sha256(nonce) };
  return JSON.stringify(context);
}

export function googleOAuthRedirectForNonce(value: string | null, nonce: string | undefined): string | null {
  if (!value || !nonce) return null;
  try {
    const parsed = JSON.parse(value) as Partial<GoogleOAuthStateContext>;
    if (parsed.version !== 1 || typeof parsed.redirect !== "string" || typeof parsed.nonce_hash !== "string") return null;
    if (!constantTimeEquals(parsed.nonce_hash, sha256(nonce))) return null;
    return safeFrontendRedirect(parsed.redirect);
  } catch {
    return null;
  }
}

export async function beginGoogleOAuth(redirectValue?: string): Promise<{ url: string; nonce: string }> {
  const redirect = safeFrontendRedirect(redirectValue);
  const client = googleClient();
  const state = randomToken();
  const nonce = randomToken();
  await prisma.oAuthCode.create({
    data: { kind: "google_state", code_hash: sha256(state), redirect_uri: encodeGoogleOAuthStateContext(redirect, nonce), expires_at: new Date(Date.now() + 10 * 60_000) },
  });
  return {
    url: client.generateAuthUrl({ access_type: "offline", scope: ["openid", "email", "profile"], state, prompt: "select_account" }),
    nonce,
  };
}

export interface GoogleOAuthClientLike {
  getToken(code: string): Promise<{ tokens: { id_token?: string | null } }>;
  verifyIdToken(options: { idToken: string; audience?: string }): Promise<{ getPayload(): {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  } | undefined }>;
}

export async function completeGoogleOAuth(
  code: string,
  state: string,
  nonce: string | undefined,
  clientOverride?: GoogleOAuthClientLike,
): Promise<string> {
  const stateRow = await prisma.oAuthCode.findUnique({ where: { code_hash: sha256(state) } });
  const redirect = googleOAuthRedirectForNonce(stateRow?.redirect_uri ?? null, nonce);
  if (!stateRow || stateRow.kind !== "google_state" || stateRow.used_at || stateRow.expires_at <= new Date() || !redirect) {
    throw new ApiError(400, "invalid_oauth_state", "The Google sign-in state is invalid or expired");
  }

  const consumeState = async (): Promise<void> => {
    const claimed = await prisma.oAuthCode.updateMany({
      where: { id: stateRow.id, kind: "google_state", used_at: null, expires_at: { gt: new Date() } },
      data: { used_at: new Date() },
    });
    if (claimed.count !== 1) throw new ApiError(400, "invalid_oauth_state", "The Google sign-in state is invalid or expired");
  };

  // Google authorization codes are one-use. Claim the browser-bound state before
  // sending the code to Google so parallel callbacks cannot race or consume one
  // another's successful result. Any provider failure requires a fresh sign-in.
  await consumeState();

  const payload = await withGoogleOAuthProviderDeadline(async (signal) => {
      const client: GoogleOAuthClientLike = clientOverride ?? googleClient(signal);
      let tokens: { id_token?: string | null };
      try {
        ({ tokens } = await client.getToken(code));
      } catch (error) {
        throw normalizedGoogleProviderError(error, "exchange");
      }
      if (!tokens.id_token) throw new ApiError(401, "google_identity_missing", "Google did not return an identity token");
      let ticket: Awaited<ReturnType<GoogleOAuthClientLike["verifyIdToken"]>>;
      try {
        ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.GOOGLE_CLIENT_ID });
      } catch (error) {
        throw normalizedGoogleProviderError(error, "verification");
      }
      const identity = ticket.getPayload();
      if (!identity?.sub || !identity.email || identity.email_verified !== true) {
        throw new ApiError(401, "google_email_unverified", "Google did not provide a verified email");
      }
      return { sub: identity.sub, email: identity.email, email_verified: true as const, ...(identity.name ? { name: identity.name } : {}) };
    });
  const email = normalizeEmail(payload.email);

  const user = await prisma.$transaction(async (tx) => {
    const identity = await tx.authIdentity.findUnique({ where: { provider_provider_subject: { provider: "google", provider_subject: payload.sub } }, include: { user: true } });
    if (identity) return identity.user;
    const existing = await tx.user.findUnique({ where: { email } });
    const account = existing
      ? await tx.user.update({ where: { id: existing.id }, data: { email_verified_at: existing.email_verified_at ?? new Date(), status: "active", last_login_at: new Date() } })
      : await tx.user.create({ data: { email, email_verified_at: new Date(), status: "active", last_login_at: new Date(), profile: { create: { name: payload.name, community_id: config.DEFAULT_COMMUNITY_ID } } } });
    await tx.authIdentity.create({ data: { user_id: account.id, provider: "google", provider_subject: payload.sub, provider_email: email } });
    return account;
  });

  const exchangeCode = randomToken();
  await prisma.oAuthCode.create({ data: { user_id: user.id, kind: "google_exchange", code_hash: sha256(exchangeCode), expires_at: new Date(Date.now() + 2 * 60_000) } });
  const destination = new URL(redirect);
  destination.searchParams.set("oauth_code", exchangeCode);
  return destination.toString();
}

export async function exchangeGoogleCode(code: string, meta: SessionMeta): Promise<SessionResult> {
  const record = await prisma.oAuthCode.findUnique({ where: { code_hash: sha256(code) }, include: { user: true } });
  if (!record?.user || record.kind !== "google_exchange" || record.used_at || record.expires_at <= new Date()) {
    throw new ApiError(400, "invalid_oauth_code", "The Google sign-in code is invalid or expired");
  }
  const claimed = await prisma.oAuthCode.updateMany({ where: { id: record.id, used_at: null, expires_at: { gt: new Date() } }, data: { used_at: new Date() } });
  if (claimed.count !== 1) throw new ApiError(400, "invalid_oauth_code", "The Google sign-in code is invalid or expired");
  return createSession(record.user, meta);
}

export async function requestDevPhoneOtp(phone: string, meta: SessionMeta): Promise<{ debug_code: string }> {
  if (config.NODE_ENV === "production" || !config.MOBILE_TEST_MODE || !config.mobileTestPhones.has(phone)) {
    throw new ApiError(404, "not_found", "Phone OTP fallback is unavailable");
  }
  const code = randomOtp();
  await prisma.emailOtp.create({
    data: {
      email: `phone:${phone}`,
      destination_hash: keyedHash(phone),
      code_hash: await hashOtp(code),
      purpose: "phone_dev",
      expires_at: new Date(Date.now() + 5 * 60_000),
      ip_hash: meta.ip ? keyedHash(meta.ip) : undefined,
    },
  });
  return { debug_code: code };
}

export async function verifyDevPhoneOtp(userId: string, phone: string, code: string): Promise<void> {
  if (config.NODE_ENV === "production" || !config.MOBILE_TEST_MODE || !config.mobileTestPhones.has(phone)) {
    throw new ApiError(404, "not_found", "Phone OTP fallback is unavailable");
  }
  const challenge = await prisma.emailOtp.findFirst({ where: { destination_hash: keyedHash(phone), purpose: "phone_dev", consumed_at: null }, orderBy: { created_at: "desc" } });
  if (!challenge || challenge.expires_at <= new Date() || !(await verifyOtpHash(code, challenge.code_hash))) {
    throw new ApiError(400, "invalid_otp", "The code is invalid or expired");
  }
  await prisma.$transaction([
    prisma.emailOtp.update({ where: { id: challenge.id }, data: { consumed_at: new Date(), user_id: userId } }),
    prisma.user.update({ where: { id: userId }, data: { phone, phone_verified_at: new Date() } }),
  ]);
}
