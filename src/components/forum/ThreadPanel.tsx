import { useState, useRef, useEffect } from "react";
import { X, Send, Reply, EyeOff, LocateFixed } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import { toast } from "sonner";
import { renderFormattedMessage } from "./MessageFormatting";
import { appendForumTestPost, getForumTestPosts } from "@/hooks/useForumCache";
import { readMobileTestSession } from "@/lib/mobileVerification";
import {
  forumSendFingerprint, resolveForumSendIdentity,
  type ForumSendIdentity, type ForumSendSnapshot,
} from "@/lib/forumSend";
import { hydrateForumMediaUrls } from "@/lib/forumMedia";
import { publishForumOutboxItem } from "@/lib/forumPublisher";
import {
  deleteForumOutboxItem, listForumOutboxItems, markForumOutboxFailed,
  putForumOutboxItem, subscribeForumOutbox, type ForumOutboxItem,
} from "@/lib/forumOutbox";
import { getForumBroadcastRow } from "@/lib/forumRealtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { appSyncRealtimeEnabled, subscribeAppSync } from "@/lib/appsyncEvents";

const THREAD_PAGE_SIZE = 50;

const AVATAR_COLORS = [
  "bg-[hsl(0,55%,55%)]", "bg-[hsl(120,35%,45%)]", "bg-[hsl(210,55%,50%)]", "bg-[hsl(30,65%,50%)]",
  "bg-[hsl(330,45%,50%)]", "bg-[hsl(260,45%,55%)]", "bg-[hsl(180,45%,45%)]", "bg-[hsl(45,60%,48%)]",
];
const getUserColor = (userId: string) => {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
};
const getInitials = (name?: string | null): string => {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
};

const sortThreadReplies = (replies: any[]) => [...replies].sort((left, right) => {
  const byTime = new Date(left.created_at || 0).getTime() - new Date(right.created_at || 0).getTime();
  return byTime || String(left.id || "").localeCompare(String(right.id || ""));
});
const sortThreadPageDescending = (replies: any[]) => sortThreadReplies(replies).reverse();

interface ThreadPanelProps {
  parentPost: any;
  onClose: () => void;
  onJumpToParent: () => void;
  activeScope: { type: string; key: string };
  profileMap: Map<string, any>;
  navigate: (path: string) => void;
}

