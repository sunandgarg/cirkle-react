import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bookmark, BriefcaseBusiness, CheckCircle2, Clock3, ExternalLink,
  Lock, RefreshCw, Search, Zap,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import EmptyState from "@/components/EmptyState";
import CompanyLogo from "@/components/CompanyLogo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { recordJobEngagement } from "@/lib/jobAnalytics";
import { safeHttpUrl } from "@/lib/safeUrl";

const FILTERS = ["All", "Easy Apply", "Internship", "Full-time", "Part-time", "Remote", "Saved"] as const;
const jobFilterForPath = (pathname: string): (typeof FILTERS)[number] => pathname.endsWith("/internships") ? "Internship"
  : pathname.endsWith("/full-time") ? "Full-time"
    : pathname.endsWith("/part-time") ? "Part-time"
      : pathname.endsWith("/remote") ? "Remote" : "All";

const inferredSkills = (title: string): string[] => {
  const value = title.toLowerCase();
  if (value.includes("react") || value.includes("frontend")) return ["React", "TypeScript", "CSS"];
  if (value.includes("backend") || value.includes("node")) return ["Node.js", "MySQL", "APIs"];
  if (value.includes("ai") || value.includes("machine learning") || value.includes("ml")) return ["Python", "Machine learning", "Data"];
  if (value.includes("design")) return ["Product design", "Figma", "Research"];
  if (value.includes("product")) return ["Product strategy", "Analytics", "Execution"];
  return [];
};

const safeDate = (value: string | null | undefined) => {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
};

const safeHostname = (value: string | null | undefined) => {
  try { const safe = safeHttpUrl(value); return safe ? new URL(safe).hostname.replace(/^www\./, "") : ""; }
  catch { return ""; }
};

