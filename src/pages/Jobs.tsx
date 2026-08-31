import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark, BriefcaseBusiness, Building2, CheckCircle2, Clock3, ExternalLink,
  Lock, MapPin, RefreshCw, Search, Sparkles, Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import EmptyState from "@/components/EmptyState";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";

const FILTERS = ["All", "Easy Apply", "Internship", "Full-time", "Part-time", "Remote", "Saved"] as const;

const inferredSkills = (title: string): string[] => {
  const value = title.toLowerCase();
  if (value.includes("react") || value.includes("frontend")) return ["React", "TypeScript", "CSS"];
  if (value.includes("backend") || value.includes("node")) return ["Node.js", "PostgreSQL", "APIs"];
  if (value.includes("ai") || value.includes("machine learning") || value.includes("ml")) return ["Python", "Machine learning", "Data"];
  if (value.includes("design")) return ["Product design", "Figma", "Research"];
  if (value.includes("product")) return ["Product strategy", "Analytics", "Execution"];
  return [];
};

const safeDate = (value: string | null | undefined) => {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const Jobs = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [activeFilter, setActiveFilter] = useState<(typeof FILTERS)[number]>("All");
  const [search, setSearch] = useState("");
  const storageKey = `cirkle:saved-jobs:${user?.id || "guest"}`;
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const isVerified = !!user && !!profile?.is_verified;

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      setSavedIds(new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []));
    } catch { setSavedIds(new Set()); }
  }, [storageKey]);

  const { data: jobs = [], isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => {
      const now = new Date().toISOString();
      const { data, error } = await (supabase as any).from("jobs")
        .select("id,title,company,location,description,job_type,experience_level,category,easy_apply,apply_url,created_by,created_at,published_at,expires_at,salary_text,skills,source_type,source_url")
        .eq("status", "published")
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order("published_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(250);
      if (error) throw error;
      return (data ?? []) as any[];
    },
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: true,
  });

  const { data: myApplications = [] } = useQuery({
    queryKey: ["my-applications", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.from("applications").select("job_id").eq("applicant_id", user.id);
      if (error) throw error;
      return (data ?? []).map((application) => application.job_id);
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  const apply = useMutation({
    mutationFn: async (job: any) => {
      if (!user || !isVerified) throw new Error("Verify your community profile before applying.");
      const { error } = await supabase.from("applications").insert({
        job_id: job.id, applicant_id: user.id, note: "Easy Apply", resume_url: null,
      });
      if (error) throw error;
      if (job.created_by && job.created_by !== user.id) {
        await supabase.from("notifications").insert({
          user_id: job.created_by, type: "job_application", title: "New job application",
          message: `${profile?.name || "A verified member"} applied for ${job.title}`,
          entity_id: job.id,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["my-applications", user?.id] });
      toast.success("Application sent");
    },
    onError: (applicationError: any) => {
      const message = String(applicationError?.message || "Could not apply");
      toast.error(message.toLowerCase().includes("duplicate") ? "You already applied to this job" : message);
    },
  });

  const toggleSaved = (id: string) => {
    const next = new Set(savedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSavedIds(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Private mode may block storage. */ }
  };

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return jobs.filter((job) => {
      if (activeFilter === "Easy Apply" && !job.easy_apply) return false;
      if (activeFilter === "Internship" && !job.job_type?.toLowerCase().includes("intern")) return false;
      if (activeFilter === "Full-time" && !job.job_type?.toLowerCase().includes("full")) return false;
      if (activeFilter === "Part-time" && !job.job_type?.toLowerCase().includes("part")) return false;
      if (activeFilter === "Remote" && !job.location?.toLowerCase().includes("remote")) return false;
      if (activeFilter === "Saved" && !savedIds.has(job.id)) return false;
      if (!query) return true;
      return [job.title, job.company, job.location, job.category, ...(job.skills || [])]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(query));
    });
  }, [activeFilter, jobs, savedIds, search]);

  const handleApply = (job: any) => {
    if (!user) { navigate("/auth"); return; }
    if (!isVerified) { navigate("/iit-verify"); return; }
    if (!job.easy_apply && job.apply_url) {
      window.open(job.apply_url, "_blank", "noopener,noreferrer");
      return;
    }
    apply.mutate(job);
  };

  return (
    <div className="flex min-h-0 flex-col bg-background">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-5xl px-4 pb-3 pt-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div><h1 className="text-xl font-bold tracking-tight text-foreground">Jobs</h1><p className="mt-0.5 text-xs text-muted-foreground">Verified opportunities for your community</p></div>
            <div className="flex items-center gap-2"><span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">{filteredJobs.length} open</span><button aria-label="Refresh jobs" onClick={() => refetch()} disabled={isFetching} className="rounded-full border border-border p-2 text-muted-foreground hover:text-primary"><RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /></button></div>
          </div>
          <div className="relative mt-4"><Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search role, company, skill, or location" className="h-11 rounded-xl border-border bg-card pl-10" /></div>
          <div className="-mx-4 mt-3 overflow-x-auto px-4 scrollbar-hide sm:-mx-6 sm:px-6"><div className="flex w-max gap-2">{FILTERS.map((filter) => <button key={filter} onClick={() => setActiveFilter(filter)} className={`min-h-9 whitespace-nowrap rounded-full px-3.5 text-xs font-semibold transition-colors ${activeFilter === filter ? "bg-primary text-primary-foreground shadow-sm" : "border border-border bg-card text-muted-foreground hover:text-foreground"}`}>{filter === "Saved" && <Bookmark className="mr-1 inline h-3 w-3" />}{filter}</button>)}</div></div>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="mx-auto max-w-5xl px-4 py-4 pb-24 sm:px-6">
          {error ? <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-6 text-center"><BriefcaseBusiness className="mx-auto h-8 w-8 text-destructive" /><h2 className="mt-3 text-sm font-bold">Jobs could not be loaded</h2><p className="mt-1 text-xs text-muted-foreground">Check your connection and try again. If this continues, the jobs database migration may still need deployment.</p><Button variant="outline" className="mt-4 rounded-xl" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /> Try again</Button></div>
            : isLoading ? <div className="grid gap-3 md:grid-cols-2">{[1, 2, 3, 4].map((item) => <div key={item} className="h-56 animate-pulse rounded-2xl border border-border bg-card p-4"><div className="h-11 w-11 rounded-xl bg-secondary" /><div className="mt-4 h-4 w-2/3 rounded bg-secondary" /><div className="mt-2 h-3 w-1/2 rounded bg-secondary" /><div className="mt-7 h-14 rounded bg-secondary/70" /></div>)}</div>
              : filteredJobs.length ? <div className="grid gap-3 md:grid-cols-2">{filteredJobs.map((job, index) => {
                const skills = (job.skills?.length ? job.skills : inferredSkills(job.title)).slice(0, 5);
                const applied = myApplications.includes(job.id);
                const saved = savedIds.has(job.id);
                const publishedAt = safeDate(job.published_at || job.created_at);
                return <article key={job.id} className="group rounded-2xl border border-border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md" style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
                  <div className="flex items-start gap-3"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Building2 className="h-5 w-5" /></div><div className="min-w-0 flex-1"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h2 className="truncate text-sm font-bold text-foreground">{job.title}</h2><p className="mt-0.5 truncate text-xs font-medium text-muted-foreground">{job.company}</p></div><button aria-label={saved ? "Remove saved job" : "Save job"} onClick={() => toggleSaved(job.id)} className={`rounded-full p-2 transition-colors ${saved ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-primary"}`}><Bookmark className={`h-4 w-4 ${saved ? "fill-current" : ""}`} /></button></div></div></div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground">{job.location && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{job.location}</span>}<span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" />{formatDistanceToNow(publishedAt, { addSuffix: true })}</span>{job.source_type === "scan" && <span className="flex items-center gap-1 text-primary"><Sparkles className="h-3 w-3" />Verified source</span>}</div>
                  {job.description && <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted-foreground">{job.description}</p>}
                  <div className="mt-3 flex min-h-6 flex-wrap gap-1.5">{skills.map((skill: string) => <span key={skill} className="rounded-full border border-primary/15 bg-primary/5 px-2.5 py-1 text-[10px] font-medium text-primary">{skill}</span>)}</div>
                  <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-border/70 pt-3"><div><div className="flex flex-wrap gap-1.5">{job.job_type && <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-semibold">{job.job_type}</span>}{job.experience_level && <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-semibold">{job.experience_level}</span>}</div>{job.salary_text && <p className="mt-1.5 text-xs font-bold text-foreground">{job.salary_text}</p>}</div>{applied ? <span className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-emerald-500/10 px-4 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" /> Applied</span> : <Button size="sm" className="min-h-10 rounded-xl px-4 text-xs" disabled={apply.isPending && job.easy_apply} onClick={() => handleApply(job)}>{job.easy_apply ? <Zap className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}{job.easy_apply ? "Easy Apply" : "View & apply"}</Button>}</div>
                  {job.source_url && <a href={job.source_url} target="_blank" rel="noreferrer" className="mt-3 block truncate text-[10px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline">Source: {new URL(job.source_url).hostname}</a>}
                </article>;
              })}</div>
                : <EmptyState icon={BriefcaseBusiness} title={activeFilter === "Saved" ? "No saved jobs yet" : "No matching jobs"} description={activeFilter === "Saved" ? "Tap the bookmark on a job to keep it here." : "Try a broader search or another filter."} />}

          {!user || !isVerified ? <div className="mt-4 rounded-2xl border border-primary/15 bg-primary/5 p-5 text-center"><Lock className="mx-auto h-6 w-6 text-primary" /><h3 className="mt-2 text-sm font-bold">{user ? "Verify once to apply" : "Join the verified community network"}</h3><p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">Browse every public opening now. {user ? "Complete your community verification before applying." : "Sign in to save your identity and apply to opportunities."}</p><Button className="mt-4 rounded-xl" onClick={() => navigate(user ? "/iit-verify" : "/auth")}>{user ? "Complete verification" : "Sign in"}</Button></div> : null}
        </div>
      </main>
    </div>
  );
};

export default Jobs;
