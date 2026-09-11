export type RankableEvent = {
  id: string;
  start_time: string;
  source_iit?: string | null;
  target_iits?: string[] | null;
};

export type EventSortDirection = "ascending" | "descending";

export type EventDateGroup<T extends RankableEvent> = {
  dateKey: string;
  events: T[];
};

export const EVENT_TIME_ZONE = "Asia/Kolkata";

const normalize = (value?: string | null) => value?.trim().toLocaleLowerCase("en-IN") || "";

const calendarPartsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const parsedTime = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** Returns a stable YYYY-MM-DD key in Cirkle's operating timezone. */
export const eventDateKey = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = calendarPartsFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
};

export const eventMonthKey = (value: string | Date) => eventDateKey(value)?.slice(0, 7) ?? null;

export const eventDateFromKey = (key: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) || eventDateKey(date) !== key ? null : date;
};

export const shiftEventMonth = (monthKey: string, amount: number) => {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isInteger(year) || monthIndex < 0 || monthIndex > 11 || !Number.isInteger(amount)) return null;
  const shifted = new Date(Date.UTC(year, monthIndex + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const eventMonthGrid = (monthKey: string) => {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return null;
  return {
    leadingDays: new Date(Date.UTC(year, month - 1, 1)).getUTCDay(),
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
};

const viewerPriority = (event: RankableEvent, viewerIit?: string | null) => isEventFromInstitute(event, viewerIit) ? 0 : 1;

/**
 * Sorts the whole feed by start time. Institute relevance is deliberately only
 * a same-instant tie-breaker, so campus grouping can never produce Sep 2,
 * Sep 23, Sep 2 ordering again.
 */
export const sortEventsChronologically = <T extends RankableEvent>(
  events: readonly T[],
  viewerIit?: string | null,
  direction: EventSortDirection = "ascending",
) => [...events].sort((left, right) => {
  const leftTime = parsedTime(left.start_time);
  const rightTime = parsedTime(right.start_time);

  // Invalid legacy values are deterministic and remain at the end in either view.
  if (leftTime === null && rightTime === null) return left.id.localeCompare(right.id);
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;

  const chronological = direction === "ascending" ? leftTime - rightTime : rightTime - leftTime;
  return chronological
    || viewerPriority(left, viewerIit) - viewerPriority(right, viewerIit)
    || normalize(left.source_iit).localeCompare(normalize(right.source_iit), "en-IN")
    || left.id.localeCompare(right.id);
});

/** Groups an already filtered view into deterministic chronological date sections. */
export const groupEventsByDate = <T extends RankableEvent>(
  events: readonly T[],
  viewerIit?: string | null,
  direction: EventSortDirection = "ascending",
): EventDateGroup<T>[] => {
  const groups = new Map<string, T[]>();
  for (const event of sortEventsChronologically(events, viewerIit, direction)) {
    const key = eventDateKey(event.start_time) ?? "invalid";
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups].map(([dateKey, groupedEvents]) => ({ dateKey, events: groupedEvents }));
};

/** @deprecated Use sortEventsChronologically. Kept for callers during rollout. */
export const rankEventsForViewer = <T extends RankableEvent>(events: readonly T[], viewerIit?: string | null) =>
  sortEventsChronologically(events, viewerIit, "ascending");

export const isEventFromInstitute = (event: RankableEvent, institute?: string | null) => {
  if (!institute) return false;
  if (event.source_iit) return normalize(event.source_iit) === normalize(institute);
  return (event.target_iits || []).some((iit) => normalize(iit) === normalize(institute));
};
