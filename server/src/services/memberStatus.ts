import type { Prisma, PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.js";
import { prisma } from "../lib/prisma.js";
import { emitDbChange } from "../realtime/events.js";

type MemberStatusClient = Pick<PrismaClient, "profile" | "legacyRecord" | "$transaction">;
type Row = Record<string, unknown>;

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const BATCH_SIZE = 250;

export function alumniCutoffYear(asOf = new Date()): number {
  const ist = new Date(asOf.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  return ist.getUTCMonth() >= 6 ? year : year - 1;
}

export function shouldTransitionToAlumni(passingYear: unknown, asOf = new Date()): boolean {
  const raw = typeof passingYear === "number" ? passingYear : Number(String(passingYear ?? "").trim());
  return Number.isInteger(raw) && raw >= 1950 && raw <= alumniCutoffYear(asOf);
}

export function millisecondsUntilNextIstMidnight(asOf = new Date()): number {
  const ist = new Date(asOf.getTime() + IST_OFFSET_MS);
  const next = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - IST_OFFSET_MS;
  return Math.max(1_000, next - asOf.getTime());
}

export function alumniAffiliationData(value: Row, updatedAt: Date): Prisma.InputJsonValue {
  return {
    ...value,
    student_status: "alumni",
    member_status: "alumni",
    updated_at: updatedAt.toISOString(),
  } as Prisma.InputJsonValue;
}

export async function reconcileGraduatedMembers(
  client: MemberStatusClient = prisma,
  asOf = new Date(),
): Promise<{ scanned: number; updated: number }> {
  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;

  for (;;) {
    const profiles = await client.profile.findMany({
      where: { is_verified: true, student_status: "current_student", primary_education_id: { not: null } },
      select: { user_id: true, primary_education_id: true },
      orderBy: { user_id: "asc" },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { user_id: cursor }, skip: 1 } : {}),
    });
    if (!profiles.length) break;
    scanned += profiles.length;
    cursor = profiles[profiles.length - 1]!.user_id;

    const owners = profiles.map((profile) => profile.user_id);
    const education = await client.legacyRecord.findMany({
      where: { table_name: "education", owner_id: { in: owners } },
      select: { owner_id: true, data: true },
    });
    const primaryByUser = new Map(profiles.map((profile) => [profile.user_id, profile.primary_education_id]));
    const eligible = new Set(education.flatMap((record) => {
      const row = record.data as Row;
      const primaryId = record.owner_id ? primaryByUser.get(record.owner_id) : undefined;
      const trusted = row.is_verified === true && row.approval_status === "approved";
      return record.owner_id && primaryId === row.id && trusted && shouldTransitionToAlumni(row.passing_year, asOf)
        ? [record.owner_id]
        : [];
    }));

    if (eligible.size) {
      const userIds = [...eligible];
      const affiliations = await client.legacyRecord.findMany({
        where: { table_name: "verified_academic_affiliations", owner_id: { in: userIds } },
      });
      const verifiedAffiliations = affiliations.filter((record) => (record.data as Row).verification_status === "VERIFIED");
      const now = asOf.toISOString();
      await client.$transaction([
        client.profile.updateMany({
          where: { user_id: { in: userIds }, student_status: "current_student" },
          data: { student_status: "alumni" },
        }),
        ...verifiedAffiliations.map((record) => client.legacyRecord.update({
          where: { id: record.id },
          data: { data: alumniAffiliationData(record.data as Row, asOf) },
        })),
      ]);
      updated += userIds.length;
      for (const userId of userIds) {
        emitDbChange({ table: "profiles", event: "UPDATE", row: { user_id: userId, student_status: "alumni", updated_at: now }, audience_ids: [userId] });
      }
    }
    if (profiles.length < BATCH_SIZE) break;
  }

  return { scanned, updated };
}

export function startMemberStatusReconciliation(): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const result = await reconcileGraduatedMembers();
      if (result.updated) logger.info(result, "graduated members reconciled to alumni");
    } catch (error) {
      logger.error({ err: error }, "member status reconciliation failed");
    } finally {
      if (!disposed) {
        timer = setTimeout(() => void run(), millisecondsUntilNextIstMidnight());
        timer.unref();
      }
    }
  };
  void run();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
  };
}
