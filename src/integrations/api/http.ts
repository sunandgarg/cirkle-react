import { ApiError, type ApiResult, type ApiSession } from "./types";
import { clearSession, normalizeSession, readSession, writeSession } from "./session";

const configuredOrigin = String(import.meta.env.VITE_API_URL || "").trim().replace(/\/+$/, "");
export const API_BASE_URL = `${configuredOrigin}/api`;
export const API_ORIGIN = configuredOrigin || (typeof window !== "undefined" ? window.location.origin : "");

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
  auth?: boolean;
  retryAuth?: boolean;
};

const endpoint = (path: string): string => `${API_BASE_URL}/${path.replace(/^\/+/, "")}`;

const errorFrom = (payload: unknown, response?: Response): ApiError => {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const message = String(nested.message || record.message || record.error_description || record.error || response?.statusText || "Request failed");
  return new ApiError(message, {
    ...record,
    ...nested,
    status: Number(nested.status || record.status || response?.status || 0) || undefined,
    statusCode: Number(nested.statusCode || record.statusCode || response?.status || 0) || undefined,
    code: String(nested.code || record.code || "") || undefined,
    context: response,
  });
};

const parseResponse = async (response: Response): Promise<unknown> => {
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("json")) return response.json().catch(() => null);
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
};

const rawFetch = async (path: string, options: RequestOptions = {}): Promise<{ response: Response; payload: unknown }> => {
  const headers = new Headers(options.headers);
  const session = readSession();
  if (options.auth !== false && session?.access_token) headers.set("Authorization", `Bearer ${session.access_token}`);

  let body: BodyInit | undefined;
  if (options.body instanceof FormData || options.body instanceof Blob || typeof options.body === "string") {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }

  const response = await fetch(endpoint(path), {
    ...options,
    body,
    headers,
    credentials: options.credentials || "include",
  });
  return { response, payload: await parseResponse(response) };
};

let refreshPromise: Promise<ApiSession | null> | null = null;

export const refreshApiSession = (): Promise<ApiSession | null> => {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const current = readSession();
    try {
      const { response, payload } = await rawFetch("auth/refresh", {
        method: "POST",
        auth: false,
        retryAuth: false,
        body: current?.refresh_token ? { refresh_token: current.refresh_token } : {},
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) clearSession(true);
        return null;
      }
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const next = normalizeSession(record.data || record.session || payload);
      if (!next) return null;
      if (!next.refresh_token && current?.refresh_token) next.refresh_token = current.refresh_token;
      writeSession(next, "TOKEN_REFRESHED");
      return next;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
};

export const apiRequest = async <T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> => {
  try {
    let { response, payload } = await rawFetch(path, options);
    if (response.status === 401 && options.auth !== false && options.retryAuth !== false && await refreshApiSession()) {
      ({ response, payload } = await rawFetch(path, { ...options, retryAuth: false }));
    }

    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    const embeddedError = record?.error;
    if (!response.ok || embeddedError) {
      return {
        data: (record && Object.prototype.hasOwnProperty.call(record, "data") ? record.data : null) as T | null,
        error: errorFrom(embeddedError || payload, response),
        count: Number(record?.count ?? response.headers.get("x-total-count")) || null,
        status: response.status,
        statusText: response.statusText,
      };
    }

    const data = record && Object.prototype.hasOwnProperty.call(record, "data") ? record.data : payload;
    return {
      data: data as T,
      error: null,
      count: record?.count === 0 ? 0 : Number(record?.count ?? response.headers.get("x-total-count")) || null,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Network request failed";
    return { data: null, error: new ApiError(message, { code: "NETWORK_ERROR" }), status: 0, statusText: "" };
  }
};

export const apiUrl = endpoint;
