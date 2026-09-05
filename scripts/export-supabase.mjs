import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const projectUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const outputRoot = path.resolve(process.env.SUPABASE_EXPORT_DIR || "./.local/supabase-export");
if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(projectUrl) || !serviceKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const tables = [
  "academic_degrees", "academic_institutes", "academic_networks", "academic_specialisations", "ad_messages",
  "app_settings", "applications", "blog_bookmarks", "blog_comments", "blog_likes", "blogs", "call_participants",
  "call_sessions", "chat_members", "chat_rooms", "comments", "connections", "consultations",
  "course_verification_requests", "custom_options", "custom_skills", "document_verifications", "education",
  "event_scan_runs", "events", "forum_room_state", "job_scan_runs", "jobs", "message_deleted_for_user",
  "messages", "nav_config", "notifications", "pinned_messages", "platform_owners", "poll_votes", "polls", "posts",
  "professional_experience", "profiles", "reactions", "reports", "rsvps", "saved_views", "stories",
  "user_pinned_messages", "user_roles", "verification_audit_log", "verification_codes", "verifications",
  "verified_academic_affiliations",
];

const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
async function checkedFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${options.method || "GET"} ${new URL(url).pathname} failed: ${response.status} ${await response.text()}`);
  return response;
}

async function exportTable(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await checkedFetch(`${projectUrl}/rest/v1/${encodeURIComponent(table)}?select=*`, {
      headers: { Range: `${offset}-${offset + 999}`, Prefer: "count=exact" },
    });
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) break;
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
  return users;
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

await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const exportedTables = {};
for (const table of tables) {
  exportedTables[table] = await exportTable(table);
  process.stderr.write(`exported ${table}: ${exportedTables[table].length}\n`);
}
const users = await exportUsers();
const bucketResponse = await checkedFetch(`${projectUrl}/storage/v1/bucket`);
const buckets = await bucketResponse.json();
const storage = {};
for (const bucket of buckets) {
  const objects = await listBucket(bucket.id);
  storage[bucket.id] = objects;
  for (const object of objects) {
    const target = path.join(outputRoot, "storage", bucket.id, ...object.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const response = await checkedFetch(`${projectUrl}/storage/v1/object/${encodeURIComponent(bucket.id)}/${object.path.split("/").map(encodeURIComponent).join("/")}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  }
  process.stderr.write(`exported storage ${bucket.id}: ${objects.length}\n`);
}
const manifest = { exported_at: new Date().toISOString(), project_url: projectUrl, users, tables: exportedTables, buckets, storage };
await writeFile(path.join(outputRoot, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ users: users.length, tables: Object.fromEntries(Object.entries(exportedTables).map(([key, value]) => [key, value.length])), storage: Object.fromEntries(Object.entries(storage).map(([key, value]) => [key, value.length])) }, null, 2)}\n`);
