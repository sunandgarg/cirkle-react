export type Role = "member" | "admin" | "owner";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  community_id: string;
  is_verified: boolean;
}

export interface RequestContext {
  auth: AuthUser;
  ip?: string;
  userAgent?: string;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  request_id?: string;
  details?: unknown;
}
