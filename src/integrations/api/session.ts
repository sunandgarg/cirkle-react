import type { ApiSession, ApiUser, AuthChangeEvent, JsonRecord } from "./types";

export const CIRKLE_AUTH_STORAGE_KEY = "cirkle:auth:session:v1";

type AuthListener = (event: AuthChangeEvent, session: ApiSession | null) => void;

const listeners = new Set<AuthListener>();
let memorySession: ApiSession | null = null;

const storage = (): Storage | null => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

const decodeJwtPayload = (token: string): JsonRecord => {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return {};
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const json = typeof atob === "function"
      ? decodeURIComponent(Array.from(atob(padded), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""))
      : "{}";
    return asRecord(JSON.parse(json));
  } catch {
    return {};
  }
};

export const normalizeUser = (value: unknown, accessToken = ""): ApiUser => {
  const record = asRecord(value);
  const claims = accessToken ? decodeJwtPayload(accessToken) : {};
  const id = String(record.id || record.sub || claims.sub || "");
  const email = record.email || claims.email;
  const phone = record.phone || claims.phone;
  return {
    ...claims,
    ...record,
    id,
    ...(email ? { email: String(email) } : {}),
    ...(phone ? { phone: String(phone) } : {}),
    app_metadata: asRecord(record.app_metadata || claims.app_metadata),
    user_metadata: asRecord(record.user_metadata || claims.user_metadata),
  };
};

export const normalizeSession = (value: unknown): ApiSession | null => {
  const outer = asRecord(value);
  const candidate = asRecord(outer.session || outer);
  const accessToken = candidate.access_token || candidate.accessToken || outer.access_token || outer.accessToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  const claims = decodeJwtPayload(accessToken);
  const expiresAtValue = candidate.expires_at || candidate.expiresAt || claims.exp;
  const expiresInValue = candidate.expires_in || candidate.expiresIn;
  const expiresAt = Number(expiresAtValue || 0)
    || (Number(expiresInValue || 0) ? Math.floor(Date.now() / 1000) + Number(expiresInValue) : undefined);
  return {
    ...candidate,
    access_token: accessToken,
    refresh_token: String(candidate.refresh_token || candidate.refreshToken || "") || undefined,
    expires_at: expiresAt,
    expires_in: Number(expiresInValue || 0) || undefined,
    token_type: String(candidate.token_type || candidate.tokenType || "bearer"),
    user: normalizeUser(candidate.user || outer.user, accessToken),
  };
};

export const readSession = (): ApiSession | null => {
  const target = storage();
  if (!target) return memorySession;
  try {
    const raw = target.getItem(CIRKLE_AUTH_STORAGE_KEY);
    memorySession = raw ? normalizeSession(JSON.parse(raw)) : null;
  } catch {
    target.removeItem(CIRKLE_AUTH_STORAGE_KEY);
    memorySession = null;
  }
  return memorySession;
};

export const writeSession = (session: ApiSession, event?: AuthChangeEvent): ApiSession => {
  memorySession = normalizeSession(session);
  if (!memorySession) throw new Error("The API returned a session without an access token");
  try { storage()?.setItem(CIRKLE_AUTH_STORAGE_KEY, JSON.stringify(memorySession)); } catch { /* memory fallback */ }
  if (event) emitAuthChange(event, memorySession);
  return memorySession;
};

export const clearSession = (emit = false): void => {
  memorySession = null;
  try { storage()?.removeItem(CIRKLE_AUTH_STORAGE_KEY); } catch { /* memory fallback */ }
  if (emit) emitAuthChange("SIGNED_OUT", null);
};

export const subscribeToAuthChanges = (listener: AuthListener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const emitAuthChange = (event: AuthChangeEvent, session: ApiSession | null): void => {
  listeners.forEach((listener) => {
    queueMicrotask(() => listener(event, session));
  });
};

export const isSessionExpiring = (session: ApiSession, leewaySeconds = 30): boolean =>
  Boolean(session.expires_at && session.expires_at <= Math.floor(Date.now() / 1000) + leewaySeconds);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== CIRKLE_AUTH_STORAGE_KEY) return;
    const next = event.newValue ? normalizeSession(JSON.parse(event.newValue)) : null;
    memorySession = next;
    emitAuthChange(next ? "SIGNED_IN" : "SIGNED_OUT", next);
  });
}
