import { describe, expect, it } from "vitest";
import { isBlogLive } from "@/lib/blogVisibility";

describe("isBlogLive", () => {
  const now = new Date("2026-09-04T12:00:00.000Z").getTime();

  it("publishes a scheduled article only after its due time", () => {
    expect(isBlogLive({ published: true, status: "scheduled", scheduled_at: "2026-09-04T11:59:59.000Z" }, now)).toBe(true);
    expect(isBlogLive({ published: true, status: "scheduled", scheduled_at: "2026-09-04T12:00:01.000Z" }, now)).toBe(false);
  });

  it("never exposes drafts, disabled rows, or malformed schedules", () => {
    expect(isBlogLive({ published: true, status: "draft" }, now)).toBe(false);
    expect(isBlogLive({ published: false, status: "published" }, now)).toBe(false);
    expect(isBlogLive({ published: true, status: "scheduled", scheduled_at: "not-a-date" }, now)).toBe(false);
  });

  it("keeps compatible published rows live", () => {
    expect(isBlogLive({ published: true }, now)).toBe(true);
    expect(isBlogLive({ published: true, status: "published" }, now)).toBe(true);
  });
});
