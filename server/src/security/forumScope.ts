import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export interface ForumScope { scope_type: string; scope_key: string }
type Row = Record<string, unknown>;

export const forumSegment = (value: string): string => value.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function trustedForumIdentity(profile: Row | null, affiliation: Row | undefined, educationRecords: Row[]): {
  network: string; institute: string; degree: string; specialisation: string; year: string;
} {
  const verifiedAffiliation = affiliation?.verification_status === "VERIFIED" ? affiliation : undefined;
  const sourceEducationId = typeof verifiedAffiliation?.source_education_id === "string" ? verifiedAffiliation.source_education_id : "";
  const education = sourceEducationId ? educationRecords.find((row) => row.id === sourceEducationId
    && row.is_verified === true && (row.approval_status === "approved" || row.approval_status == null)) : undefined;
  return {
    network: String(verifiedAffiliation?.network_id ?? "IIT"),
    institute: String(verifiedAffiliation?.institute_id
      ?? forumSegment(String(verifiedAffiliation?.institute_name ?? profile?.iit_name ?? ""))),
    degree: String(verifiedAffiliation?.degree_id
      ?? forumSegment(String(verifiedAffiliation?.degree_name ?? education?.degree ?? ""))),
    specialisation: String(verifiedAffiliation?.specialisation_id
      ?? forumSegment(String(verifiedAffiliation?.specialisation_name ?? education?.branch_area ?? ""))),
    year: forumSegment(String(verifiedAffiliation?.graduation_year ?? education?.passing_year ?? "")),
  };
}

type ForumScopeClient = Pick<Prisma.TransactionClient, "profile" | "legacyRecord">;

export async function allowedForumScopes(
  userId: string,
  verified: boolean,
  role: string,
  client: ForumScopeClient = prisma,
): Promise<ForumScope[]> {
  if (!verified && role !== "admin" && role !== "owner") return [];
  const [profile, affiliations, educationRecords] = await Promise.all([
    client.profile.findUnique({ where: { user_id: userId } }),
    client.legacyRecord.findMany({ where: { table_name: "verified_academic_affiliations", owner_id: userId }, take: 20 }),
    client.legacyRecord.findMany({ where: { table_name: "education", owner_id: userId }, orderBy: { created_at: "desc" }, take: 20 }),
  ]);
  if (role !== "admin" && role !== "owner" && !profile?.is_verified) return [];
  const affiliation = affiliations.map((record) => record.data as Row).find((row) => row.verification_status === "VERIFIED");
  const identity = trustedForumIdentity(profile as unknown as Row | null, affiliation, educationRecords.map((record) => record.data as Row));
  const { network, institute, degree, specialisation, year } = identity;
  const result: ForumScope[] = [{ scope_type: "GLOBAL", scope_key: `${network}_ALL` }];
  if (institute) result.push({ scope_type: "CAMPUS", scope_key: institute });
  if (degree && specialisation) {
    const course = `${degree}_${specialisation}`;
    result.push({ scope_type: "COURSE_GLOBAL", scope_key: course });
    if (institute) result.push({ scope_type: "COURSE_CAMPUS", scope_key: `${institute}|${course}` });
  }
  if (year) {
    result.push({ scope_type: "BATCH_GLOBAL", scope_key: year });
    if (institute) result.push({ scope_type: "BATCH_CAMPUS", scope_key: `${institute}|${year}` });
  }
  if (degree && specialisation && year) {
    const cohort = `${degree}|${specialisation}|${year}`;
    result.push({ scope_type: "COHORT_GLOBAL", scope_key: cohort });
    if (institute) result.push({ scope_type: "COHORT", scope_key: `${institute}|${cohort}` });
  }
  return result;
}

export async function canUseForumScope(
  userId: string,
  verified: boolean,
  role: string,
  type: string,
  key: string,
  client: ForumScopeClient = prisma,
): Promise<boolean> {
  if (role === "admin" || role === "owner") return /^[A-Z_]{2,40}$/.test(type) && key.length > 0 && key.length <= 255;
  const scopes = await allowedForumScopes(userId, verified, role, client);
  return scopes.some((scope) => scope.scope_type === type.toUpperCase() && scope.scope_key === key);
}
