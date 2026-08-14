import { describe, expect, it } from "vitest";
import { buildForumScopes, forumScopeSegment, hasCompleteForumEducation } from "@/lib/forumScopes";

describe("automatic forum groups", () => {
  it("creates the complete IIT Delhi MBA General 2026 group set", () => {
    const scopes = buildForumScopes(
      { iit_name: "IIT Delhi" },
      { institution: "IIT Delhi", degree: "MBA", branch_area: "General", passing_year: "2026" },
    );

    expect(scopes.map(({ id, label, subtitle }) => ({ id, label, subtitle }))).toEqual([
      { id: "campus", label: "My Campus", subtitle: "IIT Delhi · Students & Alumni" },
      { id: "course", label: "My Course", subtitle: "MBA · General" },
      { id: "batch", label: "My Batch", subtitle: "Batch 2026" },
      { id: "cohort", label: "My Cohort", subtitle: "IIT Delhi · MBA · General · 2026" },
      { id: "global", label: "Multiverse", subtitle: "All IITs · Students & Alumni" },
    ]);

    expect(scopes.find((scope) => scope.id === "course")?.toggleOptions?.map((option) => option.label)).toEqual(["Campus", "All IITs"]);
    expect(scopes.find((scope) => scope.id === "batch")?.toggleOptions?.map((option) => option.label)).toEqual(["Campus", "All IITs"]);
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

  it("separates campus, course, batch, and cohort membership correctly", () => {
    const scopesFor = (iit: string, degree: string, branch: string, year: string) =>
      buildForumScopes(
        { iit_name: iit },
        { institution: iit, degree, branch_area: branch, passing_year: year },
      );
    const optionKey = (scopes: ReturnType<typeof scopesFor>, scopeId: string, option: string) =>
      scopes.find((scope) => scope.id === scopeId)?.toggleOptions?.find((item) => item.label === option)?.key;

    const delhiBtech = scopesFor("IIT Delhi", "BTech", "General", "2026");
    const delhiMba = scopesFor("IIT Delhi", "MBA", "General", "2026");
    const bombayBtech = scopesFor("IIT Bombay", "BTech", "General", "2026");

    expect(delhiBtech.find((scope) => scope.id === "campus")?.key).toBe(delhiMba.find((scope) => scope.id === "campus")?.key);
    expect(optionKey(delhiBtech, "course", "Campus")).not.toBe(optionKey(delhiMba, "course", "Campus"));
    expect(optionKey(delhiBtech, "batch", "Campus")).toBe(optionKey(delhiMba, "batch", "Campus"));
    expect(optionKey(delhiBtech, "course", "All IITs")).toBe(optionKey(bombayBtech, "course", "All IITs"));
    expect(optionKey(delhiBtech, "batch", "All IITs")).toBe(optionKey(bombayBtech, "batch", "All IITs"));
    expect(optionKey(delhiBtech, "cohort", "All IITs")).toBe(optionKey(bombayBtech, "cohort", "All IITs"));
    expect(optionKey(delhiBtech, "cohort", "Campus")).not.toBe(optionKey(bombayBtech, "cohort", "Campus"));
  });

  it("does not expose incomplete profile-specific rooms", () => {
    expect(buildForumScopes({ iit_name: "IIT Delhi" }, null).map((scope) => scope.id)).toEqual(["campus", "global"]);
    expect(hasCompleteForumEducation({ degree: "MBA", branch_area: null, passing_year: "2026" })).toBe(false);
    expect(hasCompleteForumEducation({ degree: "MBA", branch_area: "General", passing_year: "2026" })).toBe(true);
  });

  it("uses the locked canonical identity instead of later profile edits", () => {
    const scopes = buildForumScopes(
      { iit_name: "IIT Bombay" },
      { degree: "MBA", branch_area: "Finance", passing_year: "2028" },
      {
        network_id: "IIT", institute_id: "IIT_DELHI", institute_name: "IIT Delhi",
        degree_id: "BTECH", degree_name: "BTech", specialisation_id: "GENERAL",
        specialisation_name: "General", graduation_year: 2026, member_status: "current_student",
      },
    );
    expect(scopes.find((scope) => scope.id === "campus")?.key).toBe("IIT_DELHI");
    expect(scopes.find((scope) => scope.id === "course")?.key).toBe("IIT_DELHI|BTECH_GENERAL");
    expect(scopes.find((scope) => scope.id === "cohort")?.key).toBe("IIT_DELHI|BTECH|GENERAL|2026");
  });
});
