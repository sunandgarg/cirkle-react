type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const resolveSupabaseProjectId = (supabaseUrl: string, configuredProjectId?: string) => {
  const configured = configuredProjectId?.trim();
  if (configured) return configured;
  try {
    return new URL(supabaseUrl).hostname.split(".")[0] || "project";
  } catch {
    return "project";
  }
};

export const authStorageKeyFor = (projectId: string) => `cirkle-auth-${projectId}`;

export const isInvalidRefreshTokenError = (error: unknown) => {
  if (!error) return false;
  const record = typeof error === "object" ? error as Record<string, unknown> : {};
  const message = [record.message, record.error, record.error_description, record.code, record.error_code, error]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return message.includes("invalid refresh token")
    || message.includes("refresh token not found")
    || message.includes("refresh_token_not_found");
};

export const isMissingAuthIdentityError = (error: unknown) => {
  if (!error) return false;
  const record = typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(record.status || record.statusCode || 0);
  const message = [record.message, record.error, record.error_description, record.code, record.error_code, error]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return message.includes("user from sub claim in jwt does not exist")
    || message.includes("auth account no longer exists")
    || message.includes("auth_account_not_found")
    || message.includes("profiles_user_id_fkey")
    || message.includes("invalid jwt")
    || ((status === 401 || status === 403) && message.includes("user") && message.includes("not found"));
};

export const clearStoredAuthSession = (storage: StorageLike, storageKey: string) => {
  storage.removeItem(storageKey);
  storage.removeItem(`${storageKey}-code-verifier`);
};

export const migrateLegacyAuthSession = (
  storage: StorageLike,
  storageKey: string,
  legacyStorageKey = "cirkle-auth-undefined",
) => {
  if (storageKey === legacyStorageKey || storage.getItem(storageKey)) return;
  const legacySession = storage.getItem(legacyStorageKey);
  if (legacySession) storage.setItem(storageKey, legacySession);
  const legacyVerifier = storage.getItem(`${legacyStorageKey}-code-verifier`);
  if (legacyVerifier) storage.setItem(`${storageKey}-code-verifier`, legacyVerifier);
  clearStoredAuthSession(storage, legacyStorageKey);
};
