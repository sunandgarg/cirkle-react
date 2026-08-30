import { describe, expect, it } from "vitest";
import { isEventFromInstitute, rankEventsForViewer } from "@/lib/eventRanking";

const events = [
  { id: "delhi-late", start_time: "2026-09-20T10:00:00Z", source_iit: "IIT Delhi" },
  { id: "bombay-first", start_time: "2026-09-02T10:00:00Z", source_iit: "IIT Bombay" },
  { id: "madras", start_time: "2026-09-03T10:00:00Z", source_iit: "IIT Madras" },
  { id: "delhi-first", start_time: "2026-09-01T10:00:00Z", source_iit: "IIT Delhi" },
  { id: "all", start_time: "2026-09-01T08:00:00Z", source_iit: null },
  { id: "bombay-late", start_time: "2026-09-12T10:00:00Z", source_iit: "IIT Bombay" },
];

describe("event feed ranking", () => {
  it("puts the viewer's IIT first and keeps each institute adjacent", () => {
    const ranked = rankEventsForViewer(events, "IIT Delhi", "viewer-month");
    expect(ranked.slice(0, 2).map((event) => event.id)).toEqual(["delhi-first", "delhi-late"]);
    expect(ranked[2].id).toBe("all");
    const bombayIndexes = ranked.map((event, index) => event.source_iit === "IIT Bombay" ? index : -1).filter((index) => index >= 0);
    expect(bombayIndexes[1] - bombayIndexes[0]).toBe(1);
  });

  it("personalizes the same events for another IIT", () => {
    const ranked = rankEventsForViewer(events, "IIT Bombay", "viewer-month");
    expect(ranked.slice(0, 2).map((event) => event.id)).toEqual(["bombay-first", "bombay-late"]);
    expect(isEventFromInstitute(ranked[0], "iit bombay")).toBe(true);
  });
});
