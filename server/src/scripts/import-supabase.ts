import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { legacyTables } from "../services/data.js";

type Row = Record<string, unknown>;
type ExportFile = { tables?: Record<string, unknown> };

const source = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length);
const apply = process.argv.includes("--apply");

if (!source) throw new Error("Usage: tsx server/src/scripts/import-supabase.ts --file=/absolute/export.json [--apply]");

const parsed = JSON.parse(await readFile(resolve(source), "utf8")) as ExportFile;
if (!parsed.tables || typeof parsed.tables !== "object" || Array.isArray(parsed.tables)) throw new Error("Export must contain an object named tables");

const ownershipFields: Record<string, string[]> = {
  messages: ["sender_id"], chat_members: ["user_id"], call_participants: ["user_id"], consultations: ["client_id"],
  blog_comments: ["author_id"], blog_bookmarks: ["user_id"], blog_likes: ["user_id"], course_verification_requests: ["user_id"],
  document_verifications: ["user_id"], education: ["user_id"], forum_deleted_for_user: ["user_id"], forum_room_state: ["user_id"],
  job_engagement_events: ["user_id"], notifications: ["user_id"], onboarding_progress: ["user_id"], pending_profile_options: ["user_id"],
  professional_experience: ["user_id"], saved_views: ["user_id"], stories: ["user_id", "author_id"], user_pinned_messages: ["user_id"],
  verifications: ["user_id"], verified_academic_affiliations: ["user_id"], poll_votes: ["user_id"], polls: ["created_by"],
};

const plan: Array<{ table: string; rows: Row[] }> = [];
const pollVoteKeys = new Set<string>();
const plannedOwnerIds = new Set<string>();
for (const [table, value] of Object.entries(parsed.tables)) {
  if (!legacyTables.has(table) || table === "user_roles") throw new Error(`Table ${table} is not a supported LegacyRecord import target`);
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error(`Table ${table} must be an array of objects`);
  const rows = value as Row[];
  for (const [index, row] of rows.entries()) {
    if (typeof row.id !== "string" || !row.id) throw new Error(`${table}[${index}] has no stable id; imports never manufacture or replace source IDs`);
    if (table === "poll_votes") {
      if (typeof row.poll_id !== "string" || typeof row.user_id !== "string") throw new Error(`poll_votes[${index}] has no poll_id/user_id`);
      const key = `${row.poll_id}\n${row.user_id}`;
      if (pollVoteKeys.has(key)) throw new Error(`poll_votes contains duplicate poll_id/user_id at index ${index}; deduplicate the export before import`);
      pollVoteKeys.add(key);
    }
    const owner = (ownershipFields[table] ?? []).map((field) => row[field]).find((value): value is string => typeof value === "string" && Boolean(value));
    if (owner) plannedOwnerIds.add(owner);
  }
  plan.push({ table, rows });
}

const summary = Object.fromEntries(plan.map(({ table, rows }) => [table, rows.length]));
if (!apply) {
  process.stdout.write(`${JSON.stringify({ mode: "plan", rows: summary }, null, 2)}\n`);
  process.stdout.write("No data was written. Re-run with --apply after reviewing the plan.\n");
} else {
  const existingOwners = await prisma.user.findMany({ where: { id: { in: [...plannedOwnerIds] } }, select: { id: true } });
  const existingOwnerIds = new Set(existingOwners.map((user) => user.id));
  const missingOwners = [...plannedOwnerIds].filter((id) => !existingOwnerIds.has(id));
  if (missingOwners.length) {
    throw new Error(`Import references ${missingOwners.length} users that do not exist in MySQL. Import typed users/auth identities first; no LegacyRecord rows were written.`);
  }
  await prisma.$transaction(async (tx) => {
    for (const { table, rows } of plan) {
      for (const row of rows) {
        const owner = (ownershipFields[table] ?? []).map((field) => row[field]).find((value): value is string => typeof value === "string" && Boolean(value));
        const community = typeof row.community_id === "string" ? row.community_id : null;
        await tx.legacyRecord.upsert({
          where: { table_name_record_id: { table_name: table, record_id: String(row.id) } },
          create: { table_name: table, record_id: String(row.id), owner_id: owner, community_id: community, data: row as Prisma.InputJsonValue },
          update: { owner_id: owner, community_id: community, data: row as Prisma.InputJsonValue },
        });
      }
    }
  }, { timeout: 60_000 });
  process.stdout.write(`${JSON.stringify({ mode: "applied", rows: summary }, null, 2)}\n`);
}

await prisma.$disconnect();
