const baseUrl = (process.env.SMOKE_API_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const localSeedFallback = process.env.NODE_ENV !== "production";
const email = (process.env.SMOKE_EMAIL || (localSeedFallback ? process.env.SEED_ADMIN_EMAIL : ""))?.trim();
const password = process.env.SMOKE_PASSWORD || (localSeedFallback ? process.env.SEED_ADMIN_PASSWORD : undefined);

if (!email || !password) throw new Error("Set SMOKE_EMAIL and SMOKE_PASSWORD for the isolated local test account");

const checked = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} returned ${response.status}`);
  return response;
};

const asJson = async (path, init) => checked(path, init).then((response) => response.json());
const jsonPost = (body, extra = {}) => {
  const { headers = {}, ...rest } = extra;
  return {
    method: "POST",
    ...rest,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
};
const cookieFrom = (response) => response.headers.get("set-cookie")?.split(";", 1)[0] || "";

await checked("/healthz");
const readiness = await asJson("/readyz");
const legacyReadinessAlias = await fetch(`${baseUrl}/api/readyz`);
if (legacyReadinessAlias.status !== 404) throw new Error(`/api/readyz must stay unavailable, received ${legacyReadinessAlias.status}`);

const loginResponse = await checked("/api/auth/login", jsonPost({ email, password }));
const login = await loginResponse.json();
const accessToken = login.access_token;
const refreshCookie = cookieFrom(loginResponse);
if (!accessToken || !refreshCookie) throw new Error("Login did not return both session layers");

const authHeaders = { authorization: `Bearer ${accessToken}` };
const me = await asJson("/api/auth/me", { headers: authHeaders });
const profileState = await asJson("/api/rpc/get_my_profile_state", jsonPost({}, { headers: authHeaders }));

const [refreshOne, refreshTwo] = await Promise.all([
  checked("/api/auth/refresh", jsonPost({}, { headers: { cookie: refreshCookie } })),
  checked("/api/auth/refresh", jsonPost({}, { headers: { cookie: refreshCookie } })),
]);
const nextCookie = cookieFrom(refreshOne) || cookieFrom(refreshTwo);
const refreshed = await refreshOne.json();
await refreshTwo.json();
if (!refreshed.access_token || !nextCookie) throw new Error("Parallel refresh did not produce a usable successor session");

await checked("/api/auth/logout", jsonPost({}, {
  headers: { authorization: `Bearer ${refreshed.access_token}`, cookie: nextCookie },
}));

const profilePayload = profileState?.data ?? profileState;
const profile = profilePayload?.profile ?? profilePayload;
const checks = {
  health: true,
  databaseAndStorageReady: readiness?.status === "ready",
  expensiveReadinessIsNotPublicApi: true,
  authenticatedUser: me?.user?.email === email,
  ownerProfileComplete: Boolean(profile?.onboarding_completed && profile?.is_verified && profile?.iit_name && profile?.phone_number),
  concurrentRefresh: true,
  logout: true,
};
if (Object.values(checks).some((value) => value !== true)) throw new Error(`Smoke assertion failed: ${JSON.stringify(checks)}`);
console.info(JSON.stringify(checks));
