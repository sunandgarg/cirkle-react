import { describe, expect, it, vi } from "vitest";
import {
  collectNetworkMemberPages,
  memberMatchesNetworkSearch,
  pageCount,
  resolveNetworkTab,
  type NetworkMember,
} from "@/lib/networkDiscovery";

describe("network discovery", () => {
  it("maps route aliases while allowing a valid tab query to override them", () => {
    expect(resolveNetworkTab("/network/connections", null)).toBe("connected");
    expect(resolveNetworkTab("/network/suggestions", null)).toBe("discover");
    expect(resolveNetworkTab("/network/connections", "pending")).toBe("pending");
    expect(resolveNetworkTab("/network", "not-a-tab")).toBe("explore");
  });

  it("searches every field promised by the member-search UI", () => {
    const member: NetworkMember = {
      user_id: "member-1",
      name: "Priya Shah",
      headline: "Climate founder",
      iit_name: "IIT Bombay",
      student_status: "Class of 2024",
      location: "Pune",
      skills: ["React", "Carbon accounting"],
      expertise: ["Fundraising"],
    };
    expect(memberMatchesNetworkSearch(member, "priya climate")).toBe(true);
    expect(memberMatchesNetworkSearch(member, "iit bombay 2024")).toBe(true);
    expect(memberMatchesNetworkSearch(member, "pune react")).toBe(true);
    expect(memberMatchesNetworkSearch(member, "carbon fundraising")).toBe(true);
    expect(memberMatchesNetworkSearch(member, "quantum")).toBe(false);
  });

  it("continues through every server page instead of truncating discovery", async () => {
    const rows = Array.from({ length: 521 }, (_, index) => ({ user_id: `member-${index}` }));
    const fetchPage = vi.fn(async (from: number, to: number) => ({ rows: rows.slice(from, to + 1), count: rows.length }));

    const result = await collectNetworkMemberPages(fetchPage, 200);

    expect(result).toHaveLength(521);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 400, 599);
    expect(pageCount(result.length, 48)).toBe(11);
  });
});
