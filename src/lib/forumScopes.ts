export interface ForumScopeOption {
  id: string;
  type: string;
  key: string;
  label: string;
  scopeLabel?: string;
  subtitle?: string;
}

export interface ForumScope {
  id: string;
  type: string;
  key: string;
  label: string;
  subtitle?: string;
  emoji: string;
  section: "recommended" | "all" | "saved";
  hasToggle?: boolean;
  toggleOptions?: ForumScopeOption[];
}

export interface CanonicalAcademicIdentity {
  network_id: string;
  institute_id: string;
  institute_name: string;
  degree_id: string;
  degree_name: string;
  specialisation_id: string;
  specialisation_name: string;
  graduation_year: number;
  member_status: string;
}

type ForumProfile = { iit_name?: string | null } | null | undefined;
export type ForumEducation = {
  institution?: string | null;
  degree?: string | null;
  branch_area?: string | null;
  passing_year?: string | null;
} | null | undefined;

export const hasCompleteForumEducation = (education: ForumEducation) =>
  Boolean(
    education?.degree?.trim() &&
    education?.branch_area?.trim() &&
    education?.passing_year?.trim(),
  );

// Stable, query-safe identifiers let every matching user resolve to the same room
// without creating a duplicate database row on each login.
export const forumScopeSegment = (value: string) =>
  value.trim().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export const buildForumScopes = (
  profile: ForumProfile,
  education: ForumEducation,
  identity?: CanonicalAcademicIdentity | null,
): ForumScope[] => {
  const iit = identity?.institute_name || profile?.iit_name?.trim() || education?.institution?.trim() || "";
  const degree = identity?.degree_name || education?.degree?.trim() || "";
  const branch = identity?.specialisation_name || education?.branch_area?.trim() || "";
  const batch = String(identity?.graduation_year || education?.passing_year?.trim() || "");
  const networkCode = identity?.network_id || "IIT";
  const iitCode = identity?.institute_id || forumScopeSegment(iit);
  const scopes: ForumScope[] = [];

  if (iit) {
    scopes.push({ id: "campus", type: "CAMPUS", key: iitCode, label: "My Campus", subtitle: `${iit} · Students & Alumni`, emoji: "🏛️", section: "recommended" });
  }

  if (degree && branch) {
    const courseCode = `${identity?.degree_id || forumScopeSegment(degree)}_${identity?.specialisation_id || forumScopeSegment(branch)}`;
    scopes.push({
      id: "course", type: iit ? "COURSE_CAMPUS" : "COURSE_GLOBAL", key: iit ? `${iitCode}|${courseCode}` : courseCode,
      label: "My Course", subtitle: `${degree} · ${branch}`, emoji: "📖", section: "recommended",
      hasToggle: !!iit,
      toggleOptions: iit ? [
        { id: "course-campus", type: "COURSE_CAMPUS", key: `${iitCode}|${courseCode}`, label: "Campus", subtitle: `${iit} · ${degree} · ${branch}` },
        { id: "course-global", type: "COURSE_GLOBAL", key: courseCode, label: "All IITs", scopeLabel: `${degree} · ${branch}`, subtitle: "All IITs · Students & Alumni" },
      ] : undefined,
    });
  }

  if (batch) {
    const batchCode = forumScopeSegment(batch);
    scopes.push({
      id: "batch", type: iit ? "BATCH_CAMPUS" : "BATCH_GLOBAL", key: iit ? `${iitCode}|${batchCode}` : batchCode,
      label: "My Batch", subtitle: `Batch ${batch}`, emoji: "🎓", section: "recommended",
      hasToggle: !!iit,
      toggleOptions: iit ? [
        { id: "batch-campus", type: "BATCH_CAMPUS", key: `${iitCode}|${batchCode}`, label: "Campus", subtitle: `${iit} · Class of ${batch}` },
        { id: "batch-global", type: "BATCH_GLOBAL", key: batchCode, label: "All IITs", scopeLabel: `Class of ${batch}`, subtitle: "All IITs · Students & Alumni" },
      ] : undefined,
    });
  }

  if (degree && branch && batch) {
    const cohortGlobalKey = `${identity?.degree_id || forumScopeSegment(degree)}|${identity?.specialisation_id || forumScopeSegment(branch)}|${forumScopeSegment(batch)}`;
    if (iit) {
      const cohortKey = `${iitCode}|${cohortGlobalKey}`;
      scopes.push({
        id: "cohort", type: "COHORT", key: cohortKey,
        label: "My Cohort", subtitle: `${iit} · ${degree} · ${branch} · ${batch}`, emoji: "👥", section: "recommended",
        hasToggle: true,
        toggleOptions: [
          { id: "cohort-campus", type: "COHORT", key: cohortKey, label: "Campus", scopeLabel: "My Cohort", subtitle: `${iit} · ${degree} · ${branch} · ${batch}` },
          { id: "cohort-global", type: "COHORT_GLOBAL", key: cohortGlobalKey, label: "All IITs", scopeLabel: `${degree} · ${branch} · ${batch}`, subtitle: "All IITs · Students & Alumni" },
        ],
      });
    } else {
      scopes.push({ id: "cohort", type: "COHORT_GLOBAL", key: cohortGlobalKey, label: "My Cohort · All IITs", subtitle: `${degree} · ${branch} · ${batch} · All IITs`, emoji: "👥", section: "recommended" });
    }
  }

  scopes.push({ id: "global", type: "GLOBAL", key: `${networkCode}_ALL`, label: "Multiverse", subtitle: "All IITs · Students & Alumni", emoji: "🌐", section: "all" });
  return scopes;
};
