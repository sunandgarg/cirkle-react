export const MOBILE_TEST_OTP = import.meta.env.VITE_MOBILE_TEST_OTP || "123456";
export const MOBILE_TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

const MOBILE_TEST_SESSION_KEY = "cirkle:mobile-test-session";
const MOBILE_TEST_DOCUMENT_KEY = "cirkle:mobile-test-document";

const mobileTestModeEnabled = import.meta.env.VITE_MOBILE_TEST_MODE === "true";
const mobileTestAllowAll = import.meta.env.VITE_MOBILE_TEST_ALLOW_ALL === "true";
const mobileTestPhones = new Set(
  (import.meta.env.VITE_MOBILE_TEST_PHONES || "")
    .split(",")
    .map((phone: string) => phone.replace(/\D/g, ""))
    .filter(Boolean),
);

export const normalizePhone = (countryCode: string, phone: string) =>
  `${countryCode}${phone}`.replace(/\D/g, "");

export const isMobileTestPhone = (countryCode: string, phone: string) =>
  mobileTestModeEnabled && phone.replace(/\D/g, "").length === 10 &&
  (mobileTestAllowAll || mobileTestPhones.has(normalizePhone(countryCode, phone)));

export const hasMobileTestMode = () => mobileTestModeEnabled && (mobileTestAllowAll || mobileTestPhones.size > 0);

type MobileTestDocumentState = {
  phone: string;
  iitName: string;
  studentStatus: string;
  status: "pending" | "withdrawn";
  updatedAt: string;
};

const readMobileTestDocumentState = (): MobileTestDocumentState | null => {
  try {
    return JSON.parse(localStorage.getItem(MOBILE_TEST_DOCUMENT_KEY) || "null") as MobileTestDocumentState | null;
  } catch {
    return null;
  }
};

export const startMobileTestSession = (countryCode: string, phone: string) => {
  if (!isMobileTestPhone(countryCode, phone)) return false;
  const normalizedPhone = normalizePhone(countryCode, phone);
  const documentState = readMobileTestDocumentState();
  const pendingDocument = documentState?.phone === normalizedPhone && documentState.status === "pending" ? documentState : null;
  localStorage.setItem(MOBILE_TEST_SESSION_KEY, JSON.stringify({
    phone: phone.replace(/\D/g, ""),
    countryCode,
    createdAt: new Date().toISOString(),
    iitName: pendingDocument?.iitName,
    studentStatus: pendingDocument?.studentStatus,
    documentVerificationStatus: pendingDocument?.status,
  }));
  return true;
};

export type MobileTestSession = {
  phone: string;
  countryCode: string;
  createdAt: string;
  iitName?: string;
  iitEmail?: string;
  studentStatus?: string;
  isVerified?: boolean;
  onboardingCompleted?: boolean;
  name?: string;
  documentVerificationStatus?: "pending" | "withdrawn" | "rejected";
};

export const readMobileTestSession = (): MobileTestSession | null => {
  if (!mobileTestModeEnabled) return null;
  try {
    const session = JSON.parse(localStorage.getItem(MOBILE_TEST_SESSION_KEY) || "null");
    return session && isMobileTestPhone(session.countryCode, session.phone) ? session : null;
  } catch {
    return null;
  }
};

export const updateMobileTestSession = (updates: Partial<MobileTestSession>) => {
  const session = readMobileTestSession();
  if (!session) return false;
  localStorage.setItem(MOBILE_TEST_SESSION_KEY, JSON.stringify({ ...session, ...updates }));
  return true;
};

export const saveMobileTestDocumentSubmission = (iitName: string, studentStatus: string) => {
  const session = readMobileTestSession();
  if (!session) return false;
  const state: MobileTestDocumentState = {
    phone: normalizePhone(session.countryCode, session.phone),
    iitName,
    studentStatus,
    status: "pending",
    updatedAt: new Date().toISOString(),
  };
  localStorage.setItem(MOBILE_TEST_DOCUMENT_KEY, JSON.stringify(state));
  return updateMobileTestSession({ iitName, studentStatus, documentVerificationStatus: "pending" });
};

export const withdrawMobileTestDocumentSubmission = () => {
  const session = readMobileTestSession();
  if (!session) return false;
  const current = readMobileTestDocumentState();
  if (current?.phone === normalizePhone(session.countryCode, session.phone)) {
    localStorage.setItem(MOBILE_TEST_DOCUMENT_KEY, JSON.stringify({ ...current, status: "withdrawn", updatedAt: new Date().toISOString() }));
  }
  return updateMobileTestSession({ documentVerificationStatus: "withdrawn" });
};

export const clearMobileTestDocumentSubmission = () => localStorage.removeItem(MOBILE_TEST_DOCUMENT_KEY);

// Email bypass is deliberately limited to the configured local mobile test session.
// A normal authenticated user must always complete real email verification.
export const isEmailTestMode = () =>
  import.meta.env.VITE_EMAIL_TEST_ALLOW_ALL === "true" && readMobileTestSession() !== null;

export const clearMobileTestSession = () => localStorage.removeItem(MOBILE_TEST_SESSION_KEY);
