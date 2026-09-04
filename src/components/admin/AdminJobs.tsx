import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, Bot, CheckCircle2, ExternalLink, Loader2, Pencil,
  Plus, Radar, RefreshCw, ShieldCheck, Sparkles, Trash2, X, XCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

type JobStatus = "draft" | "published" | "archived" | "closed";
type Provider = "gemini" | "openai";

type JobForm = {
  id?: string;
  title: string;
  company: string;
  location: string;
  description: string;
  job_type: string;
  experience_level: string;
  category: string;
  salary_text: string;
  skills: string;
  easy_apply: boolean;
  apply_url: string;
  expires_at: string;
  status: JobStatus;
};

const emptyJob = (): JobForm => ({
  title: "", company: "", location: "", description: "", job_type: "Full-time",
  experience_level: "", category: "", salary_text: "", skills: "", easy_apply: false,
  apply_url: "", expires_at: "", status: "draft",
});

const MODEL_DEFAULTS: Record<Provider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-5.4-mini",
};

const EXPERIENCE_BUCKETS = [
  "Internship", "0-1 years", "1-2 years", "2-3 years", "3-5 years", "5-7 years", "7+ years",
] as const;

const CRITERIA_PRESETS = [
  ["India only", "Only include roles based in India or explicitly available remotely in India."],
  ["Internships", "Prioritize internships and clearly label them as Internship."],
  ["Entry level", "Only include student, graduate, fresher, or 0-2 year opportunities."],
  ["MBA roles", "Prioritize consulting, finance, strategy, product, operations, sales, and marketing roles suitable for MBA students or alumni."],
] as const;

const parseHttpsUrl = (value: string, label: string) => {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return url.toString();
};

