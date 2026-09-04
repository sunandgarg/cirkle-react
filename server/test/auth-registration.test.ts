import type { EmailOtp, User } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { hashOtp, keyedHash, verifyPassword } from "../src/security/crypto.js";

const mail = vi.hoisted(() => ({
  sendLoginCode: vi.fn(async () => undefined),
  sendPasswordReset: vi.fn(async () => undefined),
}));

vi.mock("../src/services/mail.js", () => mail);

import {
  assertEmailProofMayActivate,
  completeGoogleOAuth,
  encodeGoogleOAuthStateContext,
  issueEmailOtp,
  registerWithPassword,
  verifyEmailOtp,
} from "../src/services/auth.js";

const email = "member@example.com";

function account(overrides: Partial<User> = {}): User {
  const created = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "member-one",
    email,
    phone: null,
    password_hash: null,
    role: "member",
    status: "pending",
    email_verified_at: null,
    phone_verified_at: null,
    last_login_at: null,
    created_at: created,
    updated_at: created,
    ...overrides,
  };
}

async function otpChallenge(overrides: Partial<EmailOtp> = {}): Promise<EmailOtp> {
  return {
    id: "otp-one",
    user_id: null,
    email,
    destination_hash: keyedHash(email),
    code_hash: await hashOtp("123456"),
    purpose: "login",
    pending_password_hash: null,
    pending_name: null,
    attempts: 0,
    max_attempts: 5,
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    ip_hash: null,
    created_at: new Date(),
    ...overrides,
  };
}

function mockSessionTail(): void {
  vi.spyOn(prisma.auditLog, "create").mockResolvedValue({} as never);
  vi.spyOn(prisma.refreshSession, "create").mockResolvedValue({} as never);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("password registration challenge binding", () => {
  it("stores pending credentials only on the OTP and does not create or mutate a user before verification", async () => {
    vi.spyOn(prisma.user, "findUnique").mockResolvedValue(null);
    const createUser = vi.spyOn(prisma.user, "create").mockResolvedValue(account() as never);
    const updateUser = vi.spyOn(prisma.user, "update").mockResolvedValue(account() as never);
    const updateProfile = vi.spyOn(prisma.profile, "upsert").mockResolvedValue({} as never);
    vi.spyOn(prisma.emailOtp, "count").mockResolvedValue(0);
    const createOtp = vi.spyOn(prisma.emailOtp, "create").mockImplementation(async ({ data }: any) => ({
      id: "registration-otp",
      attempts: 0,
      max_attempts: 5,
      consumed_at: null,
      created_at: new Date(),
      ...data,
    }));

    await registerWithPassword(email, "Strong-password-123", "  Dreamer  ", {});

    expect(createUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
    const otpData = createOtp.mock.calls[0]?.[0].data as { pending_password_hash?: string; pending_name?: string; purpose?: string };
    expect(otpData).toMatchObject({ purpose: "registration", pending_name: "Dreamer" });
    expect(otpData.pending_password_hash).toBeTruthy();
    await expect(verifyPassword("Strong-password-123", otpData.pending_password_hash!)).resolves.toBe(true);
    expect(mail.sendLoginCode).toHaveBeenCalledWith(email, expect.stringMatching(/^\d{6}$/));
  }, 15_000);

  it("does not allow a generic OTP request to create an unbound password registration challenge", async () => {
    await expect(issueEmailOtp(email, "registration", {}))
      .rejects.toMatchObject({ status: 400, code: "registration_details_required" });
    expect(mail.sendLoginCode).not.toHaveBeenCalled();
  });

  it("commits the password and name from the verified registration challenge", async () => {
    const pendingPasswordHash = "$2b$12$registration.challenge.hash";
    const challenge = await otpChallenge({
      purpose: "registration",
      pending_password_hash: pendingPasswordHash,
      pending_name: "Verified Member",
    });
    vi.spyOn(prisma.emailOtp, "findFirst").mockResolvedValue(challenge);
    vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    const createUser = vi.fn(async () => account({
      password_hash: pendingPasswordHash,
      status: "active",
      email_verified_at: new Date(),
    }));
    const clearChallenge = vi.fn(async () => challenge);
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      emailOtp: { updateMany: vi.fn(async () => ({ count: 1 })), update: clearChallenge },
      user: { findUnique: vi.fn(async () => null), create: createUser, update: vi.fn() },
      profile: { upsert: vi.fn() },
    }));
    mockSessionTail();

    await verifyEmailOtp(email, "123456", "registration", {});

    expect(createUser).toHaveBeenCalledWith({ data: expect.objectContaining({
      email,
      password_hash: pendingPasswordHash,
      email_verified_at: expect.any(Date),
      status: "active",
      profile: { create: { name: "Verified Member", community_id: expect.any(String) } },
    }) });
    expect(clearChallenge).toHaveBeenCalledWith({
      where: { id: challenge.id },
      data: { user_id: "member-one", pending_password_hash: null, pending_name: null },
    });
  }, 15_000);

  it("never overwrites a verified account password if registration finishes after another activation", async () => {
    const challenge = await otpChallenge({ purpose: "registration", pending_password_hash: "attacker-selected-hash" });
    const verified = account({ email_verified_at: new Date(), status: "active", password_hash: "trusted-existing-hash" });
    vi.spyOn(prisma.emailOtp, "findFirst").mockResolvedValue(challenge);
    vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    const updateUser = vi.fn();
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      emailOtp: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn() },
      user: { findUnique: vi.fn(async () => verified), create: vi.fn(), update: updateUser },
      profile: { upsert: vi.fn() },
    }));

    await expect(verifyEmailOtp(email, "123456", "registration", {}))
      .rejects.toMatchObject({ status: 409, code: "email_in_use" });
    expect(updateUser).not.toHaveBeenCalled();
  }, 15_000);
});

