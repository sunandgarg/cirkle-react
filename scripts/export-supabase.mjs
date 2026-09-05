import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertSupabaseSourceSchema,
  canonicalJson,
  emailProviderUserIds,
  SUPABASE_EXPORT_VERSION,
  SUPABASE_SOURCE_TABLES,
  SUPABASE_TABLE_ORDER,
  validatePasswordHashRows,
} from "./lib/supabase-export-config.mjs";

const projectUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const outputSetting = String(process.env.SUPABASE_EXPORT_DIR || "");
if (!path.isAbsolute(outputSetting)) throw new Error("SUPABASE_EXPORT_DIR must be an explicit absolute path outside the repository");
const outputRoot = path.resolve(outputSetting);
const repositoryRoot = path.resolve(process.cwd());
if (outputRoot === repositoryRoot || outputRoot.startsWith(`${repositoryRoot}${path.sep}`)) {
  throw new Error("SUPABASE_EXPORT_DIR must be outside the repository because the export contains private data");
}
const passwordHashesFile = String(process.env.SUPABASE_PASSWORD_HASHES_FILE || "");
const allowPasswordResetOnly = process.env.SUPABASE_ALLOW_PASSWORD_RESET_ONLY === "true";
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(projectUrl) || !serviceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
async function checkedFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${new URL(url).pathname} failed: ${response.status} ${await response.text()}`);
  return response;
}

async function exportTable(table) {
  const rows = [];
  let expectedCount;
  const order = SUPABASE_TABLE_ORDER[table] || "id.asc";
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({ select: "*", order });
    const response = await checkedFetch(`${projectUrl}/rest/v1/${encodeURIComponent(table)}?${query}`, {
      headers: { Range: `${offset}-${offset + 999}`, Prefer: "count=exact" },
    });
    if (expectedCount === undefined) {
      const match = response.headers.get("content-range")?.match(/\/(\d+)$/);
      if (!match) throw new Error(`Supabase did not return an exact row count for ${table}`);
      expectedCount = Number(match[1]);
    }
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  if (rows.length !== expectedCount) {
    throw new Error(`Inconsistent export for ${table}: expected ${expectedCount} rows, received ${rows.length}`);
  }
  return rows;
}

async function exportUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const response = await checkedFetch(`${projectUrl}/auth/v1/admin/users?page=${page}&per_page=1000`);
    const payload = await response.json();
    const batch = Array.isArray(payload) ? payload : payload.users || [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users.sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function exportPasswordHashes(users) {
  const emailProviderUsers = emailProviderUserIds(users);
  if (!passwordHashesFile) {
    if (emailProviderUsers.size && !allowPasswordResetOnly) {
      throw new Error("Email-provider users exist. Set SUPABASE_PASSWORD_HASHES_FILE to the protected read-only auth export, or explicitly set SUPABASE_ALLOW_PASSWORD_RESET_ONLY=true");
    }
    return { mode: "forced_reset", emailProviderUsers: emailProviderUsers.size, rows: [] };
  }
  if (allowPasswordResetOnly) throw new Error("Choose password-hash migration or forced reset, not both");
  const parsed = JSON.parse(await readFile(path.resolve(passwordHashesFile), "utf8"));
  const rows = validatePasswordHashRows(users, parsed);
  return { mode: "bcrypt", emailProviderUsers: emailProviderUsers.size, rows };
}

async function listBucket(bucket, prefix = "") {
  const objects = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await checkedFetch(`${projectUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    const page = await response.json();
    for (const entry of page) {
      const objectPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) objects.push({ ...entry, path: objectPath });
      else objects.push(...await listBucket(bucket, objectPath));
    }
    if (page.length < 1000) break;
  }
  return objects;
}

function storageTarget(bucket, objectPath) {
  const parts = objectPath.split("/");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(bucket)
    || !objectPath || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new Error(`Unsafe Supabase storage path in bucket ${bucket}`);
  }
  const bucketRoot = path.resolve(outputRoot, "storage", bucket);
  const target = path.resolve(bucketRoot, ...parts);
  if (!target.startsWith(`${bucketRoot}${path.sep}`)) throw new Error(`Supabase storage path escapes bucket ${bucket}`);
  return target;
}

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
await chmod(outputRoot, 0o700);
const openApiResponse = await checkedFetch(`${projectUrl}/rest/v1/`, {
  headers: { Accept: "application/openapi+json" },
});
const openApi = await openApiResponse.json();
const liveTables = assertSupabaseSourceSchema(Object.keys(openApi.paths || {})
  .filter((entry) => entry.startsWith("/") && !entry.startsWith("/rpc/"))
  .map((entry) => entry.slice(1))
  .filter(Boolean));
const exportedTables = {};
for (const table of SUPABASE_SOURCE_TABLES) {
  exportedTables[table] = await exportTable(table);
  process.stderr.write(`exported ${table}: ${exportedTables[table].length}\n`);
}
const users = await exportUsers();
const passwordMigration = await exportPasswordHashes(users);
const bucketResponse = await checkedFetch(`${projectUrl}/storage/v1/bucket`);
const buckets = (await bucketResponse.json()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
const storage = {};
for (const bucket of buckets) {
  const objects = await listBucket(bucket.id);
  storage[bucket.id] = objects;
  for (const object of objects) {
    const target = storageTarget(bucket.id, object.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const response = await checkedFetch(`${projectUrl}/storage/v1/object/${encodeURIComponent(bucket.id)}/${object.path.split("/").map(encodeURIComponent).join("/")}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    object.export_size_bytes = bytes.length;
    object.export_sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(target, bytes, { mode: 0o600 });
    await chmod(target, 0o600);
  }
  process.stderr.write(`exported storage ${bucket.id}: ${objects.length}\n`);
}
const sourceContent = {
  project_url: projectUrl,
  source_schema_tables: liveTables,
  users,
  password_migration_mode: passwordMigration.mode,
  email_provider_users: passwordMigration.emailProviderUsers,
  password_hashes: passwordMigration.rows,
  tables: exportedTables,
  buckets,
  storage,
};
const manifest = {
  export_version: SUPABASE_EXPORT_VERSION,
  exported_at: new Date().toISOString(),
  source_content_sha256: createHash("sha256").update(canonicalJson(sourceContent)).digest("hex"),
  ...sourceContent,
};
const manifestPath = path.join(outputRoot, "manifest.json");
await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
await chmod(manifestPath, 0o600);
process.stdout.write(`${JSON.stringify({ export_version: SUPABASE_EXPORT_VERSION, users: users.length, email_provider_users: passwordMigration.emailProviderUsers, password_migration_mode: passwordMigration.mode, password_hashes: passwordMigration.rows.length, source_tables: liveTables.length, source_public_rows: Object.values(exportedTables).reduce((sum, value) => sum + value.length, 0), tables: Object.fromEntries(Object.entries(exportedTables).map(([key, value]) => [key, value.length])), storage: Object.fromEntries(Object.entries(storage).map(([key, value]) => [key, value.length])) }, null, 2)}\n`);
