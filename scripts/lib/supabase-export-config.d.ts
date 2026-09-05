export const SUPABASE_EXPORT_VERSION: number;
export const SUPABASE_SOURCE_TABLES: string[];
export const SUPABASE_TABLE_ORDER: Record<string, string>;
export function assertSupabaseSourceSchema(liveTables: string[]): string[];
export function emailProviderUserIds(users: Array<Record<string, unknown>>): Set<string>;
export function validatePasswordHashRows(
  users: Array<Record<string, unknown>>,
  values: unknown,
): Array<{ user_id: string; password_hash: string }>;
export function canonicalJson(value: unknown): string;
