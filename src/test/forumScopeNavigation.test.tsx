import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScopeNavigationItem from "@/components/forum/ScopeNavigationItem";
import type { ForumScope } from "@/lib/forumScopes";

const cohortScope: ForumScope = {
  id: "cohort",
  type: "COHORT",
  key: "IIT_DELHI|MBA|GENERAL|2026",
  label: "My Cohort",
  subtitle: "IIT Delhi · MBA · General · 2026",
  emoji: "👥",
  section: "recommended",
  hasToggle: true,
  toggleOptions: [
    { id: "cohort-campus", type: "COHORT", key: "IIT_DELHI|MBA|GENERAL|2026", label: "Campus" },
    { id: "cohort-global", type: "COHORT_GLOBAL", key: "MBA|GENERAL|2026", label: "All IITs" },
  ],
};

describe("forum grouped-room navigation", () => {
  it("expands My Cohort without changing chat, then waits for a room choice", () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <ScopeNavigationItem
        scope={cohortScope}
        activeScope={{ type: "GLOBAL", key: "IIT_ALL" }}
        unreadDots={{}}
        onSelect={onSelect}
        onToggle={onToggle}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /my cohort/i }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: /choose my cohort room/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Campus" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All IITs" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "All IITs" }));
    expect(onToggle).toHaveBeenCalledWith("cohort", 1);
  });

  it("continues to open a normal single room directly", () => {
    const onSelect = vi.fn();
    render(
      <ScopeNavigationItem
        scope={{ id: "campus", type: "CAMPUS", key: "IIT_DELHI", label: "My Campus", emoji: "🏛️", section: "recommended" }}
        activeScope={{ type: "GLOBAL", key: "IIT_ALL" }}
        unreadDots={{}}
        onSelect={onSelect}
        onToggle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /my campus/i }));
    expect(onSelect).toHaveBeenCalledWith("CAMPUS", "IIT_DELHI");
  });
});
