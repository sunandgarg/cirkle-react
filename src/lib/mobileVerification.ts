export const MOBILE_TEST_OTP = import.meta.env.VITE_MOBILE_TEST_OTP || "123456";
export const MOBILE_TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

const MOBILE_TEST_SESSION_KEY = "cirkle:mobile-test-session";

const mobileTestModeEnabled = import.meta.env.VITE_MOBILE_TEST_MODE === "true";
const mobileTestPhones = new Set(
  (import.meta.env.VITE_MOBILE_TEST_PHONES || "")
    .split(",")
    .map((phone: string) => phone.replace(/\D/g, ""))
    .filter(Boolean),
);

export const normalizePhone = (countryCode: string, phone: string) =>
  `${countryCode}${phone}`.replace(/\D/g, "");

export const isMobileTestPhone = (countryCode: string, phone: string) =>
  mobileTestModeEnabled && mobileTestPhones.has(normalizePhone(countryCode, phone));

export const hasMobileTestMode = () => mobileTestModeEnabled && mobileTestPhones.size > 0;

export const startMobileTestSession = (countryCode: string, phone: string) => {
  if (!isMobileTestPhone(countryCode, phone)) return false;
  localStorage.setItem(MOBILE_TEST_SESSION_KEY, JSON.stringify({
    phone: phone.replace(/\D/g, ""),
    countryCode,
    createdAt: new Date().toISOString(),
  }));
  return true;
};

export const readMobileTestSession = (): { phone: string; countryCode: string; createdAt: string } | null => {
  if (!mobileTestModeEnabled) return null;
  try {
    const session = JSON.parse(localStorage.getItem(MOBILE_TEST_SESSION_KEY) || "null");
    return session && isMobileTestPhone(session.countryCode, session.phone) ? session : null;
  } catch {
    return null;
  }
};

export const clearMobileTestSession = () => localStorage.removeItem(MOBILE_TEST_SESSION_KEY);
