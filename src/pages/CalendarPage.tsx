import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Calendar as CalendarIcon, Check, ChevronLeft, ChevronRight, Clock, ExternalLink, Globe2, MapPin, Settings2, Sparkles, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import EmptyState from "@/components/EmptyState";
import OwnedPageScrollRegion from "@/components/OwnedPageScrollRegion";
import { SharedTopPageChrome } from "@/contexts/PageChromeContext";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";
import { EVENT_TIME_ZONE, eventDateFromKey, eventDateKey, eventMonthGrid, eventMonthKey, groupEventsByDate, isEventFromInstitute, shiftEventMonth, sortEventsChronologically } from "@/lib/eventRanking";
import { safeHttpUrl } from "@/lib/safeUrl";

type EventRow = Database["public"]["Tables"]["events"]["Row"];
type RsvpStatus = "going" | "not_going";

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: EVENT_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

const timeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: EVENT_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

const dateGroupFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: EVENT_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

const monthYearFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: EVENT_TIME_ZONE,
  month: "long",
  year: "numeric",
});

const monthFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: EVENT_TIME_ZONE,
  month: "long",
});

const shortMonthFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: EVENT_TIME_ZONE, month: "short" });
const dayFormatter = new Intl.DateTimeFormat("en-IN", { timeZone: EVENT_TIME_ZONE, day: "numeric" });

const parsedDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const eventCampusLabel = (event: EventRow) => event.source_iit?.trim() || "Cross-IIT / National";

const audienceLabel = (event: EventRow) => {
  if (!event.audience_mode || event.audience_mode === "everyone") return "All IITians";
  const targets = [...(event.target_iits || []), ...(event.target_courses || []), ...(event.target_specialisations || [])];
  return targets.length ? targets.slice(0, 3).join(" · ") + (targets.length > 3 ? ` +${targets.length - 3}` : "") : "Selected IITians";
};

const eventContextLabel = (event: EventRow) => {
  if (event.audience_mode === "targeted") return "Curated event";
  return event.source_iit ? "Campus event" : "All-IIT event";
};

const formatEventSchedule = (event: EventRow) => {
  const start = parsedDate(event.start_time);
  if (!start) return "Schedule to be confirmed";
  const end = event.end_time ? parsedDate(event.end_time) : null;
  if (!end) return dateTimeFormatter.format(start);
  return eventDateKey(start) === eventDateKey(end)
    ? `${dateTimeFormatter.format(start)} – ${timeFormatter.format(end)}`
    : `${dateTimeFormatter.format(start)} – ${dateTimeFormatter.format(end)}`;
};

const formatDateGroup = (key: string) => {
  const date = eventDateFromKey(key);
  return date ? dateGroupFormatter.format(date) : "Date to be confirmed";
};

const formatMonthKey = (key: string) => {
  const date = eventDateFromKey(`${key}-01`);
  return date ? monthYearFormatter.format(date) : "Events";
};

const formatMonthName = (key: string) => {
  const date = eventDateFromKey(`${key}-01`);
  return date ? monthFormatter.format(date) : "Current";
};

type EventCardProps = {
  event: EventRow;
  focused?: boolean;
  response?: string;
  isUpdating?: boolean;
  onRespond: (eventId: string, status: RsvpStatus) => void;
};

