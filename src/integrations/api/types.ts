export type JsonRecord = Record<string, unknown>;

export interface ApiUser {
  id: string;
  email?: string;
  phone?: string;
  aud?: string;
  role?: string;
  created_at?: string;
  updated_at?: string;
  confirmed_at?: string;
  last_sign_in_at?: string;
  app_metadata: JsonRecord;
  user_metadata: JsonRecord;
  identities?: unknown[];
  [key: string]: unknown;
}

export interface ApiSession {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
  user: ApiUser;
  [key: string]: unknown;
}

export interface ApiErrorShape {
  message: string;
  status?: number;
  statusCode?: number;
  code?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  details?: string;
  hint?: string;
  context?: Response;
  [key: string]: unknown;
}

export class ApiError extends Error implements ApiErrorShape {
  [key: string]: unknown;
  status?: number;
  statusCode?: number;
  code?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
  details?: string;
  hint?: string;
  context?: Response;

  constructor(message: string, fields: Omit<ApiErrorShape, "message"> = {}) {
    super(message);
    this.name = "ApiError";
    Object.assign(this, fields);
  }
}

export type ApiResult<T> = {
  data: T;
  error: null;
  count?: number | null;
  status?: number;
  statusText?: string;
} | {
  data: T | null;
  error: ApiError;
  count?: number | null;
  status?: number;
  statusText?: string;
};

export type AuthChangeEvent =
  | "INITIAL_SESSION"
  | "SIGNED_IN"
  | "SIGNED_OUT"
  | "PASSWORD_RECOVERY"
  | "TOKEN_REFRESHED"
  | "USER_UPDATED";
