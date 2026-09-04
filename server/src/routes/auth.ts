import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { ApiError, asyncHandler } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";
import { optionalAuth, requireAuth } from "../security/middleware.js";
import {
  beginGoogleOAuth,
  createSession,
  completeGoogleOAuth,
  completePasswordReset,
  exchangePasswordReset,
  exchangeGoogleCode,
  issueEmailOtp,
  passwordLogin,
  publicUser,
  registerWithPassword,
  requestDevPhoneOtp,
  requestPasswordReset,
  revokeRefreshToken,
  rotateRefreshToken,
  updateAuthenticatedPassword,
  verifyDevPhoneOtp,
  verifyEmailOtp,
} from "../services/auth.js";
import { serializeProfile } from "../services/profile.js";

export const authRouter: Router = Router();
const email = z.string().email().max(320);
const password = z.string().min(10).max(128);
const meta = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });
const cookieName = "cirkle_refresh";
const oauthNonceCookieName = "cirkle_google_oauth_nonce";
export const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE || config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth",
  domain: config.COOKIE_DOMAIN,
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
});

export const oauthNonceCookieOptions = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE || config.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/api/auth/google/callback",
  maxAge: 10 * 60_000,
});

export const oauthNonceCookieClearOptions = () => {
  const { maxAge: _maxAge, ...options } = oauthNonceCookieOptions();
  return options;
};

export function deliverSession(res: Response, session: Awaited<ReturnType<typeof passwordLogin>>, wrapped = false): void {
  res.cookie(cookieName, session.refresh_token, refreshCookieOptions());
  const { refresh_token: _hidden, ...safe } = session;
  res.json(wrapped ? { data: { session: safe, user: safe.user } } : safe);
}

authRouter.post("/register", asyncHandler(async (req, res) => {
  const body = z.object({ email, password, name: z.string().trim().min(1).max(160).optional() }).parse(req.body);
  res.status(202).json(await registerWithPassword(body.email, body.password, body.name, meta(req)));
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const body = z.object({ email, password }).parse(req.body);
  deliverSession(res, await passwordLogin(body.email, body.password, meta(req)));
}));

const requestOtpHandler = asyncHandler(async (req, res) => {
  const body = z.object({ email: email.optional(), phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), purpose: z.enum(["login", "registration"]).optional(), type: z.string().optional() }).parse(req.body);
  if (body.phone) return res.status(202).json(await requestDevPhoneOtp(body.phone, meta(req)));
  if (!body.email) throw new ApiError(400, "destination_required", "Email or phone is required");
  const purpose = body.purpose ?? (body.type === "signup" ? "registration" : "login");
  res.status(202).json(await issueEmailOtp(body.email, purpose, meta(req)));
});
authRouter.post("/request-otp", requestOtpHandler);
authRouter.post("/otp", requestOtpHandler);

authRouter.post("/verify-otp", optionalAuth, asyncHandler(async (req, res) => {
  const body = z.object({ email: email.optional(), phone: z.string().optional(), code: z.string().optional(), token: z.string().optional(), purpose: z.enum(["login", "registration"]).optional(), type: z.string().optional() }).parse(req.body);
  const code = body.code ?? body.token;
  if (!code || !/^\d{6}$/.test(code)) throw new ApiError(400, "invalid_otp", "A six-digit code is required");
  if (body.phone) {
    const phone = z.string().regex(/^\+[1-9]\d{7,14}$/).parse(body.phone);
    const target = req.auth?.id ? await prisma.user.findUnique({ where: { id: req.auth.id } }) : await prisma.user.findUnique({ where: { phone } });
    if (!target) throw new ApiError(404, "phone_account_not_found", "No account is linked to this phone number");
    await verifyDevPhoneOtp(target.id, phone, code);
    const updated = await prisma.user.findUnique({ where: { id: target.id } });
    if (!updated) throw new ApiError(404, "user_not_found", "User not found");
    if (req.auth) return res.json({ user: publicUser(updated) });
    deliverSession(res, await createSession(updated, meta(req)));
    return;
  }
  if (!body.email) throw new ApiError(400, "email_required", "Email is required for email OTP verification");
  const purpose = body.purpose ?? (body.type === "signup" ? "registration" : "login");
  deliverSession(res, await verifyEmailOtp(body.email, code, purpose, meta(req)));
}));

authRouter.post("/refresh", asyncHandler(async (req, res) => {
  const token = req.cookies?.[cookieName] as string | undefined;
  if (!token) throw new ApiError(401, "refresh_token_missing", "The refresh cookie is missing");
  deliverSession(res, await rotateRefreshToken(token, meta(req)));
}));

authRouter.post("/logout", asyncHandler(async (req, res) => {
  await revokeRefreshToken(req.cookies?.[cookieName] as string | undefined, req.auth?.id);
  res.clearCookie(cookieName, refreshCookieOptions());
  res.status(204).end();
}));

authRouter.post("/password-reset/request", asyncHandler(async (req, res) => {
  const body = z.object({ email }).parse(req.body);
  const debug = await requestPasswordReset(body.email);
  res.status(202).json({ message: "If the account exists, a reset message has been sent", ...debug });
}));

