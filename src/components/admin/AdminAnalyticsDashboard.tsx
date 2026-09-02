import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, ArrowDownRight, ArrowUpRight, BadgeCheck, BriefcaseBusiness, CalendarDays,
  BookmarkCheck, CheckCircle2, CircleDollarSign, Clock3, Eye, FileCheck2, GraduationCap,
  MessageCircle, MousePointerClick, RefreshCw, Send, ShieldAlert, Sparkles, UserCheck,
  UserPlus, Users, Workflow,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

type DailyPoint = {
  day: string;
  registrations: number;
  active_users: number;
  sessions: number;
  forum_messages: number;
  direct_messages: number;
  messages: number;
  applications: number;
};
type RetentionPoint = { day: number; eligible: number; returned: number; rate: number };
type DistributionPoint = { label: string; value: number };
type Analytics = {
  generated_at: string;
  timezone: string;
  summary: Record<string, number>;
  daily: DailyPoint[];
  retention: RetentionPoint[];
  top_iits: DistributionPoint[];
  member_status: DistributionPoint[];
};
type JobAnalytics = {
  generated_at: string;
  days: number;
  summary: Record<string, number>;
  daily: Array<{ day: string; page_views: number; unique_visitors: number; view_job_clicks: number; easy_apply_clicks: number; saves: number }>;
  top_jobs: Array<{ id: string; title: string; company: string; view_job_clicks: number; easy_apply_clicks: number; saves: number }>;
  top_companies: DistributionPoint[];
};

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat("en-IN");
const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const pct = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
const safe = (value: unknown) => Number(value) || 0;
const titleCase = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const dateLabel = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

