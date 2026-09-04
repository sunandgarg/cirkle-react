import { useState } from "react";
import { ArrowLeft, Bell, Check, CheckCheck, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { reportError } from "@/lib/errorTelemetry";
import {
  getNotificationActionLabel,
  getNotificationNavigationTarget,
  type CirkleNotification,
} from "@/lib/notifications";

const PAGE_SIZE = 50;

const Notifications = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["notifications-page", user?.id, page],
    queryFn: async () => {
      if (!user) return { rows: [] as CirkleNotification[], count: 0 };
      const from = page * PAGE_SIZE;
      const response = await supabase.from("notifications")
        .select("*", { count: "exact" })
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (response.error) throw response.error;
      return { rows: (response.data ?? []) as CirkleNotification[], count: response.count ?? 0 };
    },
    enabled: !!user,
    staleTime: 15_000,
  });

  const rows = data?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.count ?? 0) / PAGE_SIZE));
  const unreadOnPage = rows.filter((notification) => !notification.is_read).length;

  const refreshNotifications = () => {
    if (!user) return;
    void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
    void queryClient.invalidateQueries({ queryKey: ["notifications-page", user.id] });
  };

  const markRead = async (notificationId: string) => {
    if (!user) return false;
    const response = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("id", notificationId);
    if (response.error) {
      reportError(response.error, { flow: "notifications", action: "mark_read", metadata: { notificationId } });
      return false;
    }
    refreshNotifications();
    return true;
  };

  const markAllRead = async () => {
    if (!user) return;
    const response = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("is_read", false);
    if (response.error) {
      reportError(response.error, { flow: "notifications", action: "mark_all_read" });
      return;
    }
    refreshNotifications();
  };

  const openNotification = async (notification: CirkleNotification) => {
    const target = getNotificationNavigationTarget(notification);
    if (!target) return;
    if (!notification.is_read && !(await markRead(notification.id))) return;
    navigate(target);
  };

  return (
    <div className="min-h-full bg-background px-4 py-5">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" onClick={() => navigate(-1)} className="rounded-full p-2 text-foreground hover:bg-accent" aria-label="Go back">
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <h1 className="text-xl font-bold text-foreground">Notifications</h1>
              <p className="text-xs text-muted-foreground">Account, network, job and call updates</p>
            </div>
          </div>
          {unreadOnPage > 0 && (
            <Button type="button" size="sm" variant="outline" className="shrink-0 rounded-full" onClick={() => void markAllRead()}>
              <CheckCheck className="mr-1.5 h-4 w-4" /> Mark all read
            </Button>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2" aria-label="Loading notifications">
            {[0, 1, 2].map((item) => <div key={item} className="h-24 animate-pulse rounded-2xl bg-muted/60" />)}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 text-center">
            <p className="text-sm font-semibold text-foreground">Notifications could not be loaded</p>
            <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : rows.length ? (
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            {rows.map((notification) => {
              const action = getNotificationActionLabel(notification);
              return (
                <article key={notification.id} className={`border-b border-border p-4 last:border-0 ${notification.is_read ? "" : "bg-primary/5"}`}>
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${notification.is_read ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                      <Bell className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="text-sm font-semibold text-foreground">{notification.title || "Notification"}</h2>
                          {notification.message && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{notification.message}</p>}
                        </div>
                        {!notification.is_read && (
                          <button type="button" className="rounded-lg p-1.5 text-primary hover:bg-primary/10" onClick={() => void markRead(notification.id)} aria-label={`Mark ${notification.title || "notification"} as read`} title="Mark as read">
                            <Check className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <time className="text-[10px] text-muted-foreground" dateTime={notification.created_at}>{formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}</time>
                        {action && <Button type="button" size="sm" variant="ghost" className="h-7 rounded-full px-3 text-xs text-primary" onClick={() => void openNotification(notification)}>{action}</Button>}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border py-16 text-center">
            <Bell className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <h2 className="mt-3 text-sm font-semibold text-foreground">No notifications yet</h2>
            <p className="mt-1 text-xs text-muted-foreground">New account activity will appear here.</p>
          </div>
        )}

        {totalPages > 1 && (
          <nav className="mt-4 flex items-center justify-between" aria-label="Notification pages">
            <Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}><ChevronLeft className="mr-1 h-4 w-4" /> Previous</Button>
            <span className="text-xs text-muted-foreground">Page {page + 1} of {totalPages}</span>
            <Button type="button" variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage((current) => current + 1)}>Next <ChevronRight className="ml-1 h-4 w-4" /></Button>
          </nav>
        )}
      </div>
    </div>
  );
};

export default Notifications;