export const EventCard = ({ event, focused = false, response, isUpdating = false, onRespond }: EventCardProps) => {
  const startsAt = parsedDate(event.start_time);
  const registrationUrl = safeHttpUrl(event.registration_url);
  const safeId = event.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  const campusId = `event-campus-${safeId}`;
  const titleId = `event-title-${safeId}`;

  return (
    <article
      id={`event-${event.id}`}
      aria-labelledby={`${campusId} ${titleId}`}
      className={`rounded-3xl border bg-card p-4 shadow-sm transition-shadow hover:shadow-md sm:p-5 ${focused ? "border-primary ring-2 ring-primary/25" : "border-border"}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300" aria-hidden="true">
            <Building2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">Hosting campus</p>
            <p id={campusId} className="truncate text-sm font-extrabold text-foreground">{eventCampusLabel(event)}</p>
          </div>
        </div>
        {startsAt ? (
          <time dateTime={event.start_time} aria-label={dateTimeFormatter.format(startsAt)} className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-primary/10 text-primary">
            <span className="text-[9px] font-bold uppercase tracking-wide">{shortMonthFormatter.format(startsAt)}</span>
            <span className="text-lg font-black leading-none">{dayFormatter.format(startsAt)}</span>
          </time>
        ) : null}
      </header>

      <div className="pt-3">
        <h4 id={titleId} className="text-base font-extrabold leading-snug text-foreground">{event.title}</h4>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-[11px] font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" aria-hidden="true" />{formatEventSchedule(event)} <span className="sr-only">India Standard Time</span></span>
          {event.location ? <span className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{event.location}</span> : null}
        </div>
        {event.organizer ? <p className="mt-2 text-[11px] text-muted-foreground">Organised by <span className="font-semibold text-foreground">{event.organizer}</span></p> : null}
      </div>

      {event.description ? <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{event.description}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="Event context">
        <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-[10px] font-bold text-secondary-foreground"><CalendarIcon className="h-3 w-3" aria-hidden="true" />{eventContextLabel(event)}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-semibold text-primary">{event.audience_mode === "everyone" ? <Globe2 className="h-3 w-3" aria-hidden="true" /> : <Users className="h-3 w-3" aria-hidden="true" />}{audienceLabel(event)}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-3">
        <Button size="sm" variant={response === "going" ? "default" : "outline"} className="h-10 rounded-xl" disabled={isUpdating} aria-label={`${response === "going" ? "Remove going response for" : "Mark as going for"} ${event.title}`} onClick={() => onRespond(event.id, "going")}>
          {response === "going" ? <><Check className="h-4 w-4" aria-hidden="true" /> Going</> : "I'm going"}
        </Button>
        {registrationUrl ? (
          <a href={registrationUrl} target="_blank" rel="noopener noreferrer" aria-label={`Register for ${event.title} (opens in a new tab)`} className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-secondary text-xs font-semibold text-foreground">Register <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
        ) : (
          <Button size="sm" variant={response === "not_going" ? "secondary" : "ghost"} className="h-10 rounded-xl" disabled={isUpdating} aria-label={`${response === "not_going" ? "Remove not interested response for" : "Mark as not interested in"} ${event.title}`} onClick={() => onRespond(event.id, "not_going")}>Not for me</Button>
        )}
      </div>
    </article>
  );
};

const CalendarPage = () => {
  const { user, isAdmin, profile } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [currentMonth, setCurrentMonth] = useState(() => eventMonthKey(new Date()) || "1970-01");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [view, setView] = useState<"upcoming" | "going" | "past">("upcoming");
  const requestedEventId = searchParams.get("event") || "";
  const focusedEventId = /^[a-zA-Z0-9_-]{1,100}$/.test(requestedEventId) ? requestedEventId : "";

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events", user?.id],
    queryFn: async (): Promise<EventRow[]> => {
      if (!user) return [];
      const current = await supabase.from("events").select("*").eq("status", "published").order("start_time", { ascending: true }).limit(500);
      if (!current.error) return (current.data ?? []) as EventRow[];
      // Keep the Events page available while a new frontend waits for its matching migration.
      const legacy = await supabase.from("events").select("*").order("start_time", { ascending: true }).limit(500);
      if (legacy.error) throw current.error;
      return (legacy.data ?? []) as EventRow[];
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const { data: focusedEvent, isFetched: focusedEventFetched } = useQuery({
    queryKey: ["event-deep-link", user?.id, focusedEventId],
    queryFn: async (): Promise<EventRow | null> => {
      const { data, error } = await supabase.from("events").select("*").eq("id", focusedEventId).maybeSingle();
      if (error) throw error;
      return (data as EventRow | null) ?? null;
    },
    enabled: !!user && !!focusedEventId,
    retry: false,
  });

  const displayedEvents = useMemo(() => focusedEvent && !events.some((event) => event.id === focusedEvent.id)
    ? [focusedEvent, ...events]
    : events, [events, focusedEvent]);

  useEffect(() => {
    if (!focusedEvent) return;
    const startsAt = parsedDate(focusedEvent.start_time);
    if (!startsAt) return;
    const focusedMonth = eventMonthKey(startsAt);
    if (focusedMonth) setCurrentMonth(focusedMonth);
    setSelectedDate(eventDateKey(startsAt));
    setView(new Date(focusedEvent.end_time || focusedEvent.start_time).getTime() < Date.now() ? "past" : "upcoming");
    if (isLoading) return;
    const timer = window.setTimeout(() => document.getElementById(`event-${focusedEvent.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return () => window.clearTimeout(timer);
  }, [focusedEvent, isLoading]);

  const { data: myRsvps = {} } = useQuery({
    queryKey: ["my-rsvps", user?.id],
    queryFn: async () => {
      if (!user) return {};
      const { data, error } = await supabase.from("rsvps").select("event_id, status").eq("user_id", user.id);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((item) => [item.event_id, item.status])) as Record<string, string>;
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  const rsvp = useMutation({
    mutationFn: async ({ eventId, status }: { eventId: string; status: RsvpStatus }) => {
      if (!user) throw new Error("Sign in to RSVP.");
      if (myRsvps[eventId] === status) {
        const { error } = await supabase.from("rsvps").delete().eq("event_id", eventId).eq("user_id", user.id);
        if (error) throw error;
        return null;
      }
      const { error } = await supabase.from("rsvps").upsert({ event_id: eventId, user_id: user.id, status }, { onConflict: "event_id,user_id" });
      if (error) throw error;
      return status;
    },
    onSuccess: (status) => {
      void queryClient.invalidateQueries({ queryKey: ["my-rsvps", user?.id] });
      toast.success(status === "going" ? "Added to your events" : status === "not_going" ? "Response saved" : "RSVP removed");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const now = Date.now();
  const filteredByView = displayedEvents.filter((event) => {
    const endTime = Date.parse(event.end_time || event.start_time);
    const isPast = Number.isFinite(endTime) && endTime < now;
    if (view === "past") return isPast;
    if (view === "going") return !isPast && myRsvps[event.id] === "going";
    return !isPast;
  });

  const viewerIit = profile?.iit_name;
  const upcoming = sortEventsChronologically(
    displayedEvents.filter((event) => {
      const endTime = Date.parse(event.end_time || event.start_time);
      return Number.isFinite(endTime) && endTime >= now;
    }),
    viewerIit,
  );
  const nextEvent = upcoming[0];
  const calendarGrid = eventMonthGrid(currentMonth) || { leadingDays: 0, daysInMonth: 31 };
  const todayKey = eventDateKey(new Date());
  const days = Array.from({ length: calendarGrid.daysInMonth }, (_, index) => index + 1);
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, EventRow[]>();
    for (const event of displayedEvents) {
      const dateKey = eventDateKey(event.start_time);
      if (!dateKey) continue;
      const entries = grouped.get(dateKey) ?? [];
      entries.push(event);
      grouped.set(dateKey, entries);
    }
    return grouped;
  }, [displayedEvents]);
  const eventsOnDate = (dateKey: string) => eventsByDate.get(dateKey) ?? [];
  const listEvents = filteredByView.filter((event) => selectedDate
    ? eventDateKey(event.start_time) === selectedDate
    : eventMonthKey(event.start_time) === currentMonth);
  const listEventGroups = groupEventsByDate(listEvents, viewerIit, view === "past" ? "descending" : "ascending");

  return (
    <OwnedPageScrollRegion data-testid="events-scroll-region" className="bg-background">
      <SharedTopPageChrome />
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 px-4 py-3 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <div>
            <h1 className="text-lg font-bold text-foreground">Events</h1>
            <p className="text-xs text-muted-foreground">In date order · hosting campus shown first</p>
          </div>
          {isAdmin ? <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate("/admin")}><Settings2 className="h-4 w-4" /> Manage</Button> : null}
        </div>
      </header>

      <div data-page-scroll-content="true" className="mx-auto max-w-3xl space-y-5 px-4 py-4 pb-24">
        {focusedEventId && focusedEventFetched && !focusedEvent ? <div role="status" className="rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">That event is no longer available to your profile.</div> : null}

        {nextEvent ? (
          <section aria-labelledby="next-event-title" className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/90 to-violet-600 p-5 text-primary-foreground shadow-lg shadow-primary/15">
            <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-white/10" />
            <div className="relative">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.14em] text-white"><Building2 className="h-3.5 w-3.5" aria-hidden="true" />{eventCampusLabel(nextEvent)}</span>
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white/75"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{isEventFromInstitute(nextEvent, viewerIit) ? "From your campus" : "Next for you"}</span>
              </div>
              <h2 id="next-event-title" className="mt-3 max-w-lg text-xl font-black leading-tight">{nextEvent.title}</h2>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-white/85">
                <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" aria-hidden="true" />{formatEventSchedule(nextEvent)} <span className="sr-only">India Standard Time</span></span>
                {nextEvent.location ? <span className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{nextEvent.location}</span> : null}
              </div>
              <div className="mt-5 flex items-center justify-between gap-3">
                <span className="rounded-full bg-white/15 px-3 py-1.5 text-[11px] font-semibold backdrop-blur"><Users className="mr-1 inline h-3 w-3" aria-hidden="true" />{audienceLabel(nextEvent)}</span>
                <Button size="sm" variant="secondary" className="rounded-full font-bold" disabled={rsvp.isPending} onClick={() => rsvp.mutate({ eventId: nextEvent.id, status: "going" })}>{myRsvps[nextEvent.id] === "going" ? <><Check className="h-4 w-4" /> Going</> : "I'm interested"}</Button>
              </div>
            </div>
          </section>
        ) : null}

        <div className="grid grid-cols-3 gap-2 rounded-2xl bg-secondary/70 p-1.5" role="group" aria-label="Event view">
          {(["upcoming", "going", "past"] as const).map((item) => <button key={item} aria-pressed={view === item} onClick={() => { setView(item); setSelectedDate(null); }} className={`h-10 rounded-xl text-xs font-bold capitalize transition-all ${view === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{item}{item === "going" && Object.values(myRsvps).filter((status) => status === "going").length ? ` (${Object.values(myRsvps).filter((status) => status === "going").length})` : ""}</button>)}
        </div>

        <section aria-label="Event calendar" className="rounded-3xl border border-border bg-card p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between">
            <button aria-label="Previous month" onClick={() => { setCurrentMonth((month) => shiftEventMonth(month, -1) || month); setSelectedDate(null); }} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-secondary"><ChevronLeft className="h-5 w-5" /></button>
            <button aria-label={`Return to current month; showing ${formatMonthKey(currentMonth)}`} onClick={() => { setCurrentMonth(eventMonthKey(new Date()) || currentMonth); setSelectedDate(null); }} className="text-sm font-bold">{formatMonthKey(currentMonth)}</button>
            <button aria-label="Next month" onClick={() => { setCurrentMonth((month) => shiftEventMonth(month, 1) || month); setSelectedDate(null); }} className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-secondary"><ChevronRight className="h-5 w-5" /></button>
          </div>
          <div className="mb-1 grid grid-cols-7 gap-1">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <div key={`${day}-${index}`} aria-hidden="true" className="py-1 text-center text-[10px] font-bold text-muted-foreground">{day}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: calendarGrid.leadingDays }).map((_, index) => <div key={`padding-${index}`} />)}
            {days.map((day) => {
              const dayKey = `${currentMonth}-${String(day).padStart(2, "0")}`;
              const dayEvents = eventsOnDate(dayKey);
              const selected = selectedDate === dayKey;
              return <button key={dayKey} aria-label={`${formatDateGroup(dayKey)}${dayEvents.length ? `, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}` : ", no events"}`} aria-pressed={selected} onClick={() => setSelectedDate(selected ? null : dayKey)} className={`relative aspect-square min-h-10 rounded-xl text-xs font-semibold transition-all ${selected ? "bg-primary text-primary-foreground shadow-md" : todayKey === dayKey ? "bg-primary/10 text-primary" : "text-foreground hover:bg-secondary"}`}>
                {day}
                {dayEvents.length > 0 ? <span aria-hidden="true" className={`absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${selected ? "bg-primary-foreground" : "bg-primary"}`} /> : null}
              </button>;
            })}
          </div>
        </section>

        <section className="space-y-4" aria-labelledby="event-list-title">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 id="event-list-title" className="text-sm font-bold">{selectedDate ? formatDateGroup(selectedDate) : `${formatMonthName(currentMonth)} events`}</h3>
              <p className="text-[11px] text-muted-foreground">Chronological · campus, schedule, then event context · times in IST</p>
            </div>
            {selectedDate ? <button onClick={() => setSelectedDate(null)} className="shrink-0 text-xs font-semibold text-primary">Clear date</button> : null}
          </div>

          {isLoading ? [1, 2].map((item) => <div key={item} className="h-44 animate-pulse rounded-3xl bg-muted" />) : listEventGroups.length ? listEventGroups.map((group) => (
            <div key={group.dateKey} role="group" aria-labelledby={`event-date-${group.dateKey}`} className="space-y-3">
              <div className="flex items-center gap-3">
                <h4 id={`event-date-${group.dateKey}`} className="shrink-0 text-[11px] font-extrabold uppercase tracking-[0.14em] text-muted-foreground">{formatDateGroup(group.dateKey)}</h4>
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              {group.events.map((event) => <EventCard key={event.id} event={event} focused={focusedEventId === event.id} response={myRsvps[event.id]} isUpdating={rsvp.isPending} onRespond={(eventId, status) => rsvp.mutate({ eventId, status })} />)}
            </div>
          )) : <EmptyState icon={CalendarIcon} title={view === "going" ? "Nothing saved yet" : "No events here"} description={selectedDate ? "Try another date or clear the date filter." : view === "going" ? "Mark an event as going and it will stay easy to find." : "New relevant events will appear here after an admin publishes them."} />}
        </section>
      </div>
    </OwnedPageScrollRegion>
  );
};

export default CalendarPage;