const ThreadPanel = ({ parentPost, onClose, onJumpToParent, activeScope, profileMap, navigate }: ThreadPanelProps) => {
  const { user, profile } = useAuth();
  const queryClient = useQueryClient();
  const [content, setContent] = useState("");
  const [isAnonymous, setIsAnonymous] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendIdentityRef = useRef<ForumSendIdentity | null>(null);
  const followLiveRef = useRef(true);
  const initialScrollDoneRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const [queuedReplies, setQueuedReplies] = useState<ForumOutboxItem[]>([]);
  const testSession = readMobileTestSession();

  // Fetch thread replies
  const { data: threadData, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ["thread-replies", parentPost.id],
    initialPageParam: null as { createdAt: string; id: string } | null,
    queryFn: async ({ pageParam }) => {
      if (testSession) {
        const saved = getForumTestPosts(activeScope.type, activeScope.key)
          .filter((post) => post.reply_to_id === parentPost.id);
        if (saved.length) return saved;
        return Array.from({ length: parentPost.replyCount || 0 }, (_, index) => ({
          id: `demo-thread-${parentPost.id}-${index}`,
          author_id: `demo-thread-user-${index}`,
          content: `Cohort reply ${index + 1} — following up in this focused discussion.`,
          created_at: new Date(Date.now() - (parentPost.replyCount - index) * 60_000).toISOString(),
          is_anonymous: false,
          profile: { name: ["Aditi Rao", "Kabir Khanna", "Meera Joshi"][index % 3], avatar_url: null, slug: null },
        }));
      }
      const { data, error } = await (supabase as any).rpc("get_forum_thread_page", {
        p_parent_id: parentPost.id, p_limit: THREAD_PAGE_SIZE,
        p_before_created_at: pageParam?.createdAt || null, p_before_id: pageParam?.id || null,
      });
      if (error) {
        let query = supabase.from("posts").select("*").eq("reply_to_id", parentPost.id)
          .is("deleted_at", null).order("created_at", { ascending: false }).order("id", { ascending: false })
          .limit(THREAD_PAGE_SIZE) as any;
        if (pageParam) query = query.or(`created_at.lt.${pageParam.createdAt},and(created_at.eq.${pageParam.createdAt},id.lt.${pageParam.id})`);
        const { data: fallbackReplies, error: fallbackError } = await query;
        if (fallbackError) throw fallbackError;
        const authors = [...new Set((fallbackReplies || []).map((reply: any) => reply.author_id))] as string[];
        const { data: fallbackProfiles } = authors.length ? await supabase.from("profiles")
          .select("user_id,name,avatar_url,slug").in("user_id", authors) : { data: [] as any[] };
        const fallbackProfilesById = new Map((fallbackProfiles || []).map((entry: any) => [entry.user_id, entry]));
        return (fallbackReplies || []).map((reply: any) => ({ ...reply, profile: reply.is_anonymous ? null : fallbackProfilesById.get(reply.author_id) || null }));
      }
      return hydrateForumMediaUrls((data || []).map((row: any) => row.post || row));
    },
    getNextPageParam: (lastPage) => {
      if (lastPage.length < THREAD_PAGE_SIZE) return undefined;
      const oldest = lastPage[lastPage.length - 1];
      return { createdAt: oldest.created_at, id: oldest.id };
    },
    staleTime: 10000,
  });
  const replies = sortThreadReplies([
    ...(threadData?.pages || []).flat(),
    ...queuedReplies.map((item) => ({
      id: `outbox-${item.id}`,
      send_identity_id: item.id,
      content: item.content,
      created_at: item.createdAt,
      author_id: item.userId,
      viewer_is_author: true,
      is_anonymous: item.isAnonymous,
      reply_to_id: item.replyToId,
      profile: item.isAnonymous ? null : profile,
      is_pending: !item.lastError,
      is_failed: !!item.lastError,
    })),
  ]);
  const threadVirtualizer = useVirtualizer({
    count: replies.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    getItemKey: (index) => replies[index]?.id || index,
    overscan: 10,
  });

  useEffect(() => {
    if (!user?.id || testSession) return;
    let disposed = false;
    const sync = async () => {
      const queued = await listForumOutboxItems(user.id);
      if (!disposed) setQueuedReplies(queued.filter((item) => item.replyToId === parentPost.id));
    };
    void sync();
    const unsubscribe = subscribeForumOutbox(() => void sync());
    return () => { disposed = true; unsubscribe(); };
  }, [parentPost.id, testSession, user?.id]);

  const sendReply = useMutation({
    mutationFn: async () => {
      if (!user || !content.trim()) return;
      const snapshot: ForumSendSnapshot = {
        scopeType: activeScope.type,
        scopeKey: activeScope.key,
        content,
        isAnonymous,
        replyToId: parentPost.id,
        imageFingerprint: null,
        fileFingerprint: null,
        pollQuestion: "",
        pollOptions: [],
      };
      const sendIdentity = resolveForumSendIdentity(sendIdentityRef.current, snapshot);
      sendIdentityRef.current = sendIdentity;
      if (testSession) {
        const localReply = {
          id: `test-thread-${sendIdentity.id}`,
          community_id: "test", scope_type: activeScope.type, scope_key: activeScope.key,
          channel: activeScope.type.toLowerCase().replace(/_/g, "-"), content: content.trim(),
          is_anonymous: isAnonymous, author_id: user.id, reply_to_id: parentPost.id,
          created_at: new Date().toISOString(), deleted_at: null,
          profile: isAnonymous ? null : { name: testSession.name || profile?.name || "Test User", avatar_url: null, slug: null },
        };
        appendForumTestPost(activeScope.type, activeScope.key, localReply);
        return { reply: localReply, sendIdentity };
      }
      const queued: ForumOutboxItem = {
        id: sendIdentity.id, userId: user.id, scopeType: activeScope.type, scopeKey: activeScope.key,
        content: content.trim(), isAnonymous, replyToId: parentPost.id,
        createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: Date.now() + 30_000,
      };
      await putForumOutboxItem(queued);
      let reply;
      try {
        reply = await publishForumOutboxItem(queued);
        await deleteForumOutboxItem(queued.id);
      } catch (error) {
        await markForumOutboxFailed(queued, error);
        throw error;
      }
      return {
        reply: { ...reply, profile: isAnonymous ? null : profile },
        sendIdentity,
      };
    },
    onSuccess: (result) => {
      if (!result?.reply) return;
      let added = false;
      queryClient.setQueryData(["thread-replies", parentPost.id], (current: any) => {
        const pages = current?.pages || [[]];
        const all = pages.flat();
        added = !all.some((reply: any) => reply.id === result.reply.id);
        return { ...current, pages: [sortThreadPageDescending([...pages[0].filter((reply: any) => reply.id !== result.reply.id), result.reply]), ...pages.slice(1)] };
      });
      if (added) {
        queryClient.setQueriesData({ queryKey: ["forum-posts"] }, (current: any) => current?.posts ? {
          ...current,
          posts: current.posts.map((post: any) => post.id === parentPost.id
            ? { ...post, replyCount: (post.replyCount || 0) + 1 }
            : post),
        } : current);
      }
      if (sendIdentityRef.current?.id === result.sendIdentity.id) sendIdentityRef.current = null;
      const currentSnapshot: ForumSendSnapshot = {
        scopeType: activeScope.type, scopeKey: activeScope.key, content, isAnonymous,
        replyToId: parentPost.id, imageFingerprint: null, fileFingerprint: null,
        pollQuestion: "", pollOptions: [],
      };
      if (forumSendFingerprint(currentSnapshot) === result.sendIdentity.fingerprint) {
        setContent("");
        setIsAnonymous(false);
      }
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    },
    onError: (err: any) => toast.error(err.message),
  });

  useEffect(() => {
    if (!replies.length || loadingOlderRef.current) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      return;
    }
    if (followLiveRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies.length]);

  const loadOlderReplies = async () => {
    const container = scrollRef.current;
    const previousHeight = container?.scrollHeight || 0;
    loadingOlderRef.current = true;
    try {
      await fetchNextPage();
      requestAnimationFrame(() => {
        if (container) container.scrollTop += container.scrollHeight - previousHeight;
        loadingOlderRef.current = false;
      });
    } catch {
      loadingOlderRef.current = false;
      toast.error("Older replies could not be loaded");
    }
  };

  useEffect(() => {
    if (testSession) return;
    const updateParentReplyCount = (delta: number) => {
      if (!delta) return;
      queryClient.setQueriesData({ queryKey: ["forum-posts"] }, (current: any) => current?.posts ? {
        ...current,
        posts: current.posts.map((post: any) => post.id === parentPost.id
          ? { ...post, replyCount: Math.max(0, (post.replyCount || 0) + delta) }
          : post),
      } : current);
    };
    const applyReplyEvent = (eventType: string, row: any) => {
      if (!row?.id) return;
      let replyCountDelta = 0;
      queryClient.setQueryData(["thread-replies", parentPost.id], (current: any) => {
        const pages = current?.pages || [[]];
        const all = pages.flat();
        const existing = all.find((reply: any) => reply.id === row.id);
        if (eventType === "DELETE" || row.deleted_at) {
          if (existing) replyCountDelta = -1;
          return { ...current, pages: pages.map((page: any[]) => page.filter((reply) => reply.id !== row.id)) };
        }
        if (!existing) replyCountDelta = 1;
        const enriched = {
          ...existing,
          ...row,
          profile: row.is_anonymous ? null : profileMap.get(row.author_id) ?? existing?.profile ?? null,
        };
        return { ...current, pages: [sortThreadPageDescending([...pages[0].filter((reply: any) => reply.id !== row.id), enriched]), ...pages.slice(1).map((page: any[]) => page.filter((reply) => reply.id !== row.id))] };
      });
      updateParentReplyCount(replyCountDelta);
    };
    let broadcastChannel: ReturnType<typeof supabase.channel> | null = null;
    let fallbackChannel: ReturnType<typeof supabase.channel> | null = null;
    let unsubscribeAppSync: (() => void) | null = null;
    let fallbackStarted = false;
    let disposed = false;
    const recoverMissedReplies = async () => {
      const { data, error } = await (supabase as any).rpc("get_forum_thread_page", {
        p_parent_id: parentPost.id,
        p_limit: THREAD_PAGE_SIZE,
        p_before_created_at: null,
        p_before_id: null,
      });
      if (disposed || error) return;
      const hydrated = await hydrateForumMediaUrls((data || []).map((row: any) => row.post || row));
      if (disposed) return;
      hydrated.forEach((reply: any) => applyReplyEvent("INSERT", reply));
    };
    const startFallback = () => {
      if (fallbackStarted || disposed) return;
      fallbackStarted = true;
      fallbackChannel = supabase.channel(`forum-thread-pg:${parentPost.id}`)
        .on("postgres_changes", {
          event: "*", schema: "public", table: "posts", filter: `reply_to_id=eq.${parentPost.id}`,
        }, (payload: any) => applyReplyEvent(payload.eventType, payload.eventType === "DELETE" ? payload.old : payload.new))
        .subscribe((status) => { if (status === "SUBSCRIBED") void recoverMissedReplies(); });
    };
    if (appSyncRealtimeEnabled) {
      unsubscribeAppSync = subscribeAppSync(`/thread/${parentPost.id}`, (event: any) => {
        const eventType = String(event.eventType || "INSERT");
        applyReplyEvent(eventType, eventType === "DELETE" ? event.old : event.new);
      }, (status) => {
        if (status === "SUBSCRIBED") void recoverMissedReplies();
        if (status === "CHANNEL_ERROR" || status === "CLOSED") startFallback();
      });
    } else void (async () => {
      await supabase.realtime.setAuth();
      if (disposed) return;
      broadcastChannel = supabase.channel(`forum-thread:${parentPost.id}`, { config: { private: true } })
        .on("broadcast", { event: "INSERT" }, (payload: any) => applyReplyEvent("INSERT", getForumBroadcastRow(payload, "new")))
        .on("broadcast", { event: "UPDATE" }, (payload: any) => applyReplyEvent("UPDATE", getForumBroadcastRow(payload, "new")))
        .on("broadcast", { event: "DELETE" }, (payload: any) => applyReplyEvent("DELETE", getForumBroadcastRow(payload, "old")))
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void recoverMissedReplies();
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") startFallback();
        });
    })().catch(startFallback);
    return () => {
      disposed = true;
      if (broadcastChannel) void supabase.removeChannel(broadcastChannel);
      if (fallbackChannel) void supabase.removeChannel(fallbackChannel);
      unsubscribeAppSync?.();
    };
  }, [parentPost.id, profileMap, queryClient, testSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && content.trim()) {
      e.preventDefault();
      sendReply.mutate();
    }
  };

  const parentProfile = parentPost.profile;
  const parentIsMine = parentPost.viewer_is_author === true || parentPost.author_id === user?.id;
  const parentName = parentPost.is_anonymous ? (parentIsMine ? "You · Anonymous" : "Anonymous") : parentProfile?.name || "User";

  return (
    <div className="flex flex-col h-full border-l border-border bg-card animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
        <Reply className="w-4 h-4 text-primary" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-foreground">Thread</p>
          <p className="text-[10px] text-muted-foreground truncate">{replies.length} replies</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-full hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Parent message */}
      <button type="button" onClick={onJumpToParent} className="px-4 py-3 border-b border-border bg-secondary/30 flex-shrink-0 text-left hover:bg-secondary/55 transition-colors" aria-label="Show original message in chat">
        <div className="flex items-start gap-2">
          {parentProfile?.avatar_url ? (
            <img src={parentProfile.avatar_url} className="w-8 h-8 rounded-full object-cover" alt="" />
          ) : (
            <div className={`w-8 h-8 rounded-full ${getUserColor(parentPost.is_anonymous ? "anonymous" : parentPost.author_id || "unknown")} flex items-center justify-center`}>
              <span className="text-[9px] font-bold text-white">{getInitials(parentName)}</span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">{parentName}</p>
            <p className="text-sm text-foreground whitespace-pre-wrap mt-0.5">
              {renderFormattedMessage(parentPost.content, profileMap, navigate)}
            </p>
            {parentPost.image_url && (
              <img src={parentPost.image_url} className="mt-2 rounded-lg max-h-32 object-cover" alt="" />
            )}
            <p className="text-[10px] text-muted-foreground mt-1">{format(new Date(parentPost.created_at), "h:mm a")}</p>
            <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-primary"><LocateFixed className="w-3 h-3" /> View in chat</span>
          </div>
        </div>
      </button>

      {/* Thread replies */}
      <div ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        followLiveRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
      }} className="flex-1 overflow-y-auto px-4 py-2 space-y-3 min-h-0 overscroll-contain">
        {hasNextPage && (
          <button type="button" onClick={() => void loadOlderReplies()} disabled={isFetchingNextPage}
            className="w-full py-2 text-xs font-semibold text-primary hover:underline disabled:opacity-50">
            {isFetchingNextPage ? "Loading older replies…" : "Load older replies"}
          </button>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : replies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Reply className="w-8 h-8 text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">No replies yet</p>
          </div>
        ) : (
          <div style={{ height: `${threadVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
          {threadVirtualizer.getVirtualItems().map((virtualReply) => {
            const reply: any = replies[virtualReply.index];
            const replyIsMine = reply.viewer_is_author === true || reply.author_id === user?.id;
            const rName = reply.is_anonymous ? (replyIsMine ? "You · Anonymous" : "Anonymous") : reply.profile?.name || "User";
            return (
              <div key={reply.id} data-index={virtualReply.index} ref={threadVirtualizer.measureElement}
                style={{ position: "absolute", left: 0, top: 0, width: "100%", transform: `translateY(${virtualReply.start}px)` }}
                className={`flex items-start gap-2 rounded-xl p-1.5 ${reply.is_anonymous && replyIsMine ? "bg-primary/5 ring-1 ring-primary/10" : ""}`}>
                {reply.profile?.avatar_url ? (
                  <img src={reply.profile.avatar_url} className="w-7 h-7 rounded-full object-cover" alt="" />
                ) : (
                  <div className={`w-7 h-7 rounded-full ${reply.is_anonymous ? "bg-muted" : getUserColor(reply.author_id)} flex items-center justify-center`}>
                    <span className="text-[8px] font-bold text-white">{getInitials(rName)}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[11px] font-semibold text-foreground">{rName}</span>
                    {reply.is_anonymous && replyIsMine && <span className="text-[8px] font-bold text-primary">ANONYMOUS TO OTHERS</span>}
                    <span className="text-[10px] text-muted-foreground">{format(new Date(reply.created_at), "h:mm a")}</span>
                  </div>
                  <p className="text-xs text-foreground whitespace-pre-wrap mt-0.5">
                    {renderFormattedMessage(reply.content, profileMap, navigate)}
                  </p>
                  {reply.is_pending && <p className="mt-1 text-[9px] font-medium text-muted-foreground">Sending…</p>}
                  {reply.is_failed && <p className="mt-1 text-[9px] font-semibold text-destructive">Waiting to retry automatically</p>}
                </div>
              </div>
            );
          })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      {user && (
        <div className="px-3 py-2 border-t border-border flex-shrink-0">
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply in thread..."
              rows={1}
              className="flex-1 min-h-[36px] max-h-20 bg-secondary border-border rounded-2xl text-xs resize-none"
              autoFocus
            />
            <button type="button" onClick={() => setIsAnonymous((value) => !value)}
              className={`w-8 h-8 rounded-full flex items-center justify-center ${isAnonymous ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
              aria-label={isAnonymous ? "Replying anonymously" : "Reply as anonymous"} title="Anonymous reply">
              <EyeOff className="w-4 h-4" />
            </button>
            <Button
              size="icon"
              className="rounded-full w-8 h-8 flex-shrink-0"
              onClick={() => sendReply.mutate()}
              disabled={sendReply.isPending || !content.trim()}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThreadPanel;
