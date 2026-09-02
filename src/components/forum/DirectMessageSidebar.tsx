import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { MessageCircle, Plus, UserRoundCheck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useRealtimeActivity } from "@/hooks/useRealtimeActivity";
import { appSyncRealtimeEnabled, subscribeAppSync } from "@/lib/appsyncEvents";
import {
  getDirectMessageNavigationTarget,
  getDirectMessagePreview,
  normalizeDirectMessageSidebarRow,
  type DirectMessageSidebarRow,
} from "@/lib/directMessages";
import { reportError } from "@/lib/errorTelemetry";

const initials = (name: string | null) => {
  const parts = (name || "Cirkle member").trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] || ""}` : parts[0]?.[0] || "C").toUpperCase();
};

type Props = { onNavigate?: () => void };

const DirectMessageSidebar = ({ onNavigate }: Props) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const realtimeActive = useRealtimeActivity();

  const { data: conversations = [], isLoading } = useQuery({
    queryKey: ["direct-message-sidebar", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_direct_message_sidebar");
      if (error) throw error;
      return ((data || []) as DirectMessageSidebarRow[]).map(normalizeDirectMessageSidebarRow);
    },
    enabled: Boolean(user?.id),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const { data: pendingCount = 0 } = useQuery({
    queryKey: ["direct-message-pending-requests", user?.id],
    queryFn: async () => {
      const { count, error } = await supabase.from("connections").select("id", { count: "exact", head: true })
        .eq("receiver_id", user!.id).eq("status", "pending");
      if (error) throw error;
      return count || 0;
    },
    enabled: Boolean(user?.id),
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!user?.id || !realtimeActive) return;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["direct-message-sidebar", user.id] });
      void queryClient.invalidateQueries({ queryKey: ["direct-message-pending-requests", user.id] });
      void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user.id] });
    };

    if (appSyncRealtimeEnabled) {
      const unsubscribeInbox = subscribeAppSync(`/inbox/${user.id}`, refresh, (status) => {
        if (status === "CHANNEL_ERROR") {
          reportError(new Error("Direct-message inbox realtime subscription failed"), {
            flow: "direct_messages", action: "subscribe_inbox",
          });
        }
      });
      return unsubscribeInbox;
    }

    const fallbackChannel = supabase.channel(`direct-message-sidebar-${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "connections" }, refresh)
      .subscribe();
    return () => { void supabase.removeChannel(fallbackChannel); };
  }, [queryClient, realtimeActive, user?.id]);

  const go = (path: string) => {
    onNavigate?.();
    navigate(path);
  };

  return (
    <section className="mt-5 border-t border-border/70 pt-3" aria-label="Direct messages">
      <div className="flex items-center justify-between px-4 pb-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Direct messages</p>
        <button onClick={() => go("/network?tab=connected")} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Start a direct message" title="Message a connection">
          <Plus className="h-4 w-4" />
        </button>
      </div>

      {pendingCount > 0 && (
        <button onClick={() => go("/network?tab=pending")} className="mx-2 mb-2 flex w-[calc(100%-1rem)] items-center gap-2 rounded-xl bg-primary/8 px-3 py-2 text-left hover:bg-primary/12">
          <UserRoundCheck className="h-4 w-4 text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">Connection requests</span>
          <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">{pendingCount > 99 ? "99+" : pendingCount}</span>
        </button>
      )}

      {isLoading && conversations.length === 0 ? (
        <div className="space-y-2 px-3" aria-label="Loading direct messages">
          {[0, 1].map((item) => <div key={item} className="h-11 animate-pulse rounded-xl bg-muted/60" />)}
        </div>
      ) : conversations.length > 0 ? (
        <div className="space-y-0.5 px-2">
          {conversations.map((conversation) => {
            const lastAt = conversation.last_message?.created_at;
            return (
              <button key={conversation.connection_id} onClick={() => go(getDirectMessageNavigationTarget(conversation))} className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-accent/70">
                <div className="relative h-9 w-9 flex-shrink-0 overflow-hidden rounded-full bg-primary/10">
                  {conversation.display_avatar ? <img src={conversation.display_avatar} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <span className="flex h-full w-full items-center justify-center text-xs font-bold text-primary">{initials(conversation.display_name)}</span>}
                  <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-card bg-emerald-500" aria-hidden="true" />
                </div>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={`min-w-0 flex-1 truncate text-xs ${conversation.unread_count ? "font-bold text-foreground" : "font-semibold text-foreground/90"}`}>{conversation.display_name}</span>
                    {lastAt && <span className="text-[9px] text-muted-foreground">{formatDistanceToNowStrict(new Date(lastAt), { addSuffix: false })}</span>}
                  </span>
                  <span className={`block truncate text-[10px] ${conversation.unread_count ? "font-semibold text-foreground/75" : "text-muted-foreground"}`}>{getDirectMessagePreview(conversation)}</span>
                </span>
                {conversation.unread_count > 0 && <span className="flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-bold text-primary-foreground">{conversation.unread_count > 99 ? "99+" : conversation.unread_count}</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <button onClick={() => go("/network")} className="mx-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-left text-[11px] text-muted-foreground hover:border-primary/30 hover:bg-primary/5 hover:text-foreground">
          <MessageCircle className="h-4 w-4 text-primary" />
          Connect with a member to start a private chat
        </button>
      )}
    </section>
  );
};

export default DirectMessageSidebar;
