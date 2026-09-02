import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const severityClass: Record<string, string> = {
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  error: "bg-destructive/10 text-destructive",
  fatal: "bg-red-700/10 text-red-700 dark:text-red-300",
};

const AdminErrorLogs = () => {
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState("all");
  const { data: logs = [], isFetching, refetch } = useQuery({
    queryKey: ["admin-client-error-logs"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("client_error_logs")
        .select("event_id,user_id,flow,action,severity,message,error_code,stack,route,metadata,client_timestamp,created_at")
        .order("created_at", { ascending: false })
        .limit(250);
      if (error) throw error;
      const rows = (data ?? []) as any[];
      const userIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => typeof id === "string"))];
      if (!userIds.length) return rows;
      const { data: profiles } = await supabase.from("profiles").select("user_id,name").in("user_id", userIds);
      const names = new Map((profiles ?? []).map((profile) => [profile.user_id, profile.name]));
      return rows.map((row) => ({ ...row, user_name: row.user_id ? names.get(row.user_id) : null }));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const visibleLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = logs.filter((log: any) => {
      if (severity !== "all" && log.severity !== severity) return false;
      if (!query) return true;
      return [log.flow, log.action, log.message, log.error_code, log.route, log.user_name, log.event_id]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
    const grouped = new Map<string, any>();
    for (const log of filtered) {
      const key = [log.flow, log.action, log.severity, log.error_code, log.message, log.route].join("|");
      const current = grouped.get(key);
      if (current) {
        current.occurrences += 1;
        current.event_ids.push(log.event_id);
        if (!current.users.has(log.user_id || "anonymous")) current.users.add(log.user_id || "anonymous");
      } else {
        grouped.set(key, { ...log, occurrences: 1, event_ids: [log.event_id], users: new Set([log.user_id || "anonymous"]) });
      }
    }
    return [...grouped.values()];
  }, [logs, search, severity]);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-bold"><AlertTriangle className="h-4 w-4 text-primary" /> Application error trail</h2>
          <p className="mt-1 text-xs text-muted-foreground">Latest 250 redacted events grouped into {visibleLogs.length} root causes, with occurrence and affected-member counts.</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" disabled={isFetching} onClick={() => void refetch()}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search flow, action, error or event ID" className="pl-9" /></div>
        <select value={severity} onChange={(event) => setSeverity(event.target.value)} className="h-10 rounded-md border border-border bg-card px-3 text-sm">
          <option value="all">All severities</option><option value="fatal">Fatal</option><option value="error">Error</option><option value="warning">Warning</option>
        </select>
      </div>

      <div className="space-y-2">
        {visibleLogs.map((log: any) => (
          <details key={log.event_id} className="group rounded-xl border border-border bg-card p-3 open:shadow-sm">
            <summary className="flex cursor-pointer list-none items-start gap-3">
              <span className={`mt-0.5 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${severityClass[log.severity] || severityClass.error}`}>{log.severity}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-foreground">{log.flow} → {log.action} {log.occurrences > 1 && <span className="ml-1 rounded-full bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">{log.occurrences} occurrences</span>}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{log.message}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">Latest {new Date(log.created_at).toLocaleString()} · {log.users.size} affected member{log.users.size === 1 ? "" : "s"} · {log.route || "unknown route"}</p>
              </div>
            </summary>
            <div className="mt-3 space-y-2 border-t border-border pt-3 text-[11px]">
              <p><span className="font-semibold">Event:</span> <code className="select-all">{log.event_id}</code></p>
              {log.occurrences > 1 && <p><span className="font-semibold">Grouped events:</span> {log.event_ids.slice(0, 8).join(", ")}{log.event_ids.length > 8 ? ` +${log.event_ids.length - 8} more` : ""}</p>}
              {log.error_code && <p><span className="font-semibold">Code:</span> {log.error_code}</p>}
              {log.stack && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary p-2 text-[10px]">{log.stack}</pre>}
              {log.metadata && Object.keys(log.metadata).length > 0 && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-secondary p-2 text-[10px]">{JSON.stringify(log.metadata, null, 2)}</pre>}
            </div>
          </details>
        ))}
        {!visibleLogs.length && <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">No matching errors.</div>}
      </div>
    </section>
  );
};

export default AdminErrorLogs;
