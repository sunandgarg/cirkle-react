import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarDays, Check, ExternalLink, Globe2, Loader2, Pencil, Plus, Radar, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { IIT_LIST } from "@/data/iitInstitutes";
import { ALL_COURSES, getSpecialisations } from "@/data/courseSpecialisations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { format } from "date-fns";
import type { Database } from "@/integrations/supabase/types";

type EventRow = Database["public"]["Tables"]["events"]["Row"];

type Audience = {
  mode: "everyone" | "targeted";
  iits: string[];
  courses: string[];
  specialisations: string[];
};

type EventForm = Audience & {
  id?: string;
  source_iit: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  location: string;
  organizer: string;
  registration_url: string;
  status: "draft" | "published" | "archived";
};

const emptyAudience = (): Audience => ({ mode: "everyone", iits: [], courses: [], specialisations: [] });
const emptyEvent = (): EventForm => ({
  ...emptyAudience(), source_iit: "", title: "", description: "", start_time: "", end_time: "", location: "",
  organizer: "", registration_url: "", status: "draft",
});
const MODEL_DEFAULTS = {
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-20250514",
  gemini: "gemini-2.5-flash",
} as const;

const EVENT_CRITERIA_PRESETS = [
  ["Major campus events", "Prioritize major institute events, convocations, public conferences, research showcases, and high-value campus programs."],
  ["Chief guests & talks", "Prioritize distinguished visitors, chief guests, public lectures, fireside chats, and notable speaker sessions."],
  ["Fests & competitions", "Prioritize cultural, technical, entrepreneurship and sports festivals, competitions, and open registrations."],
  ["Student opportunities", "Prioritize events that IIT students or alumni can attend, enter, volunteer for, or meaningfully benefit from."],
] as const;

const toggle = (values: string[], value: string) => values.includes(value)
  ? values.filter((item) => item !== value)
  : [...values, value];