authRouter.post("/password-reset/complete", asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20), password }).parse(req.body);
  await completePasswordReset(body.token, body.password);
  res.status(204).end();
}));

authRouter.get("/google", asyncHandler(async (req, res) => {
  const redirect = typeof req.query.redirect_to === "string" ? req.query.redirect_to : typeof req.query.redirect_uri === "string" ? req.query.redirect_uri : undefined;
  const start = await beginGoogleOAuth(redirect);
  res.cookie(oauthNonceCookieName, start.nonce, oauthNonceCookieOptions());
  if (req.query.response === "json") res.json({ url: start.url });
  else res.redirect(302, start.url);
}));

authRouter.get("/google/callback", asyncHandler(async (req, res) => {
  const nonce = req.cookies?.[oauthNonceCookieName] as string | undefined;
  res.clearCookie(oauthNonceCookieName, oauthNonceCookieClearOptions());
  const parsed = z.object({ code: z.string().min(1), state: z.string().min(20) }).parse(req.query);
  res.redirect(302, await completeGoogleOAuth(parsed.code, parsed.state, nonce));
}));

authRouter.post("/google/exchange", asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(20) }).parse(req.body);
  deliverSession(res, await exchangeGoogleCode(code, meta(req)));
}));

authRouter.post("/oauth/exchange", asyncHandler(async (req, res) => {
  const { code } = z.object({ code: z.string().min(20) }).parse(req.body);
  deliverSession(res, await exchangeGoogleCode(code, meta(req)));
}));

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, include: { profile: true } });
  if (!user) throw new ApiError(404, "user_not_found", "User not found");
  res.json({ user: publicUser(user), profile: serializeProfile(user.profile) });
}));

authRouter.get("/session", asyncHandler(async (req, res) => {
  const token = req.cookies?.[cookieName] as string | undefined;
  if (!token) return res.status(401).json({ error: { code: "session_missing", message: "No restorable session exists" } });
  deliverSession(res, await rotateRefreshToken(token, meta(req)));
}));

authRouter.post("/session", asyncHandler(async (req, res) => {
  const token = req.cookies?.[cookieName] as string | undefined;
  if (!token) return res.json({ session: null });
  try { deliverSession(res, await rotateRefreshToken(token, meta(req))); }
  catch { res.clearCookie(cookieName, refreshCookieOptions()); res.json({ session: null }); }
}));

authRouter.patch("/me", requireAuth, asyncHandler(async (req, res) => {
  const patch = z.object({
    name: z.string().trim().min(1).max(160).optional(),
    headline: z.string().trim().max(255).nullable().optional(),
    bio: z.string().trim().max(5000).nullable().optional(),
    location: z.string().trim().max(255).nullable().optional(),
    avatar_url: z.string().url().nullable().optional(),
    cover_photo_url: z.string().url().nullable().optional(),
  }).strict().parse(req.body);
  const profile = await prisma.profile.upsert({ where: { user_id: req.auth!.id }, create: { user_id: req.auth!.id, ...patch }, update: patch });
  res.json({ profile: serializeProfile(profile) });
}));

authRouter.put("/user", requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({
    password: password.optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    data: z.object({
      name: z.string().trim().min(1).max(160).optional(), headline: z.string().max(255).nullable().optional(), bio: z.string().max(5000).nullable().optional(),
      phone: z.string().regex(/^\d{10}$/).optional(), phone_country_code: z.string().regex(/^\+[0-9]{1,4}$/).optional(), phone_full: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
    }).optional(),
  }).parse(req.body);
  if (!body.password && !body.phone && !body.data) throw new ApiError(400, "empty_update", "No user changes were supplied");
  if (body.password) await updateAuthenticatedPassword(req.auth!.id, body.password);
  if (body.phone) await requestDevPhoneOtp(body.phone, meta(req));
  if (body.data) {
    const { phone, phone_country_code, phone_full, ...profileData } = body.data;
    await prisma.profile.upsert({ where: { user_id: req.auth!.id }, create: { user_id: req.auth!.id, ...profileData, phone_number: phone, phone_country_code, phone_full }, update: { ...profileData, phone_number: phone, phone_country_code, phone_full } });
  }
  const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, include: { profile: true } });
  if (!user) throw new ApiError(404, "user_not_found", "User not found");
  res.json({ user: publicUser(user), profile: serializeProfile(user.profile) });
}));

authRouter.post("/recovery/verify", asyncHandler(async (req, res) => {
  const body = z.object({ token: z.string().min(20) }).parse(req.body);
  deliverSession(res, await exchangePasswordReset(body.token, meta(req)));
}));

authRouter.post("/dev/phone/request", asyncHandler(async (req, res) => {
  const { phone } = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/) }).parse(req.body);
  res.json(await requestDevPhoneOtp(phone, meta(req)));
}));

authRouter.post("/dev/phone/verify", requireAuth, asyncHandler(async (req, res) => {
  const body = z.object({ phone: z.string().regex(/^\+[1-9]\d{7,14}$/), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  await verifyDevPhoneOtp(req.auth!.id, body.phone, body.code);
  res.status(204).end();
}));
