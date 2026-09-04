import { apiRequest, apiUrl, refreshApiSession } from "./http";
import {
  clearSession,
  emitAuthChange,
  isSessionExpiring,
  normalizeSession,
  normalizeUser,
  readSession,
  subscribeToAuthChanges,
  writeSession,
} from "./session";
import { ApiError, type ApiResult, type ApiSession, type ApiUser, type AuthChangeEvent } from "./types";

type AuthData = { user: ApiUser | null; session: ApiSession | null };
type AuthCallback = (event: AuthChangeEvent, session: ApiSession | null) => void | Promise<void>;

const successful = <T>(data: T): ApiResult<T> => ({ data, error: null });

const authData = (payload: unknown, fallback?: ApiSession | null): AuthData => {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const session = normalizeSession(record.session || payload) || fallback || null;
  const userCandidate = record.user || session?.user;
  const user = userCandidate ? normalizeUser(userCandidate, session?.access_token) : null;
  if (session && user) session.user = user;
  return { user, session };
};

const removeAuthParams = (...keys: string[]): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  keys.forEach((key) => url.searchParams.delete(key));
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
};

let urlAuthPromise: Promise<ApiResult<ApiSession | null>> | null = null;

const initializeAuthFromUrl = (): Promise<ApiResult<ApiSession | null>> => {
  if (urlAuthPromise) return urlAuthPromise;
  urlAuthPromise = (async () => {
    if (typeof window === "undefined") return successful(readSession());
    const params = new URLSearchParams(window.location.search);
    const oauthCode = params.get("oauth_code");
    if (!oauthCode) return successful(readSession());

    const result = await apiRequest<unknown>("auth/oauth/exchange", {
      method: "POST",
      body: { code: oauthCode, redirect_to: `${window.location.origin}${window.location.pathname}` },
      auth: false,
      retryAuth: false,
    });
    removeAuthParams("oauth_code");
    if (result.error) return { ...result, data: null };
    const session = normalizeSession(result.data);
    if (!session) {
      return { data: null, error: new ApiError("Authentication callback did not return a session", { code: "INVALID_AUTH_RESPONSE" }) };
    }
    writeSession(session, "SIGNED_IN");
    return successful(session);
  })();
  return urlAuthPromise;
};

export class ApiAuthClient {
  async getSession(): Promise<ApiResult<{ session: ApiSession | null }>> {
    const initialized = await initializeAuthFromUrl();
    if (initialized.error) return { data: null, error: initialized.error };

    let session = initialized.data || readSession();
    if (session && isSessionExpiring(session)) session = await refreshApiSession() || session;
    if (session) return successful({ session });

    const restored = await apiRequest<unknown>("auth/session", { method: "GET", auth: false, retryAuth: false });
    if (restored.error) {
      if (restored.status === 401 || restored.status === 403 || restored.status === 404) return successful({ session: null });
      return { data: null, error: restored.error };
    }
    session = normalizeSession(restored.data);
    if (session) writeSession(session);
    return successful({ session });
  }

  async getUser(jwt?: string): Promise<ApiResult<{ user: ApiUser | null }>> {
    const session = readSession();
    if (!jwt && !session) return successful({ user: null });
    const result = await apiRequest<unknown>("auth/me", {
      method: "GET",
      ...(jwt ? { auth: false, headers: { Authorization: `Bearer ${jwt}` } } : {}),
    });
    if (result.error) return { data: null, error: result.error };
    const record = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    const user = normalizeUser(record.user || result.data, jwt || session?.access_token);
    if (session && user.id) writeSession({ ...session, user });
    return successful({ user: user.id ? user : null });
  }

  onAuthStateChange(callback: AuthCallback): { data: { subscription: { unsubscribe: () => void } } } {
    const unsubscribe = subscribeToAuthChanges((event, session) => { void callback(event, session); });
    void initializeAuthFromUrl().then((result) => {
      if (!result.error) void callback("INITIAL_SESSION", result.data || readSession());
    });
    return { data: { subscription: { unsubscribe } } };
  }

  async signInWithPassword(credentials: { email: string; password: string }): Promise<ApiResult<AuthData>> {
    const result = await apiRequest<unknown>("auth/login", {
      method: "POST",
      body: credentials,
      auth: false,
      retryAuth: false,
    });
    if (result.error) return { data: null, error: result.error };
    const data = authData(result.data);
    if (!data.session) return { data: null, error: new ApiError("Sign-in did not return a session", { code: "INVALID_AUTH_RESPONSE" }) };
    writeSession(data.session, "SIGNED_IN");
    return successful(data);
  }

