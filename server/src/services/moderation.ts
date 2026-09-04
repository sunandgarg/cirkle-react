import { ApiError } from "../lib/errors.js";

export type ModeratedProfileTable = "education" | "professional_experience";
export type ModerationRow = Record<string, unknown>;

export interface CatalogOption {
  id: string;
  category: string;
  value: string;
  status: "pending" | "approved" | "rejected";
  owner_id?: string | null;
}

interface ReferenceDefinition { option: string; category: string; value: string }

const references: Record<ModeratedProfileTable, ReferenceDefinition[]> = {
  education: [
    { option: "institution_option_id", category: "institution", value: "institution" },
    { option: "degree_option_id", category: "degree", value: "degree" },
    { option: "branch_option_id", category: "branch", value: "branch_area" },
    { option: "location_option_id", category: "location", value: "location" },
  ],
  professional_experience: [
    { option: "company_option_id", category: "company", value: "company_name" },
    { option: "location_option_id", category: "location", value: "location" },
  ],
};

const serverManaged = new Set(["is_verified", "approval_status", "reviewed_by", "reviewed_at", "review_notes"]);
const verifiedEducationIdentity = new Set([
  "institution", "degree", "branch_area", "passing_year", "location",
  "institution_option_id", "degree_option_id", "branch_option_id", "location_option_id",
]);

export function assertModeratedProfileWrite(
  table: ModeratedProfileTable,
  patch: ModerationRow,
  current: ModerationRow | undefined,
  admin: boolean,
): void {
  const managed = Object.keys(patch).filter((key) => serverManaged.has(key));
  if (managed.length) throw new ApiError(400, "moderation_field_managed", `${managed.join(", ")} can only be changed by an authorized moderation workflow`);
  if (current && patch.user_id !== undefined && patch.user_id !== current.user_id) {
    throw new ApiError(400, "education_owner_immutable", "The profile-entry owner cannot be changed");
  }
  if (table === "education" && current?.is_verified === true && !admin) {
    const changed = Object.keys(patch).some((key) => verifiedEducationIdentity.has(key) && patch[key] !== current[key]);
    if (changed) throw new ApiError(409, "verified_education_immutable", "Verified education cannot be edited");
  }
}

const optionalText = (row: ModerationRow, key: string, max: number): void => {
  const value = row[key];
  if (value != null && (typeof value !== "string" || value.trim().length > max)) {
    throw new ApiError(400, "invalid_profile_entry", `${key} is invalid`);
  }
};

const dateValue = (row: ModerationRow, key: string): string | null => {
  const value = row[key];
  if (value == null || value === "") return null;
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "invalid_profile_entry", `${key} must use YYYY-MM-DD format`);
  }
  return value;
};

export function validateModeratedProfileEntry(table: ModeratedProfileTable, row: ModerationRow): void {
  if (table === "education") {
    if (typeof row.institution !== "string" || !row.institution.trim() || row.institution.trim().length > 160) {
      throw new ApiError(400, "invalid_profile_entry", "institution is required");
    }
    optionalText(row, "degree", 160);
    optionalText(row, "branch_area", 160);
    optionalText(row, "location", 255);
    if (row.passing_year != null && row.passing_year !== "" && !/^\d{4}$/.test(String(row.passing_year))) {
      throw new ApiError(400, "invalid_profile_entry", "passing_year must contain four digits");
    }
  } else {
    if (typeof row.company_name !== "string" || !row.company_name.trim() || row.company_name.trim().length > 200) {
      throw new ApiError(400, "invalid_profile_entry", "company_name is required");
    }
    optionalText(row, "job_title", 200);
    optionalText(row, "location", 255);
    if (row.is_current != null && typeof row.is_current !== "boolean") throw new ApiError(400, "invalid_profile_entry", "is_current must be boolean");
    const start = dateValue(row, "start_date");
    const end = dateValue(row, "end_date");
    if (row.is_current === true && end) throw new ApiError(400, "invalid_profile_entry", "A current role cannot have an end date");
    if (start && end && end < start) throw new ApiError(400, "invalid_profile_entry", "end_date cannot be before start_date");
  }
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en") : "";
}

export function applyProfileEntryModeration(
  table: ModeratedProfileTable,
  input: ModerationRow,
  catalog: CatalogOption[],
  actorId: string,
): ModerationRow {
  const row = { ...input };
  const statuses: CatalogOption["status"][] = [];
  for (const reference of references[table]) {
    if (row[reference.option] != null && row[reference.option] !== "" && typeof row[reference.option] !== "string") {
      throw new ApiError(400, "invalid_catalog_reference", `${reference.option} must be a valid option ID`);
    }
    const explicitId = typeof row[reference.option] === "string" && row[reference.option] ? String(row[reference.option]) : undefined;
    let option = explicitId ? catalog.find((candidate) => candidate.id === explicitId) : undefined;
    if (explicitId && (!option || option.category !== reference.category)) {
      throw new ApiError(400, "invalid_catalog_reference", `${reference.option} does not reference a valid ${reference.category} option`);
    }
    if (!option) {
      const value = normalized(row[reference.value]);
      option = catalog
        .filter((candidate) => candidate.category === reference.category && normalized(candidate.value) === value
          && (candidate.status === "approved" || candidate.owner_id === actorId))
        .sort((left, right) => Number(right.status === "approved") - Number(left.status === "approved"))[0];
      if (option) row[reference.option] = option.id;
    }
    if (option) {
      statuses.push(option.status);
    } else if (normalized(row[reference.value])) {
      // A client-provided display value is not proof that it belongs to the
      // approved catalogue. The normal UI creates a pending CustomOption
      // first; older or modified clients that omit that reference must remain
      // owner-only instead of silently publishing unreviewed profile data.
      statuses.push("pending");
    }
  }
  row.approval_status = statuses.includes("rejected") ? "rejected" : statuses.includes("pending") ? "pending" : "approved";
  return row;
}

export function profileEntryVisible(row: ModerationRow, ownerId: string | null, viewerId: string, admin: boolean): boolean {
  return admin || ownerId === viewerId || row.approval_status === "approved" || row.approval_status == null;
}

export function moderationReferenceDefinitions(table: ModeratedProfileTable): readonly ReferenceDefinition[] {
  return references[table];
}