const toLocalDateTime = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const StatusBadge = ({ status }: { status: string }) => {
  const style = status === "published"
    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "draft" ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : "bg-muted text-muted-foreground";
  return <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${style}`}>{status}</span>;
};

const AdminJobs = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [jobTypeFilter, setJobTypeFilter] = useState("all");
  const [showEditor, setShowEditor] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [form, setForm] = useState<JobForm>(emptyJob());
  const [provider, setProvider] = useState<Provider>("openai");
  const [model, setModel] = useState(MODEL_DEFAULTS.openai);
  const [company, setCompany] = useState("");
  const [sourceUrls, setSourceUrls] = useState("");
  const [instructions, setInstructions] = useState("");
  const [publishMode, setPublishMode] = useState<"draft" | "published">("draft");
  const [saveSources, setSaveSources] = useState(true);

  const { data: jobs = [], isLoading, error: jobsError } = useQuery({
    queryKey: ["admin-jobs"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("jobs").select("*")
        .order("created_at", { ascending: false }).limit(500);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    retry: false,
  });

  const { data: sources = [] } = useQuery({
    queryKey: ["admin-job-sources"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("job_scan_sources").select("*")
        .order("created_at", { ascending: false }).limit(100);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    retry: false,
  });

  const { data: scans = [] } = useQuery({
    queryKey: ["admin-job-scans"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("job_scan_runs").select("*")
        .order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    retry: false,
  });

  const { data: scannerStatus, isLoading: isScannerStatusLoading } = useQuery({
    queryKey: ["admin-job-scanner-status"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("scan-jobs", { body: { action: "status" } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as {
        configured_providers?: Provider[];
        default_models?: Partial<Record<Provider, string>>;
        experience_buckets?: string[];
        openai_web_discovery?: boolean;
        openai_web_discovery_reason?: string | null;
      };
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const configuredProviders = useMemo(
    () => (scannerStatus?.configured_providers || []).filter((item): item is Provider => item === "openai" || item === "gemini"),
    [scannerStatus?.configured_providers],
  );
  const scannerReady = configuredProviders.length > 0;
  const selectedProviderReady = configuredProviders.includes(provider);

  useEffect(() => {
    if (!scannerReady || selectedProviderReady) return;
    const next = configuredProviders[0];
    setProvider(next);
    setModel(scannerStatus?.default_models?.[next] || MODEL_DEFAULTS[next]);
  }, [configuredProviders, scannerReady, scannerStatus?.default_models, selectedProviderReady]);

  const refreshJobs = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["admin-jobs"] }),
    queryClient.invalidateQueries({ queryKey: ["jobs"] }),
  ]);

  const saveJob = useMutation({
    mutationFn: async (publish: boolean) => {
      if (!user) throw new Error("Sign in again to continue.");
      if (!form.title.trim() || !form.company.trim() || !form.location.trim()) {
        throw new Error("Title, company, and location are required.");
      }
      const applyUrl = form.easy_apply ? null : parseHttpsUrl(form.apply_url, "Application link");
      const expiresAt = form.expires_at ? new Date(form.expires_at) : null;
      if (expiresAt && expiresAt <= new Date()) throw new Error("Expiry must be in the future.");
      const status: JobStatus = publish ? "published" : form.status;
      const payload = {
        title: form.title.trim(), company: form.company.trim(), location: form.location.trim(),
        description: form.description.trim() || null, job_type: form.job_type,
        experience_level: form.experience_level.trim() || null, category: form.category.trim() || null,
        salary_text: form.salary_text.trim() || null,
        skills: [...new Set(form.skills.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 30),
        easy_apply: form.easy_apply, apply_url: applyUrl, expires_at: expiresAt?.toISOString() || null,
        status, published_at: status === "published" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      if (form.id) {
        const { error } = await (supabase as any).from("jobs").update(payload).eq("id", form.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any).from("jobs").insert({
          ...payload, created_by: user.id, community_id: "default", source_type: "manual",
        });
        if (error) throw error;
      }
    },
    onSuccess: async (_, published) => {
      await refreshJobs();
      setShowEditor(false); setForm(emptyJob());
      toast.success(published ? "Job published to the live feed" : "Job saved");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateStatus = async (job: any, status: JobStatus) => {
    const { error } = await (supabase as any).from("jobs").update({
      status,
      published_at: status === "published" ? new Date().toISOString() : job.published_at,
      updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    if (error) { toast.error(error.message); return; }
    await refreshJobs();
    toast.success(status === "published" ? "Job is live" : `Job moved to ${status}`);
  };

  const removeJob = async (id: string) => {
    if (!window.confirm("Delete this job and its applications? This cannot be undone.")) return;
    const { error } = await (supabase as any).from("jobs").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    await refreshJobs();
    toast.success("Job deleted");
  };

  const editJob = (job: any) => {
    setForm({
      id: job.id, title: job.title, company: job.company, location: job.location,
      description: job.description || "", job_type: job.job_type || "Full-time",
      experience_level: job.experience_level || "", category: job.category || "",
      salary_text: job.salary_text || "", skills: (job.skills || []).join(", "),
      easy_apply: !!job.easy_apply, apply_url: job.apply_url || "",
      expires_at: toLocalDateTime(job.expires_at), status: job.status || "draft",
    });
    setShowEditor(true);
  };

  const runScan = useMutation({
    mutationFn: async (sourceId?: string) => {
      if (sourceId) {
        const { data, error } = await supabase.functions.invoke("scan-jobs", { body: { source_id: sourceId } });
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        return data;
      }
      const urls = [...new Set(sourceUrls.split(/\n|,/).map((item) => item.trim()).filter(Boolean))].slice(0, 5);
      if (!urls.length) throw new Error("Add at least one company careers URL.");
      urls.forEach((url) => parseHttpsUrl(url, "Career source"));
      if (!configuredProviders.includes(provider)) throw new Error("Choose a configured OpenAI or Gemini provider.");
      if (!model.trim()) throw new Error("Enter the provider model name.");
      const { data, error } = await supabase.functions.invoke("scan-jobs", {
        body: { provider, model: model.trim(), company: company.trim(), source_urls: urls, instructions: instructions.trim(), publish_mode: publishMode },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (saveSources && user) {
        await Promise.all(urls.map((sourceUrl) => (supabase as any).from("job_scan_sources").upsert({
          company: company.trim() || new URL(sourceUrl).hostname, source_url: sourceUrl,
          provider, model: model.trim(), instructions: instructions.trim() || null,
          auto_publish: publishMode === "published", is_active: true, created_by: user.id,
          updated_at: new Date().toISOString(),
        }, { onConflict: "source_url" })));
      }
      return data;
    },
    onSuccess: async (result, sourceId) => {
      await Promise.all([
        refreshJobs(),
        queryClient.invalidateQueries({ queryKey: ["admin-job-scans"] }),
        queryClient.invalidateQueries({ queryKey: ["admin-job-sources"] }),
      ]);
      if (!sourceId) setShowScanner(false);
      toast.success(`${result.imported} new job${result.imported === 1 ? "" : "s"} imported; ${result.skipped} skipped`);
    },
    onError: (error: Error) => toast.error(error.message || "Career scan failed"),
  });

  const discoverJobs = useMutation({
    mutationFn: async () => {
      const advertisedBuckets = scannerStatus?.experience_buckets || [];
      const buckets = EXPERIENCE_BUCKETS.filter((bucket) => advertisedBuckets.includes(bucket));
      if (!scannerStatus?.openai_web_discovery || buckets.length !== EXPERIENCE_BUCKETS.length) {
        throw new Error(scannerStatus?.openai_web_discovery_reason || "Grounded OpenAI discovery is not configured.");
      }
      let cursor = 0;
      let imported = 0;
      let skipped = 0;
      const failures: string[] = [];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (cursor < buckets.length) {
          const bucket = buckets[cursor++];
          const { data, error } = await supabase.functions.invoke("scan-jobs", {
            body: { action: "discover", experience_bucket: bucket, publish_mode: "draft" },
          });
          if (error || data?.error) failures.push(`${bucket}: ${data?.error || error?.message || "failed"}`);
          else {
            imported += Number(data.imported || 0);
            skipped += Number(data.skipped || 0);
          }
        }
      }));
      return { imported, skipped, failures };
    },
    onSuccess: async ({ imported, skipped, failures }) => {
      await Promise.all([refreshJobs(), queryClient.invalidateQueries({ queryKey: ["admin-job-scans"] })]);
      if (failures.length) toast.warning(`${imported} fresh drafts imported; ${failures.length} experience scans need retry`);
      else toast.success(`${imported} fresh job drafts imported across all seven experience levels; ${skipped} rejected or duplicate`);
    },
    onError: (error: Error) => toast.error(error.message || "Grounded job discovery failed"),
  });
  const agentStatus = runScan.isPending || discoverJobs.isPending ? "Running" : isScannerStatusLoading ? "Checking" : scannerReady ? "Ready" : "Setup needed";

  const updateSource = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await (supabase as any).from("job_scan_sources").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) toast.error(error.message);
    else await queryClient.invalidateQueries({ queryKey: ["admin-job-sources"] });
  };

  const deleteSource = async (id: string) => {
    if (!window.confirm("Remove this saved career source? Imported jobs will remain.")) return;
    const { error } = await (supabase as any).from("job_scan_sources").delete().eq("id", id);
    if (error) toast.error(error.message);
    else await queryClient.invalidateQueries({ queryKey: ["admin-job-sources"] });
  };

  const visibleJobs = useMemo(() => jobs.filter((job) => {
    const statusMatches = statusFilter === "all" || job.status === statusFilter;
    const isInternship = String(job.job_type || "").toLowerCase().includes("intern");
    const typeMatches = jobTypeFilter === "all" || (jobTypeFilter === "internships" ? isInternship : !isInternship);
    return statusMatches && typeMatches;
  }), [jobTypeFilter, jobs, statusFilter]);

  return (
    <div className="space-y-4">
      {jobsError && <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
        <p className="font-bold">Jobs database upgrade required</p>
        <p className="mt-1 text-xs">Apply the latest Prisma migration and deploy the Node API, then refresh.</p>
      </div>}

      <div className="flex gap-2 overflow-x-auto pb-1">
        <Button className="h-11 shrink-0 rounded-full px-5 font-bold" onClick={() => setShowScanner(true)}>
          <Sparkles className="h-4 w-4" /> AI Job Studio
        </Button>
        <Button variant="outline" className="h-11 shrink-0 rounded-full px-5 font-bold" onClick={() => { setForm(emptyJob()); setShowEditor(true); }}>
          <Plus className="h-4 w-4" /> Add manually
        </Button>
        <Button variant="outline" className="h-11 shrink-0 rounded-full px-5 font-bold" disabled={discoverJobs.isPending || !scannerStatus?.openai_web_discovery} onClick={() => discoverJobs.mutate()}>
          {discoverJobs.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />} Discover fresh jobs (7 levels)
        </Button>
      </div>

      <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="flex items-center gap-2 font-bold"><Bot className="h-5 w-5 text-primary" /> Auto Job Agent</h3>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold ${runScan.isPending || !scannerReady ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}>{agentStatus}</span>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">Read trusted public career pages or run cited OpenAI discovery, require an explicit posting time from the last 24 hours, remove duplicates, and import reviewable listings.</p>
          </div>
          <Button variant="outline" className="shrink-0 rounded-xl" onClick={() => setShowScanner(true)}><Radar className="h-4 w-4" /> Search sources</Button>
        </div>
        {!isScannerStatusLoading && !scannerReady && <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">AI provider setup is required. Configure `GEMINI_API_KEY` or `OPENAI_API_KEY` in the Node API environment.</div>}
        {!isScannerStatusLoading && scannerReady && !scannerStatus?.openai_web_discovery && <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">Explicit URL extraction is ready. Web discovery remains unavailable: {scannerStatus?.openai_web_discovery_reason || "a supported OpenAI web-search model is not configured"}.</div>}
        <div className="mt-4 grid grid-cols-4 gap-2">
          {(["draft", "published", "closed", "archived"] as JobStatus[]).map((status) => <button key={status} onClick={() => setStatusFilter(statusFilter === status ? "all" : status)} className={`rounded-xl p-3 text-center transition-colors ${statusFilter === status ? "bg-primary/10 ring-1 ring-primary" : "bg-secondary/55"}`}>
            <p className="text-lg font-bold">{jobs.filter((job) => job.status === status).length}</p><p className="truncate text-[9px] uppercase tracking-wide text-muted-foreground sm:text-[10px]">{status}</p>
          </button>)}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {["all", "draft", "published", "closed", "archived"].map((status) => <button key={status} onClick={() => setStatusFilter(status)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${statusFilter === status ? "bg-primary text-primary-foreground" : "border border-border bg-card text-muted-foreground"}`}>{status[0].toUpperCase() + status.slice(1)}</button>)}
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Show:</span>
        {[['all', 'All listings'], ['jobs', 'Jobs'], ['internships', 'Internships']].map(([value, label]) => <button key={value} onClick={() => setJobTypeFilter(value)} className={`rounded-full px-3 py-1.5 font-semibold ${jobTypeFilter === value ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"}`}>{label}</button>)}
      </div>

      {isLoading ? <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {visibleJobs.map((job) => <article key={job.id} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><StatusBadge status={job.status || "published"} />{["scan", "ai_scan"].includes(job.source_type) && <span className="text-[10px] font-semibold text-primary">AI scan</span>}</div>
                <h4 className="mt-2 truncate text-sm font-bold">{job.title}</h4>
                <p className="truncate text-xs text-muted-foreground">{job.company} · {job.location}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                <button aria-label="Edit job" onClick={() => editJob(job)} className="rounded-lg p-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"><Pencil className="h-4 w-4" /></button>
                <button aria-label="Delete job" onClick={() => removeJob(job.id)} className="rounded-lg p-2 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{job.description || "No description provided."}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-secondary px-2 py-1 text-[10px]">{job.job_type}</span>
              {job.experience_level && <span className="rounded-full bg-secondary px-2 py-1 text-[10px]">{job.experience_level}</span>}
              {job.salary_text && <span className="rounded-full bg-secondary px-2 py-1 text-[10px]">{job.salary_text}</span>}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              {job.status !== "published" && <Button size="sm" className="h-8 rounded-lg text-xs" onClick={() => updateStatus(job, "published")}><CheckCircle2 className="h-3.5 w-3.5" /> Publish</Button>}
              {job.status === "published" && <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => updateStatus(job, "draft")}><XCircle className="h-3.5 w-3.5" /> Unpublish</Button>}
              {job.status !== "closed" && <Button size="sm" variant="ghost" className="h-8 rounded-lg text-xs" onClick={() => updateStatus(job, "closed")}>Close</Button>}
              {job.status !== "archived" && <Button size="sm" variant="ghost" className="h-8 rounded-lg text-xs" onClick={() => updateStatus(job, "archived")}><Archive className="h-3.5 w-3.5" /> Archive</Button>}
              {job.apply_url && <a href={job.apply_url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-primary">Open listing <ExternalLink className="h-3 w-3" /></a>}
            </div>
          </article>)}
          {!visibleJobs.length && <div className="col-span-full rounded-2xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">No {statusFilter === "all" ? "" : statusFilter} jobs yet.</div>}
        </div>
      )}

      <section className="rounded-2xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div><h4 className="text-sm font-bold">Saved career sources</h4><p className="text-[11px] text-muted-foreground">Run a source again without re-entering its provider configuration.</p></div>
          <span className="text-xs text-muted-foreground">{sources.length}</span>
        </div>
        <div className="mt-3 space-y-2">
          {sources.map((source) => <div key={source.id} className="rounded-xl border border-border bg-secondary/25 p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1"><p className="truncate text-xs font-bold">{source.company}</p><a href={source.source_url} target="_blank" rel="noreferrer" className="block truncate text-[10px] text-primary">{source.source_url}</a><p className="mt-1 text-[10px] text-muted-foreground">{source.provider} · {source.model}{source.last_scanned_at ? ` · ${formatDistanceToNow(new Date(source.last_scanned_at), { addSuffix: true })}` : " · never scanned"}</p>{source.last_error && <p className="mt-1 line-clamp-2 text-[10px] text-destructive">{source.last_error}</p>}</div>
              <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={runScan.isPending || !source.is_active || !configuredProviders.includes(source.provider)} onClick={() => runScan.mutate(source.id)}><RefreshCw className={`h-3.5 w-3.5 ${runScan.isPending ? "animate-spin" : ""}`} /> Scan</Button>
              <button aria-label="Remove source" onClick={() => deleteSource(source.id)} className="rounded-lg p-2 text-destructive hover:bg-destructive/10"><Trash2 className="h-4 w-4" /></button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
              <label className="flex items-center gap-2"><Switch checked={source.is_active} onCheckedChange={(checked) => updateSource(source.id, { is_active: checked })} /> Active</label>
              <label className="flex items-center gap-2"><Switch checked={source.auto_publish} onCheckedChange={(checked) => updateSource(source.id, { auto_publish: checked })} /> Auto-publish</label>
            </div>
          </div>)}
          {!sources.length && <p className="py-5 text-center text-xs text-muted-foreground">Save a source during your first scan.</p>}
        </div>
      </section>

      {!!scans.length && <section className="rounded-2xl border border-border bg-card p-4">
        <h4 className="text-sm font-bold">Recent scan audit</h4>
        <div className="mt-3 space-y-2">{scans.slice(0, 8).map((scan) => <div key={scan.id} className="flex items-center gap-3 rounded-xl bg-secondary/40 p-3 text-xs"><span className={`h-2 w-2 rounded-full ${scan.status === "completed" ? "bg-emerald-500" : scan.status === "failed" ? "bg-destructive" : "bg-amber-500 animate-pulse"}`} /><div className="min-w-0 flex-1"><p className="truncate font-semibold">{scan.company || scan.source_urls?.[0] || "Career scan"}</p><p className="text-[10px] text-muted-foreground">{scan.provider} · {scan.discovered_count} found · {scan.imported_count} imported · {scan.skipped_count} skipped</p></div><span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(scan.created_at), { addSuffix: true })}</span></div>)}</div>
      </section>}

      {showEditor && <div className="fixed inset-0 z-[70] flex items-end justify-center bg-background/80 backdrop-blur-sm sm:items-center">
        <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-card p-5 sm:rounded-3xl sm:p-6">
          <div className="mb-5 flex items-start justify-between"><div><h3 className="font-bold">{form.id ? "Edit job" : "Add job manually"}</h3><p className="text-xs text-muted-foreground">Save as draft first or publish immediately.</p></div><button onClick={() => setShowEditor(false)} className="rounded-full p-2 hover:bg-secondary"><X className="h-5 w-5" /></button></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Job title *"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Software Engineer" /></Field>
            <Field label="Company *"><Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Company name" /></Field>
            <Field label="Location *"><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Bengaluru / Remote" /></Field>
            <Field label="Job type"><select value={form.job_type} onChange={(e) => setForm({ ...form, job_type: e.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option>Full-time</option><option>Part-time</option><option>Internship</option><option>Contract</option></select></Field>
            <Field label="Experience"><select value={form.experience_level} onChange={(e) => setForm({ ...form, experience_level: e.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Not specified</option>{EXPERIENCE_BUCKETS.map((bucket) => <option key={bucket} value={bucket}>{bucket}</option>)}</select></Field>
            <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Engineering" /></Field>
            <Field label="Salary"><Input value={form.salary_text} onChange={(e) => setForm({ ...form, salary_text: e.target.value })} placeholder="₹18–25 LPA" /></Field>
            <Field label="Expires at"><Input type="datetime-local" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Field label="Skills (comma separated)"><Input value={form.skills} onChange={(e) => setForm({ ...form, skills: e.target.value })} placeholder="React, TypeScript, SQL" /></Field></div>
            <div className="sm:col-span-2"><Field label="Description"><Textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Role, responsibilities, requirements, and hiring process…" /></Field></div>
            <div className="sm:col-span-2 rounded-xl border border-border bg-secondary/30 p-3"><label className="flex items-center justify-between gap-3 text-sm font-semibold">Applications inside Cirkle <Switch checked={form.easy_apply} onCheckedChange={(checked) => setForm({ ...form, easy_apply: checked })} /></label><p className="mt-1 text-[11px] text-muted-foreground">Turn off for a company careers link.</p></div>
            {!form.easy_apply && <div className="sm:col-span-2"><Field label="HTTPS application link *"><Input value={form.apply_url} onChange={(e) => setForm({ ...form, apply_url: e.target.value })} placeholder="https://company.com/careers/job-id" /></Field></div>}
          </div>
          <div className="mt-6 flex gap-2"><Button variant="outline" className="flex-1 rounded-xl" disabled={saveJob.isPending} onClick={() => saveJob.mutate(false)}>{saveJob.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save draft</Button><Button className="flex-1 rounded-xl" disabled={saveJob.isPending} onClick={() => saveJob.mutate(true)}><CheckCircle2 className="h-4 w-4" /> Publish</Button></div>
        </div>
      </div>}

      {showScanner && <div className="fixed inset-0 z-[70] flex items-end justify-center bg-background/80 backdrop-blur-sm sm:items-center">
        <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-border bg-card p-5 sm:rounded-3xl sm:p-6">
          <div className="mb-5 flex items-start justify-between"><div><h3 className="flex items-center gap-2 font-bold"><Sparkles className="h-5 w-5 text-primary" /> AI Job Studio</h3><p className="text-xs text-muted-foreground">Read up to five public career sources, extract only jobs with a visible last-24-hour posting time, deduplicate, and import them.</p></div><button onClick={() => setShowScanner(false)} className="rounded-full p-2 hover:bg-secondary"><X className="h-5 w-5" /></button></div>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><Field label="AI provider"><select value={provider} disabled={!scannerReady} onChange={(e) => { const next = e.target.value as Provider; setProvider(next); setModel(scannerStatus?.default_models?.[next] || MODEL_DEFAULTS[next]); }} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60">{scannerReady ? configuredProviders.map((item) => <option key={item} value={item}>{item === "gemini" ? "Gemini" : "OpenAI"}</option>) : <option value={provider}>No provider configured</option>}</select></Field><Field label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} disabled={!scannerReady} /></Field></div>
            <Field label="Company"><Input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Optional fallback company name" /></Field>
            <Field label="Career URLs (one per line, maximum 5)"><Textarea rows={5} value={sourceUrls} onChange={(e) => setSourceUrls(e.target.value)} placeholder={"https://company.com/careers\nhttps://jobs.company.com/search"} /></Field>
            <Field label="Hiring criteria"><div className="mb-2 flex flex-wrap gap-2">{CRITERIA_PRESETS.map(([label, text]) => <button type="button" key={label} onClick={() => setInstructions((current) => current.includes(text) ? current : `${current}${current.trim() ? "\n" : ""}${text}`)} className="rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-[11px] font-semibold text-muted-foreground hover:border-primary hover:text-primary">+ {label}</button>)}</div><Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="Choose criteria above or add your own. The scanner will only extract real vacancies from the supplied sources." /></Field>
            <div className="grid grid-cols-2 gap-2"><button onClick={() => setPublishMode("draft")} className={`min-h-12 rounded-xl border text-xs font-semibold ${publishMode === "draft" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>Import as drafts<br /><span className="font-normal">Recommended</span></button><button onClick={() => setPublishMode("published")} className={`min-h-12 rounded-xl border text-xs font-semibold ${publishMode === "published" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>Publish automatically<br /><span className="font-normal">Use trusted sources only</span></button></div>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-xs font-semibold">Save these sources for future scans <Switch checked={saveSources} onCheckedChange={setSaveSources} /></label>
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground"><p className="flex items-center gap-1 font-bold text-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Verified-source AI workflow</p><p className="mt-1">AI extracts only jobs supported by these pages. Every imported AI job must carry an explicit source posting time no older than 24 hours; undated or stale roles are rejected.</p></div>
            <Button className="h-11 w-full rounded-xl" disabled={runScan.isPending || !selectedProviderReady || !sourceUrls.trim()} onClick={() => runScan.mutate(undefined)}>{runScan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}{runScan.isPending ? "Reading and validating…" : "Read, extract and import"}</Button>
          </div>
        </div>
      </div>}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="space-y-1.5"><Label className="text-xs font-semibold">{label}</Label>{children}</div>;

export default AdminJobs;
