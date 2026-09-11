import { describe, expect, it } from "vitest";
import {
  eventDateFromKey,
  eventDateKey,
  eventMonthGrid,
  eventMonthKey,
  groupEventsByDate,
  isEventFromInstitute,
  rankEventsForViewer,
  shiftEventMonth,
  sortEventsChronologically,
} from "@/lib/eventRanking";

const events = [
  { id: "delhi-late", start_time: "2026-09-20T10:00:00Z", source_iit: "IIT Delhi" },
  { id: "bombay-first", start_time: "2026-09-02T10:00:00Z", source_iit: "IIT Bombay" },
  { id: "madras", start_time: "2026-09-03T10:00:00Z", source_iit: "IIT Madras" },
  { id: "delhi-first", start_time: "2026-09-01T10:00:00Z", source_iit: "IIT Delhi" },
  { id: "all", start_time: "2026-09-01T08:00:00Z", source_iit: null },
  { id: "bombay-late", start_time: "2026-09-12T10:00:00Z", source_iit: "IIT Bombay" },
];

describe("event chronology", () => {
  it("sorts the complete feed by time instead of creating campus blocks", () => {
    const ranked = sortEventsChronologically(events, "IIT Delhi");
    expect(ranked.map((event) => event.id)).toEqual([
      "all",
      "delhi-first",
      "bombay-first",
      "madras",
      "bombay-late",
      "delhi-late",
    ]);
    expect(ranked.map((event) => event.id)).not.toEqual(events.map((event) => event.id));
    expect(events[0].id).toBe("delhi-late");
  });

  it("uses campus relevance only when start instants are identical", () => {
    const sameStart = [
      { id: "bombay", start_time: "2026-09-02T10:00:00Z", source_iit: "IIT Bombay" },
      { id: "delhi-z", start_time: "2026-09-02T10:00:00Z", source_iit: "IIT Delhi" },
      { id: "delhi-a", start_time: "2026-09-02T10:00:00Z", source_iit: "IIT Delhi" },
    ];
    expect(sortEventsChronologically(sameStart, "IIT Delhi").map((event) => event.id)).toEqual(["delhi-a", "delhi-z", "bombay"]);
    expect(isEventFromInstitute(sameStart[1], "iit delhi")).toBe(true);
  });

  it("shows past events newest first and keeps invalid legacy dates at the end", () => {
    const past = [
      { id: "oldest", start_time: "2026-08-01T10:00:00Z" },
      { id: "invalid", start_time: "not-a-date" },
      { id: "newest", start_time: "2026-08-30T10:00:00Z" },
    ];
    expect(sortEventsChronologically(past, null, "descending").map((event) => event.id)).toEqual(["newest", "oldest", "invalid"]);
  });

  it("keeps the backwards-compatible ranking entry point chronological", () => {
    expect(rankEventsForViewer(events, "IIT Delhi").map((event) => event.id))
      .toEqual(sortEventsChronologically(events, "IIT Delhi").map((event) => event.id));
  });
});

describe("event dates in the Cirkle timezone", () => {
  it("uses the IST date around the UTC midnight boundary", () => {
    expect(eventDateKey("2026-09-01T18:29:59Z")).toBe("2026-09-01");
    expect(eventDateKey("2026-09-01T18:30:00Z")).toBe("2026-09-02");
    expect(eventDateKey("2026-09-01T23:45:00-07:00")).toBe("2026-09-02");
    expect(eventMonthKey("2026-08-31T20:00:00Z")).toBe("2026-09");
  });

  it("groups by the same IST key used by calendar chips and retains order within a day", () => {
    const grouped = groupEventsByDate([
      { id: "sep-two-late", start_time: "2026-09-02T15:00:00+05:30" },
      { id: "sep-one", start_time: "2026-09-01T18:29:59Z" },
      { id: "sep-two-early", start_time: "2026-09-01T18:30:00Z" },
    ]);
    expect(grouped.map((group) => group.dateKey)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(grouped[1].events.map((event) => event.id)).toEqual(["sep-two-early", "sep-two-late"]);
  });

  it("builds and shifts Gregorian month grids without browser timezone math", () => {
    expect(eventMonthGrid("2026-09")).toEqual({ leadingDays: 2, daysInMonth: 30 });
    expect(eventMonthGrid("2028-02")).toEqual({ leadingDays: 2, daysInMonth: 29 });
    expect(shiftEventMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftEventMonth("2026-12", 1)).toBe("2027-01");
    expect(eventDateKey(eventDateFromKey("2026-09-02")!)).toBe("2026-09-02");
  });
});