const AudiencePicker = ({ value, onChange }: { value: Audience; onChange: (next: Audience) => void }) => {
  const specialisations = useMemo(() => [...new Set(value.courses.flatMap(getSpecialisations))].sort(), [value.courses]);
  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-secondary/25 p-3">
      <div>
        <Label className="text-xs font-semibold">Who should see this?</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button type="button" onClick={() => onChange({ ...emptyAudience(), mode: "everyone" })}
            className={`min-h-11 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 ${value.mode === "everyone" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}>
            <Globe2 className="w-4 h-4" /> Every IITian
          </button>
          <button type="button" onClick={() => onChange({ ...value, mode: "targeted" })}
            className={`min-h-11 rounded-xl border text-xs font-semibold flex items-center justify-center gap-2 ${value.mode === "targeted" ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground"}`}>
            <Radar className="w-4 h-4" /> Target audience
          </button>
        </div>
      </div>
      {value.mode === "targeted" && (
        <>
          <TargetGroup title="IITs" hint="Leave empty for every IIT" values={IIT_LIST.map((iit) => iit.name)} selected={value.iits}
            onToggle={(item) => onChange({ ...value, iits: toggle(value.iits, item) })} />
          <TargetGroup title="Courses" hint="Leave empty for every course" values={[...ALL_COURSES]} selected={value.courses}
            onToggle={(item) => {
              const courses = toggle(value.courses, item);
              onChange({
                ...value,
                courses,
                specialisations: value.specialisations.filter((specialisation) =>
                  courses.some((course) => getSpecialisations(course).includes(specialisation))),
              });
            }} />
          <TargetGroup title="Specialisations" hint={value.courses.length ? "Optional: narrow selected courses" : "Select a course first"}
            values={specialisations} selected={value.specialisations} disabled={!value.courses.length}
            onToggle={(item) => onChange({ ...value, specialisations: toggle(value.specialisations, item) })} />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Selected categories combine precisely: for example, IIT Delhi + BTech + General reaches only verified IIT Delhi BTech General members.
          </p>
        </>
      )}
    </div>
  );
};

const TargetGroup = ({ title, hint, values, selected, onToggle, disabled = false }: {
  title: string; hint: string; values: string[]; selected: string[]; onToggle: (value: string) => void; disabled?: boolean;
}) => (
  <div className={disabled ? "opacity-50" : ""}>
    <div className="flex items-baseline justify-between gap-2">
      <Label className="text-xs font-semibold">{title}</Label>
      <span className="text-[10px] text-muted-foreground">{selected.length ? `${selected.length} selected` : hint}</span>
    </div>
    <div className="mt-1.5 max-h-32 overflow-y-auto rounded-xl border border-border/70 bg-background p-1.5 flex flex-wrap gap-1.5">
      {values.length ? values.map((item) => {
        const active = selected.includes(item);
        return <button key={item} type="button" disabled={disabled} onClick={() => onToggle(item)}
          className={`min-h-8 px-2.5 rounded-lg border text-[11px] font-medium transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
          {active && <Check className="w-3 h-3 inline mr-1" />}{item}
        </button>;
      }) : <p className="text-[11px] text-muted-foreground p-2">{hint}</p>}
    </div>
  </div>
);

const AudienceSummary = ({ event }: { event: EventRow }) => {
  if (event.audience_mode === "everyone") return <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary"><Globe2 className="w-3 h-3" /> Everyone</span>;
  const labels = [...(event.target_iits || []), ...(event.target_courses || []), ...(event.target_specialisations || [])];
  return <span className="text-[10px] font-semibold text-primary line-clamp-1">{labels.join(" · ") || "Targeted"}</span>;
};

const AdminEvents = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [showEditor, setShowEditor] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [form, setForm] = useState<EventForm>(emptyEvent());
  const [statusFilter, setStatusFilter] = useState("all");
  const [provider, setProvider] = useState<keyof typeof MODEL_DEFAULTS>("openai");
  const [model, setModel] = useState<string>(MODEL_DEFAULTS.openai);
  const [sourceUrls, setSourceUrls] = useState("");
  const [instructions, setInstructions] = useState("");
  const [sourceIit, setSourceIit] = useState("");
  const [scanAudience, setScanAudience] = useState<Audience>(emptyAudience());

  const { data: events = [], isLoading, error: eventsError } = useQuery({
    queryKey: ["admin-events"],
    queryFn: async () => {
      const { data, error } = await supabase.from("events").select("*").order("start_time", { ascending: true }).limit(500);
      if (error) throw error;
      return data ?? [];
    },
    retry: false,
  });

  const { data: scans = [] } = useQuery({
    queryKey: ["admin-event-scans"],
    queryFn: async () => {
      const { data, error } = await supabase.from("event_scan_runs").select("*").order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data ?? [];
    },
    retry: false,
  });

  const { data: scannerStatus, isLoading: isScannerStatusLoading } = useQuery({
    queryKey: ["admin-event-scanner-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("scan-events", { body: { action: "status" } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { configured_providers?: Array<keyof typeof MODEL_DEFAULTS>; openai_web_discovery?: boolean };
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const configuredProviders = scannerStatus?.configured_providers || [];
  const scannerReady = configuredProviders.length > 0;
  const selectedProviderReady = configuredProviders.includes(provider);

  const saveEvent = useMutation({
    mutationFn: async (publish: boolean) => {
      if (!user) throw new Error("Sign in again to continue.");
      if (form.mode === "targeted" && !form.iits.length && !form.courses.length && !form.specialisations.length) throw new Error("Choose at least one audience target.");
      if (!form.title.trim() || !form.start_time) throw new Error("Title and start time are required.");
      if (form.end_time && new Date(form.end_time) < new Date(form.start_time)) throw new Error("End time must be after the start time.");
      if (form.registration_url.trim()) {
        let registrationUrl: URL;
        try { registrationUrl = new URL(form.registration_url.trim()); } catch { throw new Error("Enter a valid registration link."); }
        if (registrationUrl.protocol !== "https:") throw new Error("Registration links must use HTTPS.");
      }
      const payload = {
        title: form.title.trim(), description: form.description.trim() || null,
        start_time: new Date(form.start_time).toISOString(), end_time: form.end_time ? new Date(form.end_time).toISOString() : null,
        location: form.location.trim() || null, organizer: form.organizer.trim() || null,
        registration_url: form.registration_url.trim() || null,
        source_iit: form.source_iit || null,
        status: publish ? "published" : form.status,
        published_at: publish ? new Date().toISOString() : null,
        audience_mode: form.mode, target_iits: form.iits, target_courses: form.courses,
        target_specialisations: form.specialisations, updated_at: new Date().toISOString(),
      };
      if (form.id) {
        const { error } = await supabase.from("events").update(payload).eq("id", form.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("events").insert({ ...payload, created_by: user.id, community_id: "default", source_type: "manual" });
        if (error) throw error;
      }
    },
    onSuccess: (_, published) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-events"] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
      setShowEditor(false); setForm(emptyEvent());
      toast.success(published ? "Event is live for the selected audience" : "Event saved as draft");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const scanEvents = useMutation({
    mutationFn: async () => {
      const urls = sourceUrls.split(/\n|,/).map((url) => url.trim()).filter(Boolean);
      if (!urls.length) throw new Error("Add at least one event source URL.");
      if (urls.length > 10) throw new Error("Use at most 10 sources per scan.");
      for (const rawUrl of urls) {
        let url: URL;
        try { url = new URL(rawUrl); } catch { throw new Error("Every event source must be a valid URL."); }
        if (url.protocol !== "https:") throw new Error("Event sources must use HTTPS.");
      }
      if (scanAudience.mode === "targeted" && !scanAudience.iits.length && !scanAudience.courses.length && !scanAudience.specialisations.length) throw new Error("Choose at least one audience target.");
      const { data, error } = await supabase.functions.invoke("scan-events", {
        body: { provider, model: model.trim(), source_urls: urls, source_iit: sourceIit, instructions: instructions.trim(), audience: scanAudience },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-events"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-event-scans"] });
      setShowScanner(false);
      toast.success(`${result.imported} draft event${result.imported === 1 ? "" : "s"} ready for review`);
    },
    onError: (error: Error) => toast.error(error.message || "Event scan failed"),
  });

  const discoverAllIits = useMutation({
    mutationFn: async () => {
      let imported = 0;
      const failures: string[] = [];
      for (const iit of IIT_LIST) {
        const { data, error } = await supabase.functions.invoke("scan-events", {
          body: {
            action: "discover",
            model: MODEL_DEFAULTS.openai,
            source_iit: iit.name,
            publish_mode: "draft",
            audience: emptyAudience(),
            instructions: "Keep only important future institute events with a confirmed date and official source page.",
          },
        });
        if (error || data?.error) failures.push(iit.name);
        else imported += Number(data.imported || 0);
      }
      return { imported, failures };
    },
    onSuccess: ({ imported, failures }) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-events"] });
      void queryClient.invalidateQueries({ queryKey: ["admin-event-scans"] });
      if (failures.length) toast.warning(`${imported} drafts imported; ${failures.length} IIT scans need retry`);
      else toast.success(`${imported} important event drafts imported from all 23 IITs`);
    },
    onError: (error: Error) => toast.error(error.message || "IIT event discovery failed"),
  });

  const updateStatus = async (event: EventRow, status: "published" | "draft" | "archived") => {
    const { error } = await supabase.from("events").update({ status, published_at: status === "published" ? new Date().toISOString() : event.published_at, updated_at: new Date().toISOString() }).eq("id", event.id);
    if (error) { toast.error(error.message); return; }
    await Promise.all([queryClient.invalidateQueries({ queryKey: ["admin-events"] }), queryClient.invalidateQueries({ queryKey: ["events"] })]);
    toast.success(status === "published" ? "Event published" : status === "archived" ? "Event archived" : "Event moved to drafts");
  };

  const deleteEvent = async (id: string) => {
    if (!window.confirm("Delete this event and its RSVPs? This cannot be undone.")) return;
    const { error } = await supabase.from("events").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await queryClient.invalidateQueries({ queryKey: ["admin-events"] });
    toast.success("Event deleted");
  };

  const editEvent = (event: EventRow) => {
    const localDate = (value: string | null) => value ? new Date(new Date(value).getTime() - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "";
    setForm({
      id: event.id, title: event.title, description: event.description || "", start_time: localDate(event.start_time), end_time: localDate(event.end_time),
      source_iit: event.source_iit || "",
      location: event.location || "", organizer: event.organizer || "", registration_url: event.registration_url || "", status: event.status as EventForm["status"],
      mode: event.audience_mode === "targeted" ? "targeted" : "everyone", iits: event.target_iits || [], courses: event.target_courses || [], specialisations: event.target_specialisations || [],
    });
    setShowEditor(true);
  };

  const visibleEvents = events.filter((event) => statusFilter === "all" || event.status === statusFilter);

  return (
    <div className="space-y-4">
      {eventsError && <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
        <p className="font-bold">Events database upgrade required</p>
        <p className="text-xs mt-1 leading-relaxed">Apply the latest Supabase migration with an Owner or Administrator account, then refresh this page. Existing member events remain available meanwhile.</p>
      </div>}
      <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-bold text-foreground flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" /> AI Event Studio</h3>
              <span className={`rounded-full px-2 py-1 text-[10px] font-bold ${scannerReady ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>{isScannerStatusLoading ? "Checking…" : scannerReady ? "AI ready" : "Setup needed"}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Find high-value IIT events, create reviewable drafts, and publish with institute-aware ranking.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 sm:flex-none rounded-xl" onClick={() => setShowScanner(true)}><Bot className="w-4 h-4" /> AI Generate</Button>
            <Button variant="outline" className="flex-1 sm:flex-none rounded-xl" disabled={discoverAllIits.isPending || !scannerStatus?.openai_web_discovery} onClick={() => discoverAllIits.mutate()}>{discoverAllIits.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radar className="w-4 h-4" />} Scan all 23 IITs</Button>
            <Button className="flex-1 sm:flex-none rounded-xl" onClick={() => { setForm(emptyEvent()); setShowEditor(true); }}><Plus className="w-4 h-4" /> Add manually</Button>
          </div>
        </div>
        {!isScannerStatusLoading && !scannerReady && <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200"><span className="font-bold">Connect an AI provider once:</span> add its API key to Supabase Edge Function secrets. OpenAI enables official-domain discovery across Job Studio and Event Studio, and the key is never exposed to browsers.</div>}
        {scannerReady && <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-500/10 px-3 py-2 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"><ShieldCheck className="h-4 w-4" /> Connected: {configuredProviders.join(", ")}. AI imports drafts only; an admin remains the publishing gate.</div>}
        <div className="grid grid-cols-3 gap-2 mt-4">
          {["draft", "published", "archived"].map((status) => <div key={status} className="rounded-xl bg-secondary/55 p-3 text-center"><p className="text-lg font-bold">{events.filter((event) => event.status === status).length}</p><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{status}</p></div>)}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {["all", "draft", "published", "archived"].map((status) => <button key={status} onClick={() => setStatusFilter(status)} className={`h-9 px-3 rounded-full text-xs font-semibold capitalize border ${statusFilter === status ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border"}`}>{status}</button>)}
      </div>

      <div className="space-y-2">
        {isLoading ? [1, 2, 3].map((item) => <div key={item} className="h-28 rounded-2xl bg-muted animate-pulse" />) : visibleEvents.length ? visibleEvents.map((event) => (
          <div key={event.id} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex gap-3">
              <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex flex-col items-center justify-center shrink-0"><span className="text-[10px] font-bold uppercase">{format(new Date(event.start_time), "MMM")}</span><span className="text-lg font-black leading-none">{format(new Date(event.start_time), "d")}</span></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2"><div><h4 className="text-sm font-bold text-foreground">{event.title}</h4><p className="text-[11px] text-muted-foreground mt-0.5">{format(new Date(event.start_time), "EEE, MMM d · h:mm a")}{event.location ? ` · ${event.location}` : ""}</p></div><span className={`text-[9px] uppercase tracking-wide px-2 py-1 rounded-full font-bold ${event.status === "published" ? "bg-emerald-500/10 text-emerald-600" : event.status === "draft" ? "bg-amber-500/10 text-amber-600" : "bg-muted text-muted-foreground"}`}>{event.status}</span></div>
                <div className="mt-2 flex flex-wrap items-center gap-2">{event.source_iit && <span className="text-[9px] rounded-full bg-primary/10 text-primary px-2 py-0.5 font-bold">{event.source_iit}</span>}<AudienceSummary event={event} />{event.source_type === "scan" && <span className="text-[9px] rounded-full bg-violet-500/10 text-violet-600 px-2 py-0.5 font-bold">AI draft</span>}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border/60">
              <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => editEvent(event)}><Pencil className="w-3.5 h-3.5" /> Edit</Button>
              {event.status !== "published" && <Button size="sm" className="h-8 rounded-lg text-xs" onClick={() => void updateStatus(event, "published")}><Check className="w-3.5 h-3.5" /> Publish</Button>}
              {event.status === "published" && <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => void updateStatus(event, "draft")}>Unpublish</Button>}
              {event.status !== "archived" && <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => void updateStatus(event, "archived")}>Archive</Button>}
              {event.source_url && <a href={event.source_url} target="_blank" rel="noreferrer" className="h-8 px-3 rounded-lg border border-border text-xs font-medium inline-flex items-center gap-1"><ExternalLink className="w-3.5 h-3.5" /> Source</a>}
              <Button size="sm" variant="ghost" className="h-8 ml-auto text-destructive" onClick={() => void deleteEvent(event.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
            </div>
          </div>
        )) : <div className="rounded-2xl border border-dashed border-border py-12 text-center"><CalendarDays className="w-8 h-8 text-muted-foreground mx-auto" /><p className="text-sm font-semibold mt-2">No {statusFilter === "all" ? "" : statusFilter} events</p><p className="text-xs text-muted-foreground mt-1">Scan sources or add the first event manually.</p></div>}
      </div>

      {scans.length > 0 && <div className="rounded-2xl border border-border bg-card p-4"><h4 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Recent scans</h4><div className="mt-2 space-y-2">{scans.slice(0, 5).map((scan) => <div key={scan.id} className="flex items-center gap-3 text-xs"><span className={`w-2 h-2 rounded-full ${scan.status === "completed" ? "bg-emerald-500" : scan.status === "failed" ? "bg-destructive" : "bg-amber-500 animate-pulse"}`} /><span className="font-semibold capitalize">{scan.provider}</span><span className="text-muted-foreground truncate flex-1">{scan.model}</span><span className="text-muted-foreground">{scan.imported_count}/{scan.discovered_count}</span></div>)}</div></div>}

      {showEditor && <div className="fixed inset-0 z-[80] bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center"><div className="bg-card w-full max-w-xl rounded-t-3xl sm:rounded-3xl border border-border max-h-[92dvh] overflow-y-auto shadow-2xl"><div className="sticky top-0 bg-card/95 backdrop-blur-xl border-b border-border px-5 py-4 flex items-center justify-between z-10"><div><h3 className="font-bold">{form.id ? "Edit event" : "Create event"}</h3><p className="text-[11px] text-muted-foreground">Clear information builds trust and attendance.</p></div><button onClick={() => setShowEditor(false)} className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center"><X className="w-4 h-4" /></button></div><div className="p-5 space-y-4">
        <div><Label>Event title *</Label><Input maxLength={180} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="AI research workshop" className="mt-1 h-11 rounded-xl" /></div>
        <div><Label>Hosting IIT</Label><select value={form.source_iit} onChange={(event) => setForm({ ...form, source_iit: event.target.value })} className="mt-1 w-full h-11 rounded-xl border border-border bg-background px-3 text-sm"><option value="">Cross-IIT / national event</option>{IIT_LIST.map((iit) => <option key={iit.name} value={iit.name}>{iit.name}</option>)}</select><p className="text-[10px] text-muted-foreground mt-1">This controls feed grouping; it does not restrict who can view the event.</p></div>
        <div><Label>Description</Label><Textarea maxLength={4000} rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="What members will gain, agenda and important requirements" className="mt-1 rounded-xl" /></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><Label>Starts *</Label><Input type="datetime-local" value={form.start_time} onChange={(event) => setForm({ ...form, start_time: event.target.value })} className="mt-1 h-11 rounded-xl" /></div><div><Label>Ends</Label><Input type="datetime-local" value={form.end_time} min={form.start_time} onChange={(event) => setForm({ ...form, end_time: event.target.value })} className="mt-1 h-11 rounded-xl" /></div></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><Label>Location</Label><Input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} placeholder="IIT Delhi / Online" className="mt-1 h-11 rounded-xl" /></div><div><Label>Organizer</Label><Input value={form.organizer} onChange={(event) => setForm({ ...form, organizer: event.target.value })} placeholder="E-Cell IIT Delhi" className="mt-1 h-11 rounded-xl" /></div></div>
        <div><Label>Registration link</Label><Input type="url" value={form.registration_url} onChange={(event) => setForm({ ...form, registration_url: event.target.value })} placeholder="https://..." className="mt-1 h-11 rounded-xl" /></div>
        <AudiencePicker value={form} onChange={(audience) => setForm({ ...form, ...audience })} />
        <div className="grid grid-cols-2 gap-2 sticky bottom-0 bg-card pt-2"><Button variant="outline" className="h-11 rounded-xl" disabled={saveEvent.isPending} onClick={() => saveEvent.mutate(false)}>Save draft</Button><Button className="h-11 rounded-xl" disabled={saveEvent.isPending} onClick={() => saveEvent.mutate(true)}>{saveEvent.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Publish now"}</Button></div>
      </div></div></div>}

      {showScanner && <div className="fixed inset-0 z-[80] bg-background/80 backdrop-blur-sm flex items-end sm:items-center justify-center"><div className="bg-card w-full max-w-xl rounded-t-3xl sm:rounded-3xl border border-border max-h-[92dvh] overflow-y-auto shadow-2xl"><div className="sticky top-0 bg-card/95 backdrop-blur-xl border-b border-border px-5 py-4 flex items-center justify-between z-10"><div><h3 className="font-bold flex items-center gap-2"><Sparkles className="w-5 h-5 text-primary" /> AI Event Studio</h3><p className="text-[11px] text-muted-foreground">Scan official sources. AI creates drafts; you decide what goes live.</p></div><button onClick={() => setShowScanner(false)} className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center"><X className="w-4 h-4" /></button></div><div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-3"><div><Label>Provider</Label><select value={provider} onChange={(event) => { const next = event.target.value as keyof typeof MODEL_DEFAULTS; setProvider(next); setModel(MODEL_DEFAULTS[next]); }} className="mt-1 w-full h-11 rounded-xl border border-border bg-background px-3 text-sm"><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="anthropic">Claude</option></select></div><div><Label>Model</Label><Input value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 h-11 rounded-xl" /></div></div>
        <div><Label>Source institute</Label><select value={sourceIit} onChange={(event) => setSourceIit(event.target.value)} className="mt-1 w-full h-11 rounded-xl border border-border bg-background px-3 text-sm"><option value="">Multiple IITs / national source</option>{IIT_LIST.map((iit) => <option key={iit.name} value={iit.name}>{iit.name}</option>)}</select><p className="text-[10px] text-muted-foreground mt-1">Choose the IIT whose official pages you are scanning. Its events stay together and rank first for that IIT’s members.</p></div>
        <div><Label>Source URLs *</Label><Textarea rows={5} value={sourceUrls} onChange={(event) => setSourceUrls(event.target.value)} placeholder={"https://home.iitd.ac.in/events\nhttps://ecell.example.org/calendar"} className="mt-1 rounded-xl font-mono text-xs" /><p className="text-[10px] text-muted-foreground mt-1">One public HTTPS page or JSON feed per line. Maximum 10 sources per scan.</p></div>
        <div><div className="flex items-center justify-between gap-2"><Label>Editorial focus</Label><span className="text-[10px] text-muted-foreground">Tap to add</span></div><div className="flex gap-1.5 overflow-x-auto py-2">{EVENT_CRITERIA_PRESETS.map(([label, value]) => <button key={label} type="button" onClick={() => setInstructions((current) => current.includes(value) ? current : `${current}${current ? "\n" : ""}${value}`)} className="shrink-0 rounded-full border border-border bg-background px-3 py-1.5 text-[10px] font-semibold text-muted-foreground hover:border-primary hover:text-primary">{label}</button>)}</div><Textarea rows={3} maxLength={2000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Example: include only entrepreneurship events with open registrations" className="rounded-xl" /></div>
        <AudiencePicker value={scanAudience} onChange={setScanAudience} />
        <div className="rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-300 p-3 text-[11px] leading-relaxed">Scanned results are never published automatically. Dates, links and audience must be reviewed by an admin first.</div>
        {!selectedProviderReady && <p className="rounded-xl bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-200">{provider === "gemini" ? "Add GEMINI_API_KEY to Supabase Edge Function secrets to enable Gemini." : `${provider} is not configured in Supabase Edge Function secrets.`}</p>}
        <Button className="w-full h-12 rounded-xl" disabled={scanEvents.isPending || !model.trim() || !sourceUrls.trim() || !selectedProviderReady} onClick={() => scanEvents.mutate()}>{scanEvents.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Reading and extracting events…</> : <><Sparkles className="w-4 h-4" /> Search, extract and import drafts</>}</Button>
      </div></div></div>}
    </div>
  );
};

export default AdminEvents;
