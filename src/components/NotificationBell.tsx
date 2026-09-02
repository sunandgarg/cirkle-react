import { useState, useEffect } from "react";
import { Bell, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { reportError } from "@/lib/errorTelemetry";

const NotificationBell = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const { data: notifications } = useQuery({
    queryKey: ["notifications", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.from("notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
    staleTime: 15000,
  });

  const unreadCount = notifications?.filter((n: any) => !n.is_read).length || 0;

  // Realtime notifications
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`notifications-realtime-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${user.id}` }, () => {
        void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, queryClient]);

  const markAllRead = async () => {
    if (!user) return;
    const { error } = await supabase.from("notifications").update({ is_read: true }).eq("user_id", user.id).eq("is_read", false);
    if (error) {
      reportError(error, { flow: "notifications", action: "mark_all_read" });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ["notifications", user.id] });
  };

  if (!user) return null;

  return (
    <div className="relative">
      <button onClick={() => { setOpen(!open); if (!open && unreadCount > 0) markAllRead(); }}
        className={`relative rounded-full p-2.5 transition-colors hover-scale ${unreadCount > 0 ? "bg-amber-100 text-amber-700 ring-1 ring-amber-300/80 hover:bg-amber-200 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"} aria-expanded={open}>
        <Bell className="w-6 h-6" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 max-h-96 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-border bg-card shadow-xl animate-fade-in">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h3 className="font-bold text-sm text-foreground">Notifications</h3>
            <button onClick={() => setOpen(false)} className="text-muted-foreground"><X className="w-4 h-4" /></button>
          </div>
          <div className="overflow-y-auto max-h-80">
            {notifications?.length ? notifications.map((n: any) => (
              <div key={n.id} className={`px-4 py-3 border-b border-border last:border-0 ${!n.is_read ? "bg-primary/5" : ""}`}>
                <p className="text-sm font-medium text-foreground">{n.title}</p>
                {n.message && <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>}
                <div className="mt-1 flex items-center justify-between gap-2">
                  <p className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}</p>
                  {n.type === "connection_request" && <button className="rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-bold text-primary hover:bg-primary/15" onClick={() => { setOpen(false); navigate("/network?tab=pending"); }}>Review request</button>}
                  {n.type === "connection_response" && <button className="rounded-full bg-secondary px-2.5 py-1 text-[10px] font-bold text-foreground hover:bg-accent" onClick={() => { setOpen(false); navigate("/network?tab=connected"); }}>View network</button>}
                </div>
              </div>
            )) : (
              <div className="py-8 text-center"><p className="text-sm text-muted-foreground">No notifications yet</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