  async signInWithOAuth(input: {
    provider: string;
    options?: {
      redirectTo?: string;
      scopes?: string;
      queryParams?: Record<string, string>;
      skipBrowserRedirect?: boolean;
    };
  }): Promise<ApiResult<{ provider: string; url: string }>> {
    if (input.provider !== "google") {
      return { data: null, error: new ApiError(`Unsupported OAuth provider: ${input.provider}`, { code: "UNSUPPORTED_PROVIDER" }) };
    }
    const base = apiUrl("auth/google");
    const url = new URL(base, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    if (input.options?.redirectTo) url.searchParams.set("redirect_to", input.options.redirectTo);
    if (input.options?.scopes) url.searchParams.set("scopes", input.options.scopes);
    Object.entries(input.options?.queryParams || {}).forEach(([key, value]) => url.searchParams.set(key, value));
    const destination = base.startsWith("/") ? `${url.pathname}${url.search}` : url.toString();
    if (typeof window !== "undefined" && !input.options?.skipBrowserRedirect) window.location.assign(destination);
    return successful({ provider: input.provider, url: destination });
  }

  async setSession(tokens: {
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    expires_in?: number;
    user?: ApiUser;
  }): Promise<ApiResult<AuthData>> {
    const candidate = normalizeSession(tokens);
    if (!candidate) return { data: null, error: new ApiError("A valid access token is required", { code: "INVALID_SESSION" }) };
    const result = await apiRequest<unknown>("auth/session", {
      method: "POST",
      auth: false,
      retryAuth: false,
      body: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    });
    if (result.error && result.status !== 404) return { data: null, error: result.error };
    const data = authData(result.error ? tokens : result.data, candidate);
    if (!data.session) return { data: null, error: new ApiError("The session could not be established", { code: "INVALID_SESSION" }) };
    writeSession(data.session, "SIGNED_IN");
    return successful(data);
  }

  async signOut(options: { scope?: "global" | "local" | "others" } = {}): Promise<ApiResult<null>> {
    const result = await apiRequest<null>("auth/logout", { method: "POST", body: options, retryAuth: false });
    clearSession(true);
    return result.error ? { data: null, error: result.error } : successful(null);
  }

  async updateUser(attributes: {
    email?: string;
    phone?: string;
    password?: string;
    data?: Record<string, unknown>;
  }): Promise<ApiResult<{ user: ApiUser | null }>> {
    const result = await apiRequest<unknown>("auth/user", { method: "PUT", body: attributes });
    if (result.error) return { data: null, error: result.error };
    const current = readSession();
    const data = authData(result.data, current);
    const user = data.user || current?.user || null;
    if (current && user) writeSession({ ...(data.session || current), user }, "USER_UPDATED");
    else emitAuthChange("USER_UPDATED", current);
    return successful({ user });
  }

  async completePasswordReset(input: { token: string; password: string }): Promise<ApiResult<null>> {
    return apiRequest<null>("auth/password-reset/complete", {
      method: "POST",
      body: input,
      auth: false,
      retryAuth: false,
    });
  }

  async signInWithOtp(input: {
    email?: string;
    phone?: string;
    options?: Record<string, unknown>;
  }): Promise<ApiResult<{ user: ApiUser | null; session: ApiSession | null }>> {
    const result = await apiRequest<unknown>("auth/otp", {
      method: "POST",
      body: input,
      auth: false,
      retryAuth: false,
    });
    if (result.error) return { data: null, error: result.error };
    return successful(authData(result.data));
  }

  async verifyOtp(input: {
    email?: string;
    phone?: string;
    token: string;
    type: string;
    options?: Record<string, unknown>;
  }): Promise<ApiResult<AuthData>> {
    const result = await apiRequest<unknown>("auth/verify-otp", {
      method: "POST",
      body: input,
      auth: Boolean(readSession()),
      retryAuth: false,
    });
    if (result.error) return { data: null, error: result.error };
    const current = readSession();
    const data = authData(result.data, current);
    if (data.session) writeSession(data.session, current ? "USER_UPDATED" : "SIGNED_IN");
    return successful(data);
  }
}
