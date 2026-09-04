import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { keyedHash, sha256 } from "../src/security/crypto.js";
import { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken } from "../src/security/tokens.js";
import {
  completeGoogleOAuth,
  encodeGoogleOAuthStateContext,
  completePasswordReset,
  GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS,
  googleOAuthRedirectForNonce,
  googleOAuthTransportOptions,
  REFRESH_ROTATION_GRACE_MS,
  rotateRefreshToken,
  safeFrontendRedirect,
} from "../src/services/auth.js";
import { oauthNonceCookieClearOptions, oauthNonceCookieOptions } from "../src/routes/auth.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("JWT access tokens", () => {
  it("round-trips only the intended identity claims", () => {
    const token = signAccessToken({ id: "7f2f183d-ed76-44f0-86d1-c754562c8514", email: "owner@example.com", role: "owner" });
    const payload = verifyAccessToken(token);
    expect(payload).toMatchObject({ sub: "7f2f183d-ed76-44f0-86d1-c754562c8514", email: "owner@example.com", role: "owner", typ: "access" });
    expect(payload.exp).toBeGreaterThan(payload.iat ?? 0);
  });

  it("rejects a forged token", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow(/invalid or expired/);
  });
});

describe("Google OAuth browser binding", () => {
  it("accepts configured apex and www redirects but rejects untrusted or unsafe destinations", () => {
    expect(safeFrontendRedirect("https://cirkle.world/verify")).toBe("https://cirkle.world/verify");
    expect(safeFrontendRedirect("https://www.cirkle.world/verify?next=profile")).toBe("https://www.cirkle.world/verify?next=profile");
    expect(() => safeFrontendRedirect("https://attacker.invalid/steal")).toThrow(/not allowed/);
    expect(() => safeFrontendRedirect("javascript:alert(1)")).toThrow(/not allowed/);
    expect(() => safeFrontendRedirect("https://user:pass@cirkle.world/verify")).toThrow(/not allowed/);
  });

  it("requires the initiating browser nonce and uses a callback-only host cookie", () => {
    const nonce = "browser-nonce-that-is-long-and-random";
    const encoded = encodeGoogleOAuthStateContext("https://www.cirkle.world/verify", nonce);
    expect(googleOAuthRedirectForNonce(encoded, nonce)).toBe("https://www.cirkle.world/verify");
    expect(googleOAuthRedirectForNonce(encoded, "another-browser-nonce")).toBeNull();
    expect(googleOAuthRedirectForNonce(encoded, undefined)).toBeNull();
    expect(oauthNonceCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/auth/google/callback" });
    expect(oauthNonceCookieOptions()).not.toHaveProperty("domain");
    expect(oauthNonceCookieClearOptions()).not.toHaveProperty("maxAge");
  });

  it("uses one retry-disabled provider deadline for token exchange and identity verification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00.000Z"));
    const state = "google-state-value-that-is-long-enough";
    const nonce = "browser-nonce-that-is-long-and-random";
    vi.spyOn(prisma.oAuthCode, "findUnique").mockResolvedValue({
      id: "state-one", user_id: null, kind: "google_state", code_hash: sha256(state),
      redirect_uri: encodeGoogleOAuthStateContext("https://cirkle.world/auth", nonce),
      expires_at: new Date(Date.now() + 60_000), used_at: null, created_at: new Date(),
    });
    const consume = vi.spyOn(prisma.oAuthCode, "updateMany").mockResolvedValue({ count: 1 });
    const verifyIdToken = vi.fn(() => new Promise<never>(() => undefined));
    const callback = completeGoogleOAuth("provider-code", state, nonce, {
      getToken: () => new Promise((resolve) => setTimeout(() => resolve({ tokens: { id_token: "google-id-token" } }), 12_000)),
      verifyIdToken,
    });
    const outcome = callback.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_001);
    expect(verifyIdToken).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS - 12_000);
    const timeoutError = await outcome;
    expect(timeoutError).toMatchObject({ status: 504, code: "google_provider_timeout" });
    expect(consume).toHaveBeenCalledOnce();
    const options = googleOAuthTransportOptions(new AbortController().signal);
    expect(options).toMatchObject({ timeout: GOOGLE_OAUTH_PROVIDER_TIMEOUT_MS, retry: false, retryConfig: { retry: 0, noResponseRetries: 0 } });
  });

  it("consumes terminal provider outcomes and clears the browser nonce", async () => {
    const state = "terminal-google-state-value-long-enough";
    const nonce = "terminal-browser-nonce-long-enough";
    vi.spyOn(prisma.oAuthCode, "findUnique").mockResolvedValue({
      id: "state-terminal", user_id: null, kind: "google_state", code_hash: sha256(state),
      redirect_uri: encodeGoogleOAuthStateContext("https://cirkle.world/auth", nonce),
      expires_at: new Date(Date.now() + 60_000), used_at: null, created_at: new Date(),
    });
    const consume = vi.spyOn(prisma.oAuthCode, "updateMany").mockResolvedValue({ count: 1 });
    const outcome = completeGoogleOAuth("provider-code", state, nonce, {
      getToken: async () => ({ tokens: {} }),
      verifyIdToken: vi.fn(async () => ({ getPayload: () => undefined })),
    }).catch((error: unknown) => error);
    const terminalError = await outcome;
    expect(terminalError).toMatchObject({ status: 401, code: "google_identity_missing" });
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "state-terminal", kind: "google_state", used_at: null }),
    }));
  });

  it("rejects a parallel callback before it can contact Google", async () => {
    const state = "parallel-google-state-value-long-enough";
    const nonce = "parallel-browser-nonce-long-enough";
    vi.spyOn(prisma.oAuthCode, "findUnique").mockResolvedValue({
      id: "state-parallel", user_id: null, kind: "google_state", code_hash: sha256(state),
      redirect_uri: encodeGoogleOAuthStateContext("https://cirkle.world/auth", nonce),
      expires_at: new Date(Date.now() + 60_000), used_at: null, created_at: new Date(),
    });
    vi.spyOn(prisma.oAuthCode, "updateMany").mockResolvedValue({ count: 0 });
    const getToken = vi.fn(async () => ({ tokens: { id_token: "unused" } }));
    await expect(completeGoogleOAuth("provider-code", state, nonce, {
      getToken,
      verifyIdToken: vi.fn(async () => ({ getPayload: () => undefined })),
    })).rejects.toMatchObject({ status: 400, code: "invalid_oauth_state" });
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe("refresh token rotation", () => {
  const user = {
    id: "7f2f183d-ed76-44f0-86d1-c754562c8514",
    email: "owner@example.com",
    phone: null,
    password_hash: null,
    role: "owner",
    status: "active",
    email_verified_at: new Date("2026-01-01T00:00:00.000Z"),
    phone_verified_at: null,
    last_login_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
  };
  const familyId = "012e4567-e89b-12d3-a456-426614174000";
  const parentId = "112e4567-e89b-12d3-a456-426614174000";
  const childId = "212e4567-e89b-12d3-a456-426614174000";
  const meta = { ip: "203.0.113.10", userAgent: "Cirkle test browser" };

  it("reconstructs an identical refresh JWT from a persisted issue time", () => {
    const input = { id: user.id, sessionId: childId, familyId, issuedAt: 1_788_456_789 };
    const first = signRefreshToken(input);
    const second = signRefreshToken(input);
    expect(first).toBe(second);
    expect(verifyRefreshToken(first)).toMatchObject({ sub: user.id, sid: childId, family: familyId, iat: input.issuedAt });
  });

  it("returns the same successor during a same-browser parallel refresh", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const parentToken = signRefreshToken({ id: user.id, sessionId: parentId, familyId, issuedAt: nowSeconds - 60 });
    const childToken = signRefreshToken({ id: user.id, sessionId: childId, familyId, issuedAt: nowSeconds });
    const parent = {
      id: parentId, user_id: user.id, family_id: familyId, token_hash: sha256(parentToken), parent_id: null,
      replaced_by_id: childId, user_agent: meta.userAgent, ip_hash: keyedHash(meta.ip), expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: new Date(), revoked_at: new Date(Date.now() - 1_000), revoke_reason: "rotated", created_at: new Date((nowSeconds - 60) * 1000), user,
    };
    const child = {
      id: childId, user_id: user.id, family_id: familyId, token_hash: sha256(childToken), parent_id: parentId,
      replaced_by_id: null, user_agent: meta.userAgent, ip_hash: keyedHash(meta.ip), expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: null, revoked_at: null, revoke_reason: null, created_at: new Date(nowSeconds * 1000), user,
    };
    const find = vi.spyOn(prisma.refreshSession, "findUnique").mockImplementation(async (args: any) => args.where.token_hash ? parent as any : child as any);
    const revoke = vi.spyOn(prisma.refreshSession, "updateMany").mockResolvedValue({ count: 0 });

    const result = await rotateRefreshToken(parentToken, meta);
    expect(result.refresh_token).toBe(childToken);
    expect(find).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes the active family when a rotated token is replayed after the grace period", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const parentToken = signRefreshToken({ id: user.id, sessionId: parentId, familyId, issuedAt: nowSeconds - 60 });
    const parent = {
      id: parentId, user_id: user.id, family_id: familyId, token_hash: sha256(parentToken), parent_id: null,
      replaced_by_id: childId, user_agent: meta.userAgent, ip_hash: keyedHash(meta.ip), expires_at: new Date(Date.now() + 86_400_000),
      last_used_at: new Date(), revoked_at: new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 1), revoke_reason: "rotated", created_at: new Date((nowSeconds - 60) * 1000), user,
    };
    vi.spyOn(prisma.refreshSession, "findUnique").mockResolvedValue(parent as any);
    const revoke = vi.spyOn(prisma.refreshSession, "updateMany").mockResolvedValue({ count: 1 });

    await expect(rotateRefreshToken(parentToken, meta)).rejects.toMatchObject({ code: "refresh_token_reused" });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({
      where: { family_id: familyId, revoked_at: null },
      data: expect.objectContaining({ revoke_reason: "refresh_token_reuse" }),
    }));
  });
});

describe("password reset completion", () => {
  it("does not change the password when another request has already claimed the token", async () => {
    const token = "one-time-reset-token-that-is-long-enough";
    vi.spyOn(prisma.passwordReset, "findUnique").mockResolvedValue({
      id: "reset-one", user_id: "member-one", token_hash: sha256(token), used_at: null,
      expires_at: new Date(Date.now() + 60_000), created_at: new Date(),
    });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const updateUser = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      passwordReset: { updateMany }, user: { update: updateUser }, refreshSession: { updateMany: vi.fn() },
    }));

    await expect(completePasswordReset(token, "new-password-123"))
      .rejects.toMatchObject({ code: "invalid_reset_token" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "reset-one", used_at: null, expires_at: expect.any(Object) }),
    }));
    expect(updateUser).not.toHaveBeenCalled();
  }, 15_000);
});