const Trend = ({ current, previous }: { current: number; previous: number }) => {
  if (!previous && !current) return <span className="text-muted-foreground">No change</span>;
  const change = previous ? ((current - previous) / previous) * 100 : 100;
  const positive = change >= 0;
  return <span className={`inline-flex items-center gap-0.5 font-semibold ${positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
    {positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{Math.abs(change).toFixed(0)}%
  </span>;
};

const KpiCard = ({ label, value, note, icon: Icon, current, previous, tone = "blue" }: {
  label: string; value: number | string; note: string; icon: typeof Users; current?: number; previous?: number; tone?: "blue" | "green" | "violet" | "amber";
}) => {
  const tones = {
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  };
  return <article className="group rounded-2xl border border-border/70 bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md">
    <div className="flex items-start justify-between gap-3">
      <div className={`grid h-9 w-9 place-items-center rounded-xl ${tones[tone]}`}><Icon className="h-4.5 w-4.5" /></div>
      {current !== undefined && previous !== undefined && <div className="text-[10px]"><Trend current={current} previous={previous} /></div>}
    </div>
    <p className="mt-4 text-2xl font-black tracking-tight text-foreground">{typeof value === "number" ? compact.format(value) : value}</p>
    <p className="mt-1 text-xs font-bold text-foreground/80">{label}</p>
    <p className="mt-1 min-h-4 text-[10px] leading-relaxed text-muted-foreground">{note}</p>
  </article>;
};

const SectionHeader = ({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) => <div className="flex items-start justify-between gap-3">
  <div><h3 className="text-sm font-black tracking-tight text-foreground">{title}</h3><p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p></div>{action}
</div>;

const AdminAnalyticsDashboard = ({ owner }: { owner: boolean }) => {
  const [range, setRange] = useState<7 | 30 | 90>(30);
  const analytics = useQuery({
    queryKey: ["owner-analytics", range],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_admin_analytics", { p_days: range });
      if (error) throw error;
      return data as Analytics;
    },
    enabled: owner,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
  const jobAnalytics = useQuery({
    queryKey: ["owner-job-analytics", range],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_admin_job_analytics", { p_days: range });
      if (error) throw error;
      return data as JobAnalytics;
    },
    enabled: owner,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const derived = useMemo(() => {
    const daily = analytics.data?.daily ?? [];
    const today = daily.at(-1);
    const yesterday = daily.at(-2);
    const last7 = daily.slice(-7);
    const previous7 = daily.slice(-14, -7);
    const sum = (items: DailyPoint[], key: keyof DailyPoint) => items.reduce((total, item) => total + safe(item[key]), 0);
    return {
      today, yesterday,
      messages7: sum(last7, "messages"), previousMessages7: sum(previous7, "messages"),
      registrations7: sum(last7, "registrations"), previousRegistrations7: sum(previous7, "registrations"),
    };
  }, [analytics.data?.daily]);

  if (!owner) return <div className="rounded-2xl border border-border bg-card p-10 text-center"><ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" /><p className="mt-3 text-sm font-bold">Owner analytics</p><p className="mt-1 text-xs text-muted-foreground">Business intelligence is restricted to the platform owner.</p></div>;
  if (analytics.isLoading) return <div className="grid min-h-[420px] place-items-center rounded-3xl border border-border/60 bg-card"><div className="text-center"><RefreshCw className="mx-auto h-6 w-6 animate-spin text-primary" /><p className="mt-3 text-xs text-muted-foreground">Building your command centre…</p></div></div>;
  if (analytics.error || !analytics.data) return <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive"><p className="font-bold">Analytics could not load</p><p className="mt-1 text-xs">{(analytics.error as Error)?.message || "Apply the latest database migration and refresh."}</p></div>;

  const { summary: s, daily, retention, top_iits: topIits = [], member_status: memberStatus = [] } = analytics.data;
  const messagesToday = safe(s.forum_messages_today) + safe(s.direct_messages_today);
  const verificationRate = pct(safe(s.verified_users), safe(s.total_users));
  const onboardingRate = pct(safe(s.onboarding_completed), safe(s.total_users));
  const dauMau = pct(safe(s.active_users_today), safe(s.active_users_30d));
  const acceptanceRate = pct(safe(s.accepted_connections), safe(s.accepted_connections) + safe(s.pending_connections));
  const jobConversion = pct(safe(s.applications_7d), safe(s.published_jobs));
  const maxIit = Math.max(1, ...topIits.map((item) => safe(item.value)));
  const totalStatus = memberStatus.reduce((total, item) => total + safe(item.value), 0);
  const queueTotal = safe(s.open_reports) + safe(s.pending_documents) + safe(s.pending_courses) + safe(s.pending_consultations);
  const jobSummary = jobAnalytics.data?.summary ?? {};
  const jobClickThroughRate = pct(safe(jobSummary.view_job_clicks) + safe(jobSummary.easy_apply_clicks), safe(jobSummary.page_views));

  const primaryCards = [
    { label: "Total members", value: safe(s.total_users), note: `${compact.format(safe(s.registrations_30d))} joined in the last 30 days`, icon: Users, current: derived.registrations7, previous: derived.previousRegistrations7, tone: "blue" as const },
    { label: "Daily active members", value: safe(s.active_users_today), note: `${dauMau}% DAU / MAU stickiness`, icon: Activity, current: safe(derived.today?.active_users), previous: safe(derived.yesterday?.active_users), tone: "green" as const },
    { label: "Messages today", value: messagesToday, note: `${compact.format(safe(s.forum_messages_today))} forum · ${compact.format(safe(s.direct_messages_today))} direct`, icon: MessageCircle, current: messagesToday, previous: safe(derived.yesterday?.messages), tone: "violet" as const },
    { label: "Operational queue", value: queueTotal, note: queueTotal ? "Items requiring admin attention" : "Everything is caught up", icon: Workflow, tone: queueTotal ? "amber" as const : "green" as const },
  ];

  return <div className="space-y-5">
    <section className="relative overflow-hidden rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/[0.09] via-card to-card p-5 sm:p-6">
      <div className="pointer-events-none absolute -right-16 -top-20 h-52 w-52 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Sparkles className="h-5 w-5" /></div><div><p className="text-[10px] font-black uppercase tracking-[0.2em] text-primary">Founder command centre</p><h2 className="mt-1 text-xl font-black tracking-tight sm:text-2xl">Cirkle business health</h2><p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">Live first-party product intelligence across growth, engagement, trust, marketplace and operations.</p></div></div>
        <div className="flex items-center gap-2 self-start"><div className="hidden rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 sm:block"><span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />Live data</div><Button size="sm" variant="outline" className="h-9 rounded-xl bg-background/70" onClick={() => analytics.refetch()} disabled={analytics.isFetching}><RefreshCw className={`h-3.5 w-3.5 ${analytics.isFetching ? "animate-spin" : ""}`} /><span className="hidden sm:inline">Refresh</span></Button></div>
      </div>
      <div className="relative mt-5 grid grid-cols-2 gap-2 border-t border-border/50 pt-4 sm:grid-cols-4"><div><p className="text-[10px] text-muted-foreground">Verified members</p><p className="mt-0.5 text-sm font-black">{verificationRate}%</p></div><div><p className="text-[10px] text-muted-foreground">Onboarding complete</p><p className="mt-0.5 text-sm font-black">{onboardingRate}%</p></div><div><p className="text-[10px] text-muted-foreground">7-day active</p><p className="mt-0.5 text-sm font-black">{compact.format(safe(s.active_users_7d))}</p></div><div><p className="text-[10px] text-muted-foreground">Last updated</p><p className="mt-0.5 text-sm font-black">{new Date(analytics.data.generated_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p></div></div>
    </section>

    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{primaryCards.map((card) => <KpiCard key={card.label} {...card} />)}</div>

    <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
      <SectionHeader title="Job discovery funnel" description={`First-party engagement over the selected ${range}-day window`} action={jobAnalytics.isFetching ? <RefreshCw className="h-4 w-4 animate-spin text-primary" /> : undefined} />
      {jobAnalytics.error ? (
        <p className="mt-4 rounded-xl bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-200">Job engagement analytics will appear after the latest database migration is active.</p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard label="Job page views" value={safe(jobSummary.page_views)} note={`${compact.format(safe(jobSummary.unique_visitors))} unique members - ${compact.format(safe(jobSummary.unique_sessions))} sessions`} icon={BriefcaseBusiness} tone="blue" />
            <KpiCard label="View job clicks" value={safe(jobSummary.view_job_clicks)} note="Outbound visits to employer application pages" icon={MousePointerClick} tone="violet" />
            <KpiCard label="Job click-through rate" value={`${jobClickThroughRate}%`} note={`${compact.format(safe(jobSummary.easy_apply_clicks))} Easy Apply clicks`} icon={Activity} tone="green" />
            <KpiCard label="Jobs saved" value={safe(jobSummary.saves)} note={`${compact.format(safe(jobSummary.filter_uses))} filter interactions - ${compact.format(safe(jobSummary.unsaves))} unsaved`} icon={BookmarkCheck} tone="amber" />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-border/60 p-3">
              <p className="text-xs font-black">Most engaged jobs</p>
              <div className="mt-2 space-y-1.5">{jobAnalytics.data?.top_jobs?.length ? jobAnalytics.data.top_jobs.slice(0, 5).map((job, index) => (
                <div key={job.id} className="flex items-center gap-2 rounded-xl bg-secondary/40 px-3 py-2"><span className="text-[10px] font-black text-muted-foreground">{index + 1}</span><span className="min-w-0 flex-1"><span className="block truncate text-[11px] font-bold">{job.title}</span><span className="block truncate text-[9px] text-muted-foreground">{job.company}</span></span><span className="text-[10px] font-bold text-primary">{safe(job.view_job_clicks) + safe(job.easy_apply_clicks)} clicks</span></div>
              )) : <p className="py-5 text-center text-[11px] text-muted-foreground">Engagement rankings start with the next member visit.</p>}</div>
            </div>
            <div className="rounded-2xl border border-border/60 p-3">
              <p className="text-xs font-black">Most engaged companies</p>
              <div className="mt-2 space-y-2">{jobAnalytics.data?.top_companies?.length ? jobAnalytics.data.top_companies.slice(0, 5).map((company, index) => (
                <div key={company.label} className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{company.label}</span><div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(8, (safe(company.value) / Math.max(1, safe(jobAnalytics.data?.top_companies?.[0]?.value))) * 100)}%` }} /></div><span className="w-7 text-right text-[10px] font-black">{safe(company.value)}</span></div>
              )) : <p className="py-5 text-center text-[11px] text-muted-foreground">Company demand appears as members open jobs.</p>}</div>
            </div>
          </div>
        </>
      )}
    </section>

    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(300px,0.8fr)]">
      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Growth and engagement" description="Member activity and server-persisted messaging volume" action={<div className="flex rounded-xl bg-secondary p-1">{([7, 30, 90] as const).map((days) => <button key={days} onClick={() => setRange(days)} className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition ${range === days ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{days}D</button>)}</div>} />
        <div className="mt-5 h-72 w-full"><ResponsiveContainer width="100%" height="100%"><AreaChart data={daily} margin={{ top: 5, right: 6, left: -26, bottom: 0 }}><defs><linearGradient id="messagesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.28} /><stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" opacity={0.12} vertical={false} /><XAxis dataKey="day" tickFormatter={dateLabel} tick={{ fontSize: 9 }} minTickGap={28} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 9 }} allowDecimals={false} axisLine={false} tickLine={false} /><Tooltip labelFormatter={(value) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" })} contentStyle={{ borderRadius: 14, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))", fontSize: 11 }} /><Area type="monotone" dataKey="messages" name="Messages" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#messagesFill)" /><Area type="monotone" dataKey="active_users" name="Active members" stroke="#10b981" strokeWidth={2} fill="transparent" /></AreaChart></ResponsiveContainer></div>
        <div className="mt-3 grid grid-cols-3 divide-x divide-border rounded-2xl bg-secondary/45 p-3 text-center"><div><p className="text-[10px] text-muted-foreground">7-day messages</p><p className="mt-1 text-sm font-black">{compact.format(safe(s.messages_7d))}</p></div><div><p className="text-[10px] text-muted-foreground">30-day messages</p><p className="mt-1 text-sm font-black">{compact.format(safe(s.messages_30d))}</p></div><div><p className="text-[10px] text-muted-foreground">All-time messages</p><p className="mt-1 text-sm font-black">{compact.format(safe(s.messages_total))}</p></div></div>
      </section>

      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Action centre" description="Prioritised queues that need a decision" />
        <div className="mt-4 space-y-2.5">{[
          { label: "Member reports", value: s.open_reports, Icon: ShieldAlert, note: "Review safety reports", tone: "text-rose-600 bg-rose-500/10" },
          { label: "Document reviews", value: s.pending_documents, Icon: FileCheck2, note: "Approve identity evidence", tone: "text-amber-600 bg-amber-500/10" },
          { label: "Course requests", value: s.pending_courses, Icon: GraduationCap, note: "Validate new programmes", tone: "text-blue-600 bg-blue-500/10" },
          { label: "Consult requests", value: s.pending_consultations, Icon: Clock3, note: "Coordinate pending sessions", tone: "text-violet-600 bg-violet-500/10" },
        ].map(({ label, value, Icon, note, tone }) => <div key={label} className="flex items-center gap-3 rounded-2xl border border-border/60 p-3"><div className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${tone}`}><Icon className="h-4 w-4" /></div><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold">{label}</p><p className="truncate text-[10px] text-muted-foreground">{note}</p></div><span className={`min-w-7 rounded-full px-2 py-1 text-center text-[11px] font-black ${safe(value) ? "bg-foreground text-background" : "bg-secondary text-muted-foreground"}`}>{compact.format(safe(value))}</span></div>)}</div>
        <div className={`mt-4 flex items-center gap-2 rounded-2xl p-3 ${queueTotal ? "bg-amber-500/10 text-amber-800 dark:text-amber-200" : "bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"}`}>{queueTotal ? <Clock3 className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}<p className="text-[11px] font-semibold">{queueTotal ? `${integer.format(queueTotal)} total items need attention` : "All operational queues are clear"}</p></div>
      </section>
    </div>

    <div className="grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Member quality funnel" description="From registration to a trusted, complete profile" />
        <div className="mt-5 space-y-4">
          {[
            { label: "Registered", value: safe(s.total_users), rate: 100, Icon: Users },
            { label: "Onboarding complete", value: safe(s.onboarding_completed), rate: onboardingRate, Icon: UserCheck },
            { label: "Identity verified", value: safe(s.verified_users), rate: verificationRate, Icon: BadgeCheck },
            { label: "Active in 30 days", value: safe(s.active_users_30d), rate: pct(safe(s.active_users_30d), safe(s.total_users)), Icon: Activity },
          ].map(({ label, value, rate, Icon }) => (
            <div key={label}>
              <div className="mb-1.5 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-1.5 font-semibold"><Icon className="h-3.5 w-3.5 text-primary" />{label}</span>
                <span className="font-black">{compact.format(value)} <span className="font-medium text-muted-foreground">· {rate}%</span></span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-gradient-to-r from-primary to-blue-400 transition-all" style={{ width: `${Math.min(100, rate)}%` }} /></div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Community distribution" description="Largest institute communities by verified profile data" />
        <div className="mt-4 space-y-3">
          {topIits.length ? topIits.map((item, index) => (
            <div key={item.label} className="flex items-center gap-3">
              <span className="w-4 text-[10px] font-bold text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2"><p className="truncate text-[11px] font-semibold">{item.label}</p><p className="text-[10px] font-bold">{compact.format(safe(item.value))}</p></div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary" style={{ width: `${(safe(item.value) / maxIit) * 100}%`, opacity: 1 - index * 0.08 }} /></div>
              </div>
            </div>
          )) : <p className="py-10 text-center text-xs text-muted-foreground">Institute data will appear as profiles are completed.</p>}
        </div>
      </section>

      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5 lg:col-span-2 xl:col-span-1">
        <SectionHeader title="Member lifecycle" description="Current student and alumni mix" />
        <div className="mt-4 h-40"><ResponsiveContainer width="100%" height="100%"><BarChart data={memberStatus} layout="vertical" margin={{ left: 0, right: 12 }}><CartesianGrid strokeDasharray="3 3" opacity={0.1} horizontal={false} /><XAxis type="number" hide /><YAxis type="category" dataKey="label" width={88} tickFormatter={titleCase} tick={{ fontSize: 9 }} axisLine={false} tickLine={false} /><Tooltip formatter={(value) => integer.format(Number(value))} contentStyle={{ borderRadius: 14, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))", fontSize: 11 }} /><Bar dataKey="value" name="Members" fill="hsl(var(--primary))" radius={[0, 8, 8, 0]} barSize={16} /></BarChart></ResponsiveContainer></div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">{integer.format(totalStatus)} classified profiles</p>
      </section>
    </div>

    <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Cohort return rate" description="Members active exactly 1, 2, 3, 7, 14 or 30 days after registration" />
        <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">{retention.map((point) => <div key={point.day} className="rounded-2xl border border-border/60 bg-secondary/35 p-3 text-center"><p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Day {point.day}</p><p className="mt-1 text-lg font-black text-primary">{point.rate}%</p><p className="mt-0.5 text-[9px] text-muted-foreground">{point.returned}/{point.eligible}</p></div>)}</div>
      </section>
      <section className="rounded-3xl border border-border/70 bg-card p-4 shadow-sm sm:p-5">
        <SectionHeader title="Marketplace pulse" description="Jobs, events, connections and consultations" />
        <div className="mt-4 grid grid-cols-2 gap-3">
          {[
            { label: "Live jobs", value: compact.format(safe(s.published_jobs)), Icon: BriefcaseBusiness, note: `${safe(s.applications_7d)} applications · ${jobConversion}% ratio` },
            { label: "Upcoming events", value: compact.format(safe(s.upcoming_events)), Icon: CalendarDays, note: `${safe(s.rsvps_30d)} RSVPs in 30 days` },
            { label: "Accepted connections", value: compact.format(safe(s.accepted_connections)), Icon: UserCheck, note: `${acceptanceRate}% accepted/pending mix` },
            { label: "Consult revenue", value: money.format(safe(s.consultation_revenue)), Icon: CircleDollarSign, note: `${safe(s.completed_consultations)} completed` },
          ].map(({ label, value, Icon, note }) => <div key={label} className="rounded-2xl bg-secondary/45 p-3"><Icon className="h-4 w-4 text-primary" /><p className="mt-2 text-lg font-black">{value}</p><p className="text-[10px] font-bold">{label}</p><p className="mt-1 text-[9px] leading-relaxed text-muted-foreground">{note}</p></div>)}
        </div>
      </section>
    </div>

    <footer className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-secondary/25 px-4 py-3 text-[10px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between"><span className="flex items-center gap-1.5"><Eye className="h-3 w-3" />Owner-only aggregate analytics. No private message content is exposed here.</span><span>{analytics.data.timezone} · Auto-refreshes every 5 minutes</span></footer>
  </div>;
};

export default AdminAnalyticsDashboard;
