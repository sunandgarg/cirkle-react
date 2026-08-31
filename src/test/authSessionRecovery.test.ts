import { beforeEach, describe, expect, it } from "vitest";
import {
  authStorageKeyFor,
  clearStoredAuthSession,
  isInvalidRefreshTokenError,
  isMissingAuthIdentityError,
  migrateLegacyAuthSession,
  resolveSupabaseProjectId,
} from "@/lib/authSessionRecovery";

describe("authentication session recovery", () => {
  beforeEach(() => localStorage.clear());

  it("derives a stable project-specific storage key when the optional env value is absent", () => {
    expect(resolveSupabaseProjectId("https://bugwubrwvlqayxwcazfd.supabase.co")).toBe("bugwubrwvlqayxwcazfd");
    expect(authStorageKeyFor("bugwubrwvlqayxwcazfd")).toBe("cirkle-auth-bugwubrwvlqayxwcazfd");
  });

  it("recognizes Supabase's invalid refresh-token responses", () => {
    expect(isInvalidRefreshTokenError({ error_code: "refresh_token_not_found", message: "Invalid Refresh Token" })).toBe(true);
    expect(isInvalidRefreshTokenError(new Error("network unavailable"))).toBe(false);
  });

  it("recognizes deleted-account and orphaned-profile identity errors", () => {
    expect(isMissingAuthIdentityError({ status: 403, message: "User from sub claim in JWT does not exist" })).toBe(true);
    expect(isMissingAuthIdentityError({ message: 'violates foreign key constraint "profiles_user_id_fkey"' })).toBe(true);
    expect(isMissingAuthIdentityError(new Error("network unavailable"))).toBe(false);
  });

  it("migrates the old undefined-key session once and can clear all auth material", () => {
    localStorage.setItem("cirkle-auth-undefined", "session");
    localStorage.setItem("cirkle-auth-undefined-code-verifier", "verifier");
    const key = authStorageKeyFor("project-ref");
    migrateLegacyAuthSession(localStorage, key);
    expect(localStorage.getItem(key)).toBe("session");
    expect(localStorage.getItem(`${key}-code-verifier`)).toBe("verifier");
    expect(localStorage.getItem("cirkle-auth-undefined")).toBeNull();
    clearStoredAuthSession(localStorage, key);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(`${key}-code-verifier`)).toBeNull();
  });
});
