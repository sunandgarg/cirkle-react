import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar as CalendarIcon, Check, ChevronLeft, ChevronRight, Clock, ExternalLink, Globe2, MapPin, Settings2, Sparkles, Users } from "lucide-react";
import { eachDayOfInterval, endOfMonth, format, getDay, isSameDay, isSameMonth, isToday, startOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { Database } from "@/integrations/supabase/types";

type EventRow = Database["public"]["Tables"]["events"]["Row"];

const audienceLabel = (event: EventRow) => {
  if (!event.audience_mode || event.audience_mode === "everyone") return "All IITians";
  const targets = [...(event.target_iits || []), ...(event.target_courses || []), ...(event.target_specialisations || [])];
  return targets.slice(0, 3).join(" · ") + (targets.length > 3 ? ` +${targets.length - 3}` : "");
};

const CalendarPage = () => {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [view, setView] = useState<"upcoming" | "going" | "past">("upcoming");

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["events", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const current = await supabase.from("events").select("*").eq("status", "published").order("start_time", { ascending: true }).limit(500);
      if (!current.error) return current.data ?? [];
      // Keep the existing Events page available while a new frontend waits for
      // its corresponding database migration to be applied.
      const legacy = await supabase.from("events").select("*").order("start_time", { ascending: true }).limit(500);
      if (legacy.error) throw current.error;
      return legacy.data ?? [];
    },
    enabled: !!user,
    staleTime: 60_000,
  });

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
    mutationFn: async ({ eventId, status }: { eventId: string; status: "going" | "not_going" }) => {
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
  const filteredByView = events.filter((event) => {
    const isPast = new Date(event.end_time || event.start_time).getTime() < now;
    if (view === "past") return isPast;
    if (view === "going") return !isPast && myRsvps[event.id] === "going";
    return !isPast;
  });

  const upcoming = events.filter((event) => new Date(event.end_time || event.start_time).getTime() >= now);
  const nextEvent = upcoming[0];
  const monthStart = startOfMonth(currentMonth);
  const days = eachDayOfInterval({ start: monthStart, end: endOfMonth(currentMonth) });
  const eventsOnDate = (date: Date) => events.filter((event) => isSameDay(new Date(event.start_time), date));
  const listEvents = selectedDate
    ? filteredByView.filter((event) => isSameDay(new Date(event.start_time), selectedDate))
    : filteredByView.filter((event) => isSameMonth(new Date(event.start_time), currentMonth));

  return (
    <div className="bg-background min-h-screen">
      <header className="sticky top-0 z-40 bg-card/95 backdrop-blur-xl border-b border-border px-4 py-3">
        <div className="flex items-center justify-between max-w-3xl mx-auto">
          <div>
            <h1 className="text-lg font-bold text-foreground">Events</h1>
            <p className="text-xs text-muted-foreground">Relevant opportunities for your IIT journey</p>
          </div>
          {isAdmin && <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate("/admin")}><Settings2 className="w-4 h-4" /> Manage</Button>}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-4 pb-24 space-y-5">
        {nextEvent && (
          <section className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-primary/90 to-violet-600 text-primary-foreground p-5 shadow-lg shadow-primary/15">
            <div className="absolute -right-12 -top-12 w-40 h-40 rounded-full bg-white/10" />
            <div className="relative">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-white/80"><Sparkles className="w-3.5 h-3.5" /> Next for you</div>
              <h2 className="text-xl font-black leading-tight mt-3 max-w-lg">{nextEvent.title}</h2>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs text-white/85">
                <span className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" />{format(new Date(nextEvent.start_time), "EEE, MMM d · h:mm a")}</span>
                {nextEvent.location && <span className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5" />{nextEvent.location}</span>}
              </div>
              <div className="flex items-center justify-between gap-3 mt-5">
                <span className="text-[11px] font-semibold bg-white/15 px-3 py-1.5 rounded-full backdrop-blur"><Users className="w-3 h-3 inline mr-1" />{audienceLabel(nextEvent)}</span>
                <Button size="sm" variant="secondary" className="rounded-full font-bold" onClick={() => rsvp.mutate({ eventId: nextEvent.id, status: "going" })}>{myRsvps[nextEvent.id] === "going" ? <><Check className="w-4 h-4" /> Going</> : "I'm interested"}</Button>
              </div>
            </div>
          </section>
        )}

        <div className="grid grid-cols-3 gap-2 rounded-2xl bg-secondary/70 p-1.5">
          {(["upcoming", "going", "past"] as const).map((item) => <button key={item} onClick={() => { setView(item); setSelectedDate(null); }} className={`h-10 rounded-xl text-xs font-bold capitalize transition-all ${view === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"}`}>{item}{item === "going" && Object.values(myRsvps).filter((status) => status === "going").length ? ` (${Object.values(myRsvps).filter((status) => status === "going").length})` : ""}</button>)}
        </div>

        <section className="rounded-3xl border border-border bg-card p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <button aria-label="Previous month" onClick={() => { setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1)); setSelectedDate(null); }} className="w-10 h-10 rounded-full hover:bg-secondary flex items-center justify-center"><ChevronLeft className="w-5 h-5" /></button>
            <button onClick={() => { setCurrentMonth(new Date()); setSelectedDate(null); }} className="text-sm font-bold">{format(currentMonth, "MMMM yyyy")}</button>
            <button aria-label="Next month" onClick={() => { setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1)); setSelectedDate(null); }} className="w-10 h-10 rounded-full hover:bg-secondary flex items-center justify-center"><ChevronRight className="w-5 h-5" /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 mb-1">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <div key={`${day}-${index}`} className="text-center text-[10px] font-bold text-muted-foreground py-1">{day}</div>)}</div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: getDay(monthStart) }).map((_, index) => <div key={`padding-${index}`} />)}
            {days.map((day) => {
              const dayEvents = eventsOnDate(day);
              const selected = selectedDate && isSameDay(day, selectedDate);
              return <button key={day.toISOString()} onClick={() => setSelectedDate(selected ? null : day)} className={`aspect-square min-h-10 rounded-xl text-xs font-semibold relative transition-all ${selected ? "bg-primary text-primary-foreground shadow-md" : isToday(day) ? "bg-primary/10 text-primary" : "hover:bg-secondary text-foreground"}`}>
                {day.getDate()}
                {dayEvents.length > 0 && <span className={`absolute bottom-1 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${selected ? "bg-primary-foreground" : "bg-primary"}`} />}
              </button>;
            })}
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between"><div><h3 className="text-sm font-bold">{selectedDate ? format(selectedDate, "EEEE, MMMM d") : `${format(currentMonth, "MMMM")} events`}</h3><p className="text-[11px] text-muted-foreground">Only events available to your verified profile are shown.</p></div>{selectedDate && <button onClick={() => setSelectedDate(null)} className="text-xs font-semibold text-primary">Clear date</button>}</div>
          {isLoading ? [1, 2].map((item) => <div key={item} className="h-36 rounded-2xl bg-muted animate-pulse" />) : listEvents.length ? listEvents.map((event) => (
            <article key={event.id} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
              <div className="flex gap-3">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex flex-col items-center justify-center shrink-0"><span className="text-[10px] font-bold uppercase text-primary">{format(new Date(event.start_time), "MMM")}</span><span className="text-lg font-black text-primary leading-none">{format(new Date(event.start_time), "d")}</span></div>
                <div className="flex-1 min-w-0"><h4 className="font-bold text-sm text-foreground">{event.title}</h4>{event.organizer && <p className="text-[11px] text-muted-foreground mt-0.5">By {event.organizer}</p>}<div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px] text-muted-foreground"><span className="flex items-center gap-1"><Clock className="w-3 h-3" />{format(new Date(event.start_time), "h:mm a")}</span>{event.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{event.location}</span>}</div></div>
              </div>
              {event.description && <p className="text-xs text-muted-foreground leading-relaxed mt-3 line-clamp-3">{event.description}</p>}
              <div className="mt-3 flex items-center gap-2"><span className="inline-flex items-center gap-1 text-[10px] font-semibold rounded-full bg-primary/10 text-primary px-2.5 py-1">{event.audience_mode === "everyone" ? <Globe2 className="w-3 h-3" /> : <Users className="w-3 h-3" />}{audienceLabel(event)}</span></div>
              <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-border/60">
                <Button size="sm" variant={myRsvps[event.id] === "going" ? "default" : "outline"} className="rounded-xl h-10" disabled={rsvp.isPending} onClick={() => rsvp.mutate({ eventId: event.id, status: "going" })}>{myRsvps[event.id] === "going" ? <><Check className="w-4 h-4" /> Going</> : "I'm going"}</Button>
                {event.registration_url ? <a href={event.registration_url} target="_blank" rel="noreferrer" className="h-10 rounded-xl bg-secondary text-foreground text-xs font-semibold flex items-center justify-center gap-1.5">Register <ExternalLink className="w-3.5 h-3.5" /></a> : <Button size="sm" variant={myRsvps[event.id] === "not_going" ? "secondary" : "ghost"} className="rounded-xl h-10" disabled={rsvp.isPending} onClick={() => rsvp.mutate({ eventId: event.id, status: "not_going" })}>Not for me</Button>}
              </div>
            </article>
          )) : <EmptyState icon={CalendarIcon} title={view === "going" ? "Nothing saved yet" : "No events here"} description={selectedDate ? "Try another date or clear the date filter." : view === "going" ? "Mark an event as going and it will stay easy to find." : "New relevant events will appear here after an admin publishes them."} />}
        </section>
      </main>
    </div>
  );
};

export default CalendarPage;
