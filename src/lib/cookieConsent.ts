export const COOKIE_CONSENT_NAME = "cirkle_cookie_consent";
export const COOKIE_CONSENT_VERSION = "required-v1";
export const COOKIE_CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const storageKey = `${COOKIE_CONSENT_NAME}:${COOKIE_CONSENT_VERSION}`;

export const hasCookieConsent = () => {
  if (typeof document === "undefined") return false;
  const cookieAccepted = document.cookie
    .split(";")
    .some((part) => part.trim() === `${COOKIE_CONSENT_NAME}=${COOKIE_CONSENT_VERSION}`);
  if (cookieAccepted) return true;

  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) || "null") as { expiresAt?: number } | null;
    return !!stored?.expiresAt && stored.expiresAt > Date.now();
  } catch {
    return false;
  }
};

export const acceptCookieConsent = () => {
  if (typeof document === "undefined") return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_CONSENT_NAME}=${COOKIE_CONSENT_VERSION}; Max-Age=${COOKIE_CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      acceptedAt: Date.now(),
      expiresAt: Date.now() + COOKIE_CONSENT_MAX_AGE_SECONDS * 1000,
    }));
  } catch {
    // The cookie remains the primary consent record when storage is blocked.
  }
};
