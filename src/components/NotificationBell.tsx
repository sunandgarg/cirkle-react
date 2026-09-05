import { useEffect, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { reportError } from "@/lib/errorTelemetry";
import {
  getNotificationActionLabel,
  getNotificationNavigationTarget,
  type CirkleNotification,
} from "@/lib/notifications";
import { useDailyCallsEnabled } from "@/hooks/useRuntimeFeatures";

const NotificationBell = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const callsEnabled = useDailyCallsEnabled();
  const [open, setOpen] = useState(false);

  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.from("notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return (data ?? []) as CirkleNotification[];
    },
    enabled: !!user,
    staleTime: 15_000,
  });

  const unreadCount = notifications.filter((notification) => !notification.is_read).length;

  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`notifications-realtime-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` }, () => {
        void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
        void queryClient.invalidateQueries({ queryKey: ["notifications-page", user.id] });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user, queryClient]);

  const markRead = async (notificationId: string) => {
    if (!user) return;
    const { error } = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("id", notificationId);
    if (error) {
      reportError(error, { flow: "notifications", action: "mark_read", metadata: { notificationId } });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
    void queryClient.invalidateQueries({ queryKey: ["notifications-page", user.id] });
  };

  const markAllRead = async () => {
    if (!user) return;
    const { error } = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("is_read", false);
    if (error) {
      reportError(error, { flow: "notifications", action: "mark_all_read" });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
    void queryClient.invalidateQueries({ queryKey: ["notifications-page", user.id] });
  };

  const openNotification = async (notification: CirkleNotification) => {
    const target = getNotificationNavigationTarget(notification, { dailyCallsEnabled: callsEnabled });
    if (!target) return;
    if (!notification.is_read) await markRead(notification.id);
    setOpen(false);
    navigate(target);
  };

  if (!user) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`relative rounded-full p-2.5 transition-colors hover-scale ${unreadCount > 0 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300/80 hover:bg-amber-200 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <Bell className="h-6 w-6" />
        {unreadCount > 0 && (
          <span className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 max-h-96 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-border bg-card shadow-xl animate-fade-in" role="dialog" aria-label="Recent notifications">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-bold text-foreground">Notifications</h2>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button type="button" onClick={() => void markAllRead()} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Mark all notifications as read" title="Mark all as read">
                  <CheckCheck className="h-4 w-4" />
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close notifications">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {notifications.length ? notifications.map((notification) => {
              const action = getNotificationActionLabel(notification, { dailyCallsEnabled: callsEnabled });
              return (
                <div key={notification.id} className={`border-b border-border px-4 py-3 last:border-0 ${!notification.is_read ? "bg-primary/5" : ""}`}>
                  <p className="text-sm font-medium text-foreground">{notification.title || "Notification"}</p>
                  {notification.message && <p className="mt-0.5 text-xs text-muted-foreground">{notification.message}</p>}
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <p className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}</p>
                    {action && (
                      <button type="button" className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary hover:bg-primary/15" onClick={() => void openNotification(notification)}>
                        {action}
                      </button>
                    )}
                  </div>
                </div>
              );
            }) : (
              <div className="py-8 text-center"><p className="text-sm text-muted-foreground">No notifications yet</p></div>
            )}
          </div>
          <button type="button" onClick={() => { setOpen(false); navigate("/notifications"); }} className="w-full border-t border-border px-4 py-2.5 text-xs font-semibold text-primary hover:bg-accent/60">
            View all notifications
          </button>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