const Jobs = () => {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [activeFilter, setActiveFilter] = useState<(typeof FILTERS)[number]>(() => jobFilterForPath(location.pathname));
  const [search, setSearch] = useState("");
  const storageKey = `cirkle:saved-jobs:${user?.id || "guest"}`;
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const isVerified = !!user && !!profile?.is_verified;
  const requestedJobId = searchParams.get("job") || "";
  const focusedJobId = /^[a-zA-Z0-9_-]{1,100}$/.test(requestedJobId) ? requestedJobId : "";

  useEffect(() => {
    setActiveFilter(jobFilterForPath(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) || "[]");
      setSavedIds(new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : []));
    } catch { setSavedIds(new Set()); }
  }, [storageKey]);

  useEffect(() => {
    if (user?.id) void recordJobEngagement("jobs_page_view", null, { path: "/jobs" });
  }, [user?.id]);

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

  const { data: focusedJob, isFetched: focusedJobFetched } = useQuery({
    queryKey: ["job-deep-link", focusedJobId],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("jobs")
        .select("id,title,company,location,description,job_type,experience_level,category,easy_apply,apply_url,created_by,created_at,published_at,expires_at,salary_text,skills,source_type,source_url")
        .eq("id", focusedJobId)
        .maybeSingle();
      if (error) throw error;
      return data as any | null;
    },
    enabled: !!focusedJobId,
    retry: false,
  });

  const displayedJobs = useMemo(() => focusedJob && !jobs.some((job) => job.id === focusedJob.id)
    ? [focusedJob, ...jobs]
    : jobs, [focusedJob, jobs]);

  useEffect(() => {
    if (!focusedJob?.id || isLoading) return;
    setActiveFilter("All");
    setSearch("");
    const timer = window.setTimeout(() => document.getElementById(`job-${focusedJob.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    return () => window.clearTimeout(timer);
  }, [focusedJob?.id, isLoading]);

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
    const wasSaved = next.has(id);
    if (wasSaved) next.delete(id); else next.add(id);
    setSavedIds(next);
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Private mode may block storage. */ }
    if (user?.id) void recordJobEngagement(wasSaved ? "job_unsave" : "job_save", id);
  };

  const filteredJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return displayedJobs.filter((job) => {
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
  }, [activeFilter, displayedJobs, savedIds, search]);

  const handleApply = (job: any) => {
    if (!user) { navigate("/auth"); return; }
    if (!isVerified) { navigate("/iit-verify"); return; }
    const applyUrl = safeHttpUrl(job.apply_url);
    if (!job.easy_apply && applyUrl) {
      void recordJobEngagement("job_view_click", job.id, { company: job.company, source: safeHostname(applyUrl) });
      window.open(applyUrl, "_blank", "noopener,noreferrer");
      return;
    }
    void recordJobEngagement("job_easy_apply_click", job.id, { company: job.company });
    apply.mutate(job);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border/70 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-4 pb-3 pt-4 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div><h1 className="text-xl font-bold tracking-tight text-foreground">Jobs</h1><p className="mt-0.5 text-xs text-muted-foreground">Verified opportunities for your community</p></div>
            <div className="flex items-center gap-2"><span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] font-semibold text-muted-foreground">{filteredJobs.length} open</span><button aria-label="Refresh jobs" onClick={() => refetch()} disabled={isFetching} className="rounded-full border border-border p-2 text-muted-foreground hover:text-primary"><RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} /></button></div>
          </div>
          <div className="relative mt-4"><Search className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search role, company, skill, or location" className="h-11 rounded-xl border-border bg-card pl-10" /></div>
          <div className="-mx-4 mt-3 overflow-x-auto px-4 scrollbar-hide sm:-mx-6 sm:px-6"><div className="flex w-max gap-2">{FILTERS.map((filter) => <button key={filter} onClick={() => { setActiveFilter(filter); if (user?.id && filter !== activeFilter) void recordJobEngagement("job_filter", null, { filter }); }} className={`min-h-9 whitespace-nowrap rounded-full px-3.5 text-xs font-semibold transition-colors ${activeFilter === filter ? "bg-primary text-primary-foreground shadow-sm" : "border border-border bg-card text-muted-foreground hover:text-foreground"}`}>{filter === "Saved" && <Bookmark className="mr-1 inline h-3 w-3" />}{filter}</button>)}</div></div>
        </div>
      </header>

      <main className="native-scroll-region flex-1">
        <div className="mx-auto max-w-3xl pb-1 sm:px-6 sm:py-4">
          {focusedJobId && focusedJobFetched && !focusedJob && !error ? <div role="status" className="mb-3 rounded-xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">That job is no longer available.</div> : null}
          {error ? <div className="rounded-2xl border border-destructive/25 bg-destructive/5 p-6 text-center"><BriefcaseBusiness className="mx-auto h-8 w-8 text-destructive" /><h2 className="mt-3 text-sm font-bold">Jobs could not be loaded</h2><p className="mt-1 text-xs text-muted-foreground">Check your connection and try again. If this continues, the jobs database migration may still need deployment.</p><Button variant="outline" className="mt-4 rounded-xl" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /> Try again</Button></div>
            : isLoading ? <div className="divide-y divide-border border-y border-border bg-card sm:overflow-hidden sm:rounded-2xl sm:border">{[1, 2, 3, 4].map((item) => <div key={item} className="flex animate-pulse gap-3 px-4 py-5"><div className="h-12 w-12 rounded-lg bg-secondary" /><div className="flex-1"><div className="h-4 w-2/3 rounded bg-secondary" /><div className="mt-2 h-3 w-1/3 rounded bg-secondary" /><div className="mt-3 h-3 w-1/2 rounded bg-secondary" /></div></div>)}</div>
              : filteredJobs.length ? <div className="divide-y divide-border border-y border-border bg-card sm:overflow-hidden sm:rounded-2xl sm:border">{filteredJobs.map((job) => {
                const skills = (job.skills?.length ? job.skills : inferredSkills(job.title)).slice(0, 5);
                const applied = myApplications.includes(job.id);
                const saved = savedIds.has(job.id);
                const publishedAt = safeDate(job.published_at || job.created_at);
                const sourceUrl = safeHttpUrl(job.source_url);
                const sourceHost = safeHostname(sourceUrl);
                return <article id={`job-${job.id}`} key={job.id} className={`group overflow-hidden px-3 py-3 transition-colors hover:bg-secondary/20 sm:px-5 sm:py-4 ${focusedJobId === job.id ? "bg-primary/5 ring-2 ring-inset ring-primary/35" : ""}`}>
                  <div className="flex min-w-0 items-start gap-2.5 sm:gap-3">
                    <CompanyLogo company={job.company} className="h-10 w-10 sm:h-12 sm:w-12" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start gap-2">
                        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-bold leading-snug text-primary sm:line-clamp-2 sm:whitespace-normal sm:text-[15px]">{job.title}</h2><p className="mt-0.5 truncate text-[11px] font-semibold text-foreground sm:text-xs">{job.company}</p>{job.location && <p className="truncate text-[11px] text-muted-foreground sm:mt-0.5 sm:text-xs">{job.location}</p>}</div>
                        <button aria-label={saved ? "Remove saved job" : "Save job"} onClick={() => toggleSaved(job.id)} className={`-mr-1 -mt-1 shrink-0 rounded-full p-1.5 transition-colors sm:p-2 ${saved ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-primary"}`}><Bookmark className={`h-3.5 w-3.5 sm:h-4 sm:w-4 ${saved ? "fill-current" : ""}`} /></button>
                      </div>
                      <div className="mt-1.5 flex flex-nowrap items-center gap-x-2 overflow-hidden text-[10px] text-muted-foreground sm:mt-2 sm:flex-wrap sm:text-[11px]"><span className="flex shrink-0 items-center gap-1"><Clock3 className="h-3 w-3" />{formatDistanceToNow(publishedAt, { addSuffix: true })}</span>{job.source_type === "scan" && <span className="flex shrink-0 items-center gap-1 text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-3 w-3" />Verified source</span>}{job.easy_apply && <span className="shrink-0 font-semibold text-primary">Easy Apply</span>}</div>
                      {job.description && <p className="mt-2 hidden break-words text-xs leading-relaxed text-muted-foreground sm:line-clamp-2">{job.description}</p>}
                      {!!skills.length && <div className="mt-1.5 flex max-h-6 flex-nowrap gap-1 overflow-hidden sm:mt-2 sm:max-h-none sm:flex-wrap sm:gap-1.5">{skills.slice(0, 3).map((skill: string) => <span key={skill} className="shrink-0 rounded-full bg-secondary px-2 py-1 text-[9px] font-medium leading-none text-foreground sm:text-[10px]">{skill}</span>)}</div>}
                      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 sm:mt-3 sm:flex-wrap"><div className="flex min-w-0 flex-nowrap gap-1 overflow-hidden sm:flex-wrap sm:gap-1.5">{job.job_type && <span className="shrink-0 rounded-full bg-secondary px-2 py-1 text-[9px] font-semibold leading-none sm:text-[10px]">{job.job_type}</span>}{job.experience_level && <span className="shrink-0 rounded-full bg-secondary px-2 py-1 text-[9px] font-semibold leading-none sm:text-[10px]">{job.experience_level}</span>}{job.salary_text && <span className="truncate text-[10px] font-bold text-foreground sm:text-[11px]">{job.salary_text}</span>}</div>{applied ? <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300 sm:h-9 sm:px-3 sm:text-xs"><CheckCircle2 className="h-3.5 w-3.5" />Applied</span> : <Button size="sm" className="h-8 shrink-0 rounded-lg px-2.5 text-[11px] sm:h-9 sm:px-3 sm:text-xs" disabled={apply.isPending && job.easy_apply} onClick={() => handleApply(job)}>{job.easy_apply ? <Zap className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}{job.easy_apply ? "Easy Apply" : "View job"}</Button>}</div>
                      {sourceHost && sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="mt-2 hidden truncate text-[10px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline sm:block">Source: {sourceHost}</a>}
                    </div>
                  </div>
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
