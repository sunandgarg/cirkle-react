import { useDeferredValue, useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, MessageCircle, Search, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNowStrict } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useRealtimeActivity } from "@/hooks/useRealtimeActivity";
import { appSyncRealtimeEnabled, subscribeAppSync } from "@/lib/appsyncEvents";
import {
  getConnectionMessageNavigationTarget,
  getDirectMessageNavigationTarget,
  getDirectMessagePreview,
  hasStartedDirectMessageConversation,
  normalizeDirectMessageSidebarRow,
  type DirectMessageSidebarRow,
  type DirectMessageConnectionResult,
} from "@/lib/directMessages";
import { reportError } from "@/lib/errorTelemetry";
import { toast } from "sonner";

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
  const subscriptionId = useId().replace(/:/g, "");
  const [connectionSearch, setConnectionSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [openingPeerId, setOpeningPeerId] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(connectionSearch.trim());

  const { data: conversations = [], isLoading } = useQuery({
    queryKey: ["direct-message-sidebar", user?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("get_direct_message_sidebar");
      if (error) {
        reportError(error, { flow: "forum_navigation", action: "load_direct_message_sidebar", severity: "warning" });
        return [];
      }
      return ((data || []) as DirectMessageSidebarRow[])
        .map(normalizeDirectMessageSidebarRow)
        .filter(hasStartedDirectMessageConversation);
    },
    enabled: Boolean(user?.id),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const { data: connectionResults = [], isFetching: connectionsLoading } = useQuery({
    queryKey: ["direct-message-connection-search", user?.id, deferredSearch],
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("search_my_connections", {
        p_query: deferredSearch,
        p_limit: 8,
      });
      if (error) {
        reportError(error, { flow: "forum_navigation", action: "search_direct_message_connections", severity: "warning" });
        return [];
      }
      return (data || []) as DirectMessageConnectionResult[];
    },
    enabled: Boolean(user?.id && searchFocused),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!user?.id || !realtimeActive) return;
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ["direct-message-sidebar", user.id] });
      void queryClient.invalidateQueries({ queryKey: ["direct-message-connection-search", user.id] });
      void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user.id] });
    };

    const connectionChannel = supabase.channel(`direct-message-connections-${user.id}-${subscriptionId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "connections" }, refresh)
      .subscribe();

    let fallbackChannel: ReturnType<typeof supabase.channel> | null = null;
    let appSyncErrorReported = false;
    const startFallback = () => {
      if (fallbackChannel) return;
      fallbackChannel = supabase.channel(`direct-message-sidebar-${user.id}-${subscriptionId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refresh)
        .subscribe();
    };

    if (appSyncRealtimeEnabled) {
      const unsubscribeInbox = subscribeAppSync(`/inbox/${user.id}`, refresh, (status) => {
        if (status === "CHANNEL_ERROR") {
          if (!appSyncErrorReported) {
            appSyncErrorReported = true;
            reportError(new Error("Direct-message inbox realtime subscription failed; durable fallback activated"), {
              flow: "direct_messages", action: "subscribe_inbox", severity: "warning",
            });
          }
          startFallback();
        }
      });
      return () => {
        unsubscribeInbox();
        void supabase.removeChannel(connectionChannel);
        if (fallbackChannel) void supabase.removeChannel(fallbackChannel);
      };
    }

    startFallback();
    return () => {
      void supabase.removeChannel(connectionChannel);
      if (fallbackChannel) void supabase.removeChannel(fallbackChannel);
    };
  }, [queryClient, realtimeActive, subscriptionId, user?.id]);

  const go = (path: string) => {
    onNavigate?.();
    navigate(path);
  };

  const openConnectionChat = async (connection: DirectMessageConnectionResult) => {
    if (openingPeerId) return;
    if (connection.room_id) {
      go(getConnectionMessageNavigationTarget(connection));
      return;
    }
    setOpeningPeerId(connection.peer_id);
    try {
      const { data: roomId, error } = await supabase.rpc("get_or_create_direct_chat", { p_peer_id: connection.peer_id });
      if (error) throw error;
      if (!roomId) throw new Error("Private chat could not be created");
      void queryClient.invalidateQueries({ queryKey: ["direct-message-sidebar", user?.id] });
      void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user?.id] });
      go(`/chats/${roomId}`);
    } catch (error: unknown) {
      reportError(error, { flow: "direct_messages", action: "start_from_forum_sidebar", metadata: { peerId: connection.peer_id } });
      toast.error(error instanceof Error ? error.message : "Could not start this private chat");
    } finally {
      setOpeningPeerId(null);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col border-t border-border/70 pt-3" aria-label="Direct messages">
      <div className="flex flex-shrink-0 items-center justify-between px-4 pb-2">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Direct messages</p>
      </div>

      <div className="relative z-10 flex-shrink-0 px-3 pb-2">
        <Search className="pointer-events-none absolute left-5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
        <input
          value={connectionSearch}
          onChange={(event) => setConnectionSearch(event.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
          placeholder="Search your connections"
          aria-label="Search your connections to start a direct message"
          className="h-9 w-full rounded-xl border border-border bg-muted/45 pl-8 pr-8 text-xs text-foreground outline-none transition focus:border-primary/40 focus:bg-card focus:ring-2 focus:ring-primary/10"
        />
        {connectionsLoading ? (
          <Loader2 className="absolute right-5 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : connectionSearch ? (
          <button type="button" onClick={() => setConnectionSearch("")} className="absolute right-4 top-1.5 grid h-6 w-6 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Clear connection search">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {searchFocused && (
          <div className="absolute left-3 right-3 top-11 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
            {connectionResults.length ? connectionResults.map((connection) => (
              <button
                key={connection.peer_id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void openConnectionChat(connection)}
                disabled={Boolean(openingPeerId)}
                className="flex w-full items-center gap-2.5 border-b border-border/60 px-3 py-2.5 text-left last:border-0 hover:bg-accent/70"
              >
                <div className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-full bg-primary/10">
                  {connection.display_avatar ? <img src={connection.display_avatar} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <span className="flex h-full w-full items-center justify-center text-[11px] font-bold text-primary">{initials(connection.display_name)}</span>}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-semibold text-foreground">{connection.display_name || "Cirkle member"}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{connection.headline || (connection.room_id ? "Open conversation" : "Start a private chat")}</span>
                </span>
                {openingPeerId === connection.peer_id ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary" /> : <MessageCircle className="h-3.5 w-3.5 flex-shrink-0 text-primary" />}
              </button>
            )) : (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                {connectionsLoading ? "Finding connections…" : deferredSearch ? "No matching connections" : "No connections yet"}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="native-scroll-region min-h-0 flex-1 overscroll-contain pb-2" data-testid="direct-message-scroll-region">
      {isLoading && conversations.length === 0 ? (
        <div className="space-y-2 px-3" aria-label="Loading direct messages">
          {[0, 1].map((item) => <div key={item} className="h-11 animate-pulse rounded-xl bg-muted/60" />)}
        </div>
      ) : conversations.length > 0 ? (
        <div className="space-y-0.5 px-2" aria-label="Started direct-message conversations">
          {conversations.map((conversation) => {
            const lastAt = conversation.last_message?.created_at;
            return (
              <button key={conversation.connection_id} onClick={() => go(getDirectMessageNavigationTarget(conversation))} className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-accent/70">
                <div className="h-9 w-9 flex-shrink-0 overflow-hidden rounded-full bg-primary/10">
                  {conversation.display_avatar ? <img src={conversation.display_avatar} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" /> : <span className="flex h-full w-full items-center justify-center text-xs font-bold text-primary">{initials(conversation.display_name)}</span>}
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
        <div className="mx-3 rounded-xl border border-dashed border-border px-3 py-4 text-center">
          <MessageCircle className="mx-auto h-4 w-4 text-primary" />
          <p className="mt-1.5 text-[11px] font-medium text-foreground">No private chats yet</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">Search a connection above to begin.</p>
        </div>
      )}
      </div>
    </section>
  );
};

export default DirectMessageSidebar;
