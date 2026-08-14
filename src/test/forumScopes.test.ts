import { describe, expect, it } from "vitest";
import { buildForumScopes, forumScopeSegment, hasCompleteForumEducation } from "@/lib/forumScopes";

describe("automatic forum groups", () => {
  it("creates the complete IIT Delhi MBA General 2026 group set", () => {
    const scopes = buildForumScopes(
      { iit_name: "IIT Delhi" },
      { institution: "IIT Delhi", degree: "MBA", branch_area: "General", passing_year: "2026" },
    );

    expect(scopes.map(({ id, label, subtitle }) => ({ id, label, subtitle }))).toEqual([
      { id: "campus", label: "My Campus", subtitle: "IIT Delhi · All batches" },
      { id: "course", label: "My Course", subtitle: "MBA · General" },
      { id: "batch", label: "My Batch", subtitle: "Batch 2026" },
      { id: "cohort", label: "My Cohort", subtitle: "IIT Delhi · MBA · General · 2026" },
      { id: "global", label: "Multiverse", subtitle: "All 23 IITs · Everyone" },
    ]);

    expect(scopes.find((scope) => scope.id === "course")?.toggleOptions?.map((option) => option.label)).toEqual(["Campus", "Global"]);
    expect(scopes.find((scope) => scope.id === "batch")?.toggleOptions?.map((option) => option.label)).toEqual(["Campus", "Global"]);
    expect(scopes.find((scope) => scope.id === "cohort")?.toggleOptions?.map((option) => option.label)).toEqual(["Campus", "All IITs"]);
  });

  it("uses deterministic keys so matching profiles enter the same rooms", () => {
    const scopes = buildForumScopes(
      { iit_name: "IIT Delhi" },
      { degree: "MBA", branch_area: "General", passing_year: "2026" },
    );
    expect(scopes.find((scope) => scope.id === "course")?.key).toBe("IIT_DELHI|MBA_GENERAL");
    expect(scopes.find((scope) => scope.id === "cohort")?.key).toBe("IIT_DELHI|MBA|GENERAL|2026");
    expect(forumScopeSegment("IIT Dhanbad (ISM)")).toBe("IIT_DHANBAD_ISM");
  });

  it("does not expose incomplete profile-specific rooms", () => {
    expect(buildForumScopes({ iit_name: "IIT Delhi" }, null).map((scope) => scope.id)).toEqual(["campus", "global"]);
    expect(hasCompleteForumEducation({ degree: "MBA", branch_area: null, passing_year: "2026" })).toBe(false);
    expect(hasCompleteForumEducation({ degree: "MBA", branch_area: "General", passing_year: "2026" })).toBe(true);
  });
});
