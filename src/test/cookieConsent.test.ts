import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptCookieConsent,
  COOKIE_CONSENT_MAX_AGE_SECONDS,
  COOKIE_CONSENT_NAME,
  COOKIE_CONSENT_VERSION,
  hasCookieConsent,
} from "@/lib/cookieConsent";

describe("cookie consent", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = `${COOKIE_CONSENT_NAME}=; Max-Age=0; Path=/`;
  });

  it("is absent before a verified member accepts", () => {
    expect(hasCookieConsent()).toBe(false);
  });

  it("records a one-year first-party acknowledgement", () => {
    acceptCookieConsent();
    expect(document.cookie).toContain(`${COOKIE_CONSENT_NAME}=${COOKIE_CONSENT_VERSION}`);
    expect(COOKIE_CONSENT_MAX_AGE_SECONDS).toBe(31_536_000);
    expect(hasCookieConsent()).toBe(true);
  });
});