describe("activation of legacy unverified accounts", () => {
  it("never lets email proof reactivate a suspended or disabled account", () => {
    expect(() => assertEmailProofMayActivate(account({ status: "suspended", email_verified_at: new Date() })))
      .toThrow(/unavailable/i);
    expect(() => assertEmailProofMayActivate(account({ status: "disabled", email_verified_at: null })))
      .toThrow(/unavailable/i);
    expect(() => assertEmailProofMayActivate(account({ status: "pending", email_verified_at: null }))).not.toThrow();
    expect(() => assertEmailProofMayActivate(account({ status: "active", email_verified_at: new Date() }))).not.toThrow();
  });

  it.each([
    { label: "clears an unverified legacy password", verifiedAt: null },
    { label: "retains a verified account password", verifiedAt: new Date("2026-01-02T00:00:00.000Z") },
  ])("OTP login $label", async ({ verifiedAt }) => {
    const challenge = await otpChallenge();
    const current = account({ email_verified_at: verifiedAt, status: verifiedAt ? "active" : "pending", password_hash: "trusted-existing-hash" });
    vi.spyOn(prisma.emailOtp, "findFirst").mockResolvedValue(challenge);
    vi.spyOn(prisma.emailOtp, "updateMany").mockResolvedValue({ count: 1 });
    const updateUser = vi.fn(async ({ data }: any) => account({ ...current, ...data }));
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      emailOtp: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => challenge) },
      user: { findUnique: vi.fn(async () => current), create: vi.fn(), update: updateUser },
    }));
    mockSessionTail();

    const result = await verifyEmailOtp(email, "123456", "login", {});

    const updateData = updateUser.mock.calls[0]?.[0].data as Record<string, unknown>;
    if (verifiedAt) expect(updateData).not.toHaveProperty("password_hash");
    else expect(updateData).toHaveProperty("password_hash", null);
    expect((result.user as { email?: string }).email).toBe(email);
  }, 15_000);

  it.each([
    { label: "clears an unverified legacy password", verifiedAt: null },
    { label: "retains a verified account password", verifiedAt: new Date("2026-01-02T00:00:00.000Z") },
  ])("Google activation $label", async ({ verifiedAt }) => {
    const state = `google-state-${verifiedAt ? "verified" : "pending"}-long-enough`;
    const nonce = `google-nonce-${verifiedAt ? "verified" : "pending"}-long-enough`;
    const current = account({ email_verified_at: verifiedAt, status: verifiedAt ? "active" : "pending", password_hash: "trusted-existing-hash" });
    vi.spyOn(prisma.oAuthCode, "findUnique").mockResolvedValue({
      id: "state-one",
      user_id: null,
      kind: "google_state",
      code_hash: "state-hash",
      redirect_uri: encodeGoogleOAuthStateContext("https://cirkle.world/auth", nonce),
      expires_at: new Date(Date.now() + 60_000),
      used_at: null,
      created_at: new Date(),
    });
    vi.spyOn(prisma.oAuthCode, "updateMany").mockResolvedValue({ count: 1 });
    vi.spyOn(prisma.oAuthCode, "create").mockResolvedValue({} as never);
    const updateUser = vi.fn(async ({ data }: any) => account({ ...current, ...data }));
    const createIdentity = vi.fn(async () => ({}));
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      authIdentity: { findUnique: vi.fn(async () => null), create: createIdentity },
      user: { findUnique: vi.fn(async () => current), update: updateUser, create: vi.fn() },
    }));

    await completeGoogleOAuth("provider-code", state, nonce, {
      getToken: async () => ({ tokens: { id_token: "provider-id-token" } }),
      verifyIdToken: async () => ({ getPayload: () => ({ sub: "google-subject", email, email_verified: true, name: "Google Member" }) }),
    });

    const updateData = updateUser.mock.calls[0]?.[0].data as Record<string, unknown>;
    if (verifiedAt) expect(updateData).not.toHaveProperty("password_hash");
    else expect(updateData).toHaveProperty("password_hash", null);
    expect(createIdentity).toHaveBeenCalledOnce();
  });

  it("also clears a legacy password when an existing Google identity first becomes verified", async () => {
    const state = "google-existing-identity-state-long-enough";
    const nonce = "google-existing-identity-nonce-long-enough";
    const current = account({ password_hash: "legacy-unverified-hash" });
    vi.spyOn(prisma.oAuthCode, "findUnique").mockResolvedValue({
      id: "state-existing",
      user_id: null,
      kind: "google_state",
      code_hash: "state-hash",
      redirect_uri: encodeGoogleOAuthStateContext("https://cirkle.world/auth", nonce),
      expires_at: new Date(Date.now() + 60_000),
      used_at: null,
      created_at: new Date(),
    });
    vi.spyOn(prisma.oAuthCode, "updateMany").mockResolvedValue({ count: 1 });
    vi.spyOn(prisma.oAuthCode, "create").mockResolvedValue({} as never);
    const updateUser = vi.fn(async ({ data }: any) => account({ ...current, ...data }));
    vi.spyOn(prisma, "$transaction").mockImplementation(async (callback: any) => callback({
      authIdentity: { findUnique: vi.fn(async () => ({ user: current })), create: vi.fn() },
      user: { update: updateUser, findUnique: vi.fn(), create: vi.fn() },
    }));

    await completeGoogleOAuth("provider-code", state, nonce, {
      getToken: async () => ({ tokens: { id_token: "provider-id-token" } }),
      verifyIdToken: async () => ({ getPayload: () => ({ sub: "google-subject", email, email_verified: true }) }),
    });

    expect(updateUser).toHaveBeenCalledWith({
      where: { id: current.id },
      data: expect.objectContaining({ password_hash: null, status: "active", email_verified_at: expect.any(Date) }),
    });
  });
});
