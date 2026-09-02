import { describe, expect, it } from "vitest";
import {
  JOB_FRESHNESS_WINDOW_MS,
  parseFreshJobPostedAt,
} from "../../supabase/functions/_shared/jobFreshness";

describe("job freshness policy", () => {
  const now = Date.parse("2026-09-03T12:00:00.000Z");

  it("accepts an explicit timestamp within the last 24 hours", () => {
    expect(parseFreshJobPostedAt("2026-09-03T11:00:00.000Z", now))
      .toBe("2026-09-03T11:00:00.000Z");
  });

  it("accepts the exact 24-hour boundary", () => {
    const boundary = new Date(now - JOB_FRESHNESS_WINDOW_MS).toISOString();
    expect(parseFreshJobPostedAt(boundary, now)).toBe(boundary);
  });

  it.each([null, undefined, "", "not-a-date", "2026-09-01T11:59:59.000Z", "2026-09-03T12:06:00.000Z"])(
    "rejects missing, invalid, stale, or future values: %s",
    (value) => expect(parseFreshJobPostedAt(value, now)).toBeNull(),
  );
});
