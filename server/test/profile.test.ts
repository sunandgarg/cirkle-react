import { describe, expect, it } from "vitest";
import { dateOnly, normalizeDateOfBirth, normalizeHttpUrl, normalizeSocialLinks, serializeProfile } from "../src/services/profile.js";

describe("profile date-of-birth compatibility", () => {
  it("accepts and round-trips a valid browser date input", () => {
    const date = normalizeDateOfBirth("2000-02-29");
    expect(date).toBeInstanceOf(Date);
    expect(dateOnly(date)).toBe("2000-02-29");
    expect(serializeProfile({ user_id: "member-one", date_of_birth: date })).toEqual({
      user_id: "member-one", date_of_birth: "2000-02-29",
    });
  });

  it("supports clearing the value", () => {
    expect(normalizeDateOfBirth("")).toBeNull();
    expect(normalizeDateOfBirth(null)).toBeNull();
  });

  it("rejects invalid dates, timestamps, and future dates", () => {
    expect(() => normalizeDateOfBirth("2025-02-29")).toThrow(/valid calendar date/);
    expect(() => normalizeDateOfBirth("2000-02-29T00:00:00.000Z")).toThrow(/YYYY-MM-DD/);
    expect(() => normalizeDateOfBirth("2999-01-01")).toThrow(/future/);
  });
});

describe("profile external URLs", () => {
  it("normalizes only credential-free http(s) social links", () => {
    expect(normalizeSocialLinks({ linkedin: "https://www.linkedin.com/in/member", website: "http://example.com" })).toEqual({
      linkedin: "https://www.linkedin.com/in/member", website: "http://example.com/",
    });
    expect(normalizeSocialLinks({ "custom:Portfolio": "https://example.com/work" })).toEqual({
      "custom:Portfolio": "https://example.com/work",
    });
    expect(normalizeHttpUrl("https://linkedin.com/in/member", "LinkedIn URL")).toBe("https://linkedin.com/in/member");
  });

  it.each(["javascript:alert(1)", "data:text/html,bad", "ftp://example.com/file", "https://user:pass@example.com/"])("rejects unsafe social URL %s", (value) => {
    expect(() => normalizeSocialLinks({ linkedin: value })).toThrow(/http\(s\)/);
  });

  it("rejects custom labels containing separators or control characters", () => {
    expect(() => normalizeSocialLinks({ "custom:Work:Private": "https://example.com" })).toThrow(/name is invalid/);
    expect(() => normalizeSocialLinks({ "custom:Work\nPrivate": "https://example.com" })).toThrow(/name is invalid/);
  });

  it("applies the same rule to forum attachment URLs", () => {
    expect(() => normalizeHttpUrl("javascript:alert(1)", "Forum file URL")).toThrow(/http\(s\)/);
    expect(() => normalizeHttpUrl("https://user:pass@example.com/file", "Forum file URL")).toThrow(/http\(s\)/);
  });
});
