import { useQuery } from "@tanstack/react-query";
import { Activity, BriefcaseBusiness, Clock3, MessageCircle, RefreshCw, Send, UserPlus, Users } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

type DailyPoint = { day: string; registrations: number; active_users: number; sessions: number; messages: number };
type RetentionPoint = { day: number; eligible: number; returned: number; rate: number };
type Analytics = {
  generated_at: string;
  timezone: string;
  summary: {
    total_users: number;
    registrations_today: number;
    active_users_today: number;
    sessions_today: number;
    forum_messages_today: number;
    direct_messages_today: number;
    messages_7d: number;
    messages_total: number;
    published_jobs: number;
    applications_today: number;
  };
  daily: DailyPoint[];
  retention: RetentionPoint[];
};

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

const AdminAnalyticsDashboard = ({ owner }: { owner: boolean }) => {
  const analytics = useQuery({
    queryKey: ["owner-analytics", 30],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_admin_analytics", { p_days: 30 });
      if (error) throw error;
      return data as Analytics;
    },
    enabled: owner,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (!owner) return <div className="rounded-2xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">The business dashboard is restricted to the platform owner.</div>;
  if (analytics.isLoading) return <div className="grid min-h-64 place-items-center"><RefreshCw className="h-6 w-6 animate-spin text-primary" /></div>;
  if (analytics.error || !analytics.data) return <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive"><p className="font-bold">Analytics could not load</p><p className="mt-1 text-xs">{(analytics.error as Error)?.message || "Try refreshing after the database migration is active."}</p></div>;

  const { summary, daily, retention } = analytics.data;
  const messagesToday = Number(summary.forum_messages_today) + Number(summary.direct_messages_today);
  const cards = [
    ["Total members", summary.total_users, Users, "All registered accounts"],
    ["Registered today", summary.registrations_today, UserPlus, "New accounts in India time"],
    ["Active today", summary.active_users_today, Activity, "Unique members seen today"],
    ["Sessions today", summary.sessions_today, Clock3, "New browser sessions"],
    ["Messages today", messagesToday, MessageCircle, `${summary.forum_messages_today} forum · ${summary.direct_messages_today} direct`],
    ["Messages, 7 days", summary.messages_7d, Send, "Forum and direct combined"],
    ["All messages", summary.messages_total, MessageCircle, "Server-stored total"],
    ["Live jobs", summary.published_jobs, BriefcaseBusiness, `${summary.applications_today} applications today`],
  ] as const;

  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="text-lg font-black">Business health</h2><p className="text-xs text-muted-foreground">Live first-party product KPIs · Asia/Kolkata</p></div>
      <Button size="sm" variant="outline" className="rounded-xl" onClick={() => analytics.refetch()} disabled={analytics.isFetching}><RefreshCw className={`h-3.5 w-3.5 ${analytics.isFetching ? "animate-spin" : ""}`} /> Refresh</Button>
    </div>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{cards.map(([label, value, Icon, note]) => <article key={label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2"><p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p><Icon className="h-4 w-4 text-primary" /></div>
      <p className="mt-2 text-2xl font-black">{compact.format(Number(value))}</p><p className="mt-1 truncate text-[10px] text-muted-foreground">{note}</p>
    </article>)}</div>

    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <div><h3 className="text-sm font-bold">30-day activity</h3><p className="text-[11px] text-muted-foreground">Daily active members and server-stored messages</p></div>
      <div className="mt-4 h-64 w-full"><ResponsiveContainer width="100%" height="100%"><LineChart data={daily} margin={{ top: 5, right: 8, left: -24, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" opacity={0.18} /><XAxis dataKey="day" tickFormatter={(value) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} tick={{ fontSize: 10 }} minTickGap={24} /><YAxis tick={{ fontSize: 10 }} allowDecimals={false} /><Tooltip labelFormatter={(value) => new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", { dateStyle: "medium" })} /><Line type="monotone" dataKey="messages" name="Messages" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} /><Line type="monotone" dataKey="active_users" name="Active members" stroke="#10b981" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer></div>
    </section>

    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-sm font-bold">Cohort return rate</h3><p className="text-[11px] text-muted-foreground">Members active exactly 1, 2, 3, 7, 14 or 30 days after registration. Tracking improves from this release onward.</p>
      <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">{retention.map((point) => <div key={point.day} className="rounded-xl bg-secondary/60 p-3 text-center"><p className="text-[10px] font-bold uppercase text-muted-foreground">Day {point.day}</p><p className="mt-1 text-lg font-black text-primary">{point.rate}%</p><p className="text-[9px] text-muted-foreground">{point.returned}/{point.eligible}</p></div>)}</div>
    </section>
  </div>;
};

export default AdminAnalyticsDashboard;
