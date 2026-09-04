import {
  ArrowLeft, Search, Plus, Send, Check, CheckCheck, Smile, Reply,
  X, Phone, Video, MoreVertical, Mic, Paperclip, Lock, Loader2, RotateCcw,
} from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow, format, isToday, isYesterday } from "date-fns";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cacheMessages, getCachedMessages } from "@/lib/chatCache";
import { convertToWebP } from "@/lib/imageUtils";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  deleteChatOutboxItem, listChatOutboxItems, markChatOutboxFailed,
  putChatOutboxItem, subscribeChatOutbox, type ChatOutboxItem,
} from "@/lib/chatOutbox";
import { getForumBroadcastRow } from "@/lib/forumRealtime";
import { createRealtimeRecoveryController } from "@/lib/realtimeRecovery";
import { isChatMessageRealtimeEvent, mergeChatTimeline, uniqueChatMessages as uniqueMessages } from "@/lib/chatMessages";
import { reportError } from "@/lib/errorTelemetry";
import VoiceRecorder from "@/components/forum/VoiceRecorder";
import {
  appSyncRealtimeEnabled, chatAppSyncChannels, requestRealtimeDispatch,
  subscribeAppSync,
} from "@/lib/appsyncEvents";
import { useRealtimeActivity } from "@/hooks/useRealtimeActivity";
import { getDirectChatBackTarget, getDirectChatProfileTarget } from "@/lib/directMessages";
import { parseCallInviteQuery } from "@/lib/callInvites";
import NotificationBell from "@/components/NotificationBell";

const PAGE_SIZE = 50;
const inboxCacheKey = (userId: string) => `cirkle:chat-inbox:${userId}`;
const CALLS_ENABLED = import.meta.env.VITE_DAILY_CALLS_ENABLED === "true";
const CallModal = lazy(() => import("@/components/CallModal"));

type ChatMessage = {
  id: string;
  client_id?: string | null;
  content: string;
  created_at: string;
  media_url?: string | null;
  media_path?: string | null;
  media_bucket?: string | null;
  message_type?: string;
  voice_duration?: number | null;
  read_by?: string[] | null;
  reply_to_message_id?: string | null;
  room_id: string;
  sender_id: string;
  status?: string;
};

type ChatRoom = {
  id: string;
  name?: string | null;
  is_group: boolean;
  avatar_url?: string | null;
  created_at: string;
  created_by?: string | null;
  displayName: string;
  displayAvatar?: string | null;
  lastMessage?: ChatMessage | null;
  unreadCount: number;
  peerId?: string | null;
};

type RawRoom = Partial<ChatRoom> & Pick<ChatRoom, "id" | "is_group" | "created_at"> & {
  display_name?: string | null;
  display_avatar?: string | null;
  last_message?: unknown;
  unread_count?: number;
  peer_id?: string | null;
};

const getInitials = (name?: string | null) => {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0][0]).toUpperCase();
};

const formatMessageDate = (date: string) => {
  const value = new Date(date);
  if (isToday(value)) return "Today";
  if (isYesterday(value)) return "Yesterday";
  return format(value, "dd/MM/yyyy");
};

const normalizeRoom = (room: RawRoom): ChatRoom => ({
  ...room,
  displayName: room.display_name || room.displayName || room.name || (room.is_group ? "Group" : "User"),
  displayAvatar: room.display_avatar || room.displayAvatar || room.avatar_url,
  lastMessage: (room.last_message && typeof room.last_message === "object" ? room.last_message as ChatMessage : null) || room.lastMessage || null,
  unreadCount: Number(room.unread_count ?? room.unreadCount ?? 0),
  peerId: room.peer_id || room.peerId || null,
});

const readInboxCache = (userId?: string): ChatRoom[] => {
  if (!userId) return [];
  try { return (JSON.parse(localStorage.getItem(inboxCacheKey(userId)) || "[]") as RawRoom[]).map(normalizeRoom); }
  catch { return []; }
};

const chatMediaUrlCache = new Map<string, { url: string; expiresAt: number }>();
const hydrateChatMedia = async (items: ChatMessage[]): Promise<ChatMessage[]> => {
  const now = Date.now();
  const byBucket = new Map<string, Set<string>>();
  items.forEach((item) => {
    if (!item.media_path) return;
    const bucket = item.media_bucket || "chat-media";
    const key = `${bucket}:${item.media_path}`;
    const cached = chatMediaUrlCache.get(key);
    if (!cached || cached.expiresAt <= now) {
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
      byBucket.get(bucket)!.add(item.media_path);
    }
  });
  await Promise.all([...byBucket.entries()].map(async ([bucket, pathSet]) => {
    const paths = [...pathSet];
    const { data } = await supabase.storage.from(bucket).createSignedUrls(paths, 3600);
    (data || []).forEach((entry, index) => {
      if (entry.signedUrl) chatMediaUrlCache.set(`${bucket}:${paths[index]}`, { url: entry.signedUrl, expiresAt: now + 50 * 60_000 });
    });
  }));
  return items.map((item) => item.media_path
    ? { ...item, media_url: chatMediaUrlCache.get(`${item.media_bucket || "chat-media"}:${item.media_path}`)?.url || item.media_url }
    : item);
};

const Chats = () => {
  const navigate = useNavigate();
  const { roomId } = useParams<{ roomId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const realtimeActive = useRealtimeActivity();
  const [activeRoom, setActiveRoom] = useState<ChatRoom | null>(null);
  const [newMessage, setNewMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sendingImage, setSendingImage] = useState(false);
  const [tab, setTab] = useState<"messages" | "groups">("messages");
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [typingUsers, setTypingUsers] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [callMode, setCallMode] = useState<"audio" | "video" | null>(null);
  const [callSessionId, setCallSessionId] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [showConversationInfo, setShowConversationInfo] = useState(false);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roomChannelRef = useRef<{
    send: (message: {
      type: "broadcast";
      event: "typing";
      payload: Record<string, unknown>;
    }) => Promise<unknown> | void;
  } | null>(null);
  const typingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingBroadcastRef = useRef(0);
  const prependRef = useRef(false);
  const followLiveRef = useRef(true);
  const processingOutboxRef = useRef(false);
  const outboxPreviewUrlsRef = useRef(new Map<string, string>());
  const messagesRef = useRef<ChatMessage[]>([]);
  const realtimeRoomIdRef = useRef<string | null>(null);

  const { data: friendIds = [] } = useQuery({
    queryKey: ["friend-ids-chat", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase.from("connections").select("requester_id, receiver_id")
        .or(`requester_id.eq.${user.id},receiver_id.eq.${user.id}`).eq("status", "accepted");
      if (error) throw error;
      return data?.map((item) => item.requester_id === user.id ? item.receiver_id : item.requester_id) || [];
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const { data: friendProfiles = [] } = useQuery({
    queryKey: ["friend-profiles-chat", friendIds],
    queryFn: async () => {
      if (!friendIds.length) return [];
      const { data, error } = await supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", friendIds);
      if (error) throw error;
      return data || [];
    },
    enabled: friendIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const { data: rooms = [], isLoading: roomsLoading, error: roomsError } = useQuery({
    queryKey: ["chat-rooms", user?.id],
    queryFn: async () => {
      const [{ data, error }, { data: directRows }] = await Promise.all([
        supabase.rpc("get_chat_inbox"),
        (supabase as any).rpc("get_direct_message_sidebar"),
      ]);
      if (error) throw error;
      const directByRoom = new Map<string, Record<string, unknown>>((directRows || [])
        .filter((row: { room_id?: string | null }) => !!row.room_id)
        .map((row: { room_id: string } & Record<string, unknown>) => [row.room_id, row]));
      const inbox = (data || []).map((room) => normalizeRoom({ ...room, ...(directByRoom.get(room.id) || {}) }));
      localStorage.setItem(inboxCacheKey(user.id), JSON.stringify(inbox));
      return inbox as ChatRoom[];
    },
    enabled: !!user,
    placeholderData: () => readInboxCache(user?.id),
    staleTime: 30_000,
    refetchOnReconnect: true,
  });

  const incomingCallInvite = useMemo(
    () => parseCallInviteQuery(roomId, searchParams),
    [roomId, searchParams],
  );
  const hasCallInviteParams = searchParams.has("call") || searchParams.has("session") || searchParams.has("expires");
  const clearCallInviteParams = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("call");
    next.delete("session");
    next.delete("expires");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!hasCallInviteParams) return;
    if (CALLS_ENABLED && incomingCallInvite) return;
    clearCallInviteParams();
    toast.error(CALLS_ENABLED ? "This call invitation is invalid or has expired" : "Audio and video calls are not available");
  }, [clearCallInviteParams, hasCallInviteParams, incomingCallInvite]);

  useEffect(() => {
    if (!roomId) return;
    const requestedRoom = rooms.find((room) => room.id === roomId);
    if (!requestedRoom) return;
    if (!activeRoom || activeRoom.id !== requestedRoom.id || activeRoom.peerId !== requestedRoom.peerId) {
      setActiveRoom(requestedRoom);
    }
  }, [activeRoom, roomId, rooms]);

  const markReadSoon = useCallback((roomId: string) => {
    if (readTimerRef.current) clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(async () => {
      await supabase.rpc("mark_chat_read", { p_room_id: roomId });
      queryClient.setQueryData<ChatRoom[]>(["chat-rooms", user?.id], (current = []) =>
        current.map((room) => room.id === roomId ? { ...room, unreadCount: 0 } : room));
    }, 500);
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (!activeRoom || !user || !realtimeActive) return;
    let cancelled = false;
    let broadcastChannel: ReturnType<typeof supabase.channel> | null = null;
    let fallbackChannel: ReturnType<typeof supabase.channel> | null = null;
    let fallbackStarted = false;
    let broadcastHealthy = false;
    let fallbackHealthy = false;
    let fallbackRestartTimer: ReturnType<typeof setTimeout> | null = null;
    let recoveryController: ReturnType<typeof createRealtimeRecoveryController> | null = null;
    let unsubscribeAppSyncMessage: (() => void) | null = null;
    const changedRoom = realtimeRoomIdRef.current !== activeRoom.id;
    realtimeRoomIdRef.current = activeRoom.id;
    if (changedRoom) {
      setMessages([]);
      messagesRef.current = [];
      setHasOlder(false);
      setNewMessageCount(0);
      followLiveRef.current = true;
    }

    let authoritativeFailed = false;
    void getCachedMessages<ChatMessage>(user.id, activeRoom.id).then((cached) => {
      if (!cancelled && !authoritativeFailed && cached.length) void hydrateChatMedia(cached).then((hydrated) => {
        if (!cancelled && !authoritativeFailed) setMessages((current) => mergeChatTimeline(current, hydrated, activeRoom.id));
      });
    });

    void (async () => {
      const { data, error } = await supabase.from("messages").select("*")
        .eq("room_id", activeRoom.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_SIZE);
      if (cancelled) return;
      if (error) { authoritativeFailed = true; setMessages([]); toast.error("Could not refresh messages"); return; }
      const page = await hydrateChatMedia(((data || []) as ChatMessage[]).reverse());
      if (cancelled) return;
      // Cache hydration, the server query and Realtime all run concurrently.
      // Merge instead of replacing so a message arriving during initial load
      // can never be erased by a slower response.
      setMessages((current) => mergeChatTimeline(current, page, activeRoom.id));
      setHasOlder(page.length === PAGE_SIZE);
      void cacheMessages(user.id, activeRoom.id, page);
      markReadSoon(activeRoom.id);
    })();

    const applyMessage = async (eventType: string, row: ChatMessage | undefined) => {
      if (!row?.id || cancelled) return;
      if (eventType === "DELETE") {
        setMessages((current) => current.filter((item) => item.id !== row.id));
        return;
      }
      const [incoming] = await hydrateChatMedia([row]);
      if (cancelled) return;
      setMessages((current) => uniqueMessages([...current.filter((item) => item.id !== incoming.id), incoming]));
      if (eventType === "INSERT" && incoming.sender_id !== user.id) {
        if (!followLiveRef.current) setNewMessageCount((count) => Math.min(99, count + 1));
        markReadSoon(activeRoom.id);
      }
      void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user.id] });
    };
    const recoverMissedMessages = async () => {
      if (cancelled) return;
      const roomMessages = uniqueMessages(messagesRef.current.filter((message) => message.room_id === activeRoom.id));
      let cursor = roomMessages[roomMessages.length - 1];
      const recoveredRows: ChatMessage[] = [];

      if (!cursor) {
        const { data, error } = await supabase.from("messages").select("*")
          .eq("room_id", activeRoom.id)
          .order("created_at", { ascending: false }).order("id", { ascending: false })
          .limit(PAGE_SIZE);
        if (cancelled || error || !data?.length) return;
        recoveredRows.push(...((data as ChatMessage[]).reverse()));
      } else {
        // A sleeping mobile browser can miss more than one page of events.
        // Walk the deterministic (created_at, id) cursor until caught up.
        for (let page = 0; page < 100 && !cancelled; page += 1) {
          const { data, error } = await supabase.from("messages").select("*")
            .eq("room_id", activeRoom.id)
            .or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`)
            .order("created_at", { ascending: true }).order("id", { ascending: true })
            .limit(100);
          if (error || !data?.length) break;
          const pageRows = data as ChatMessage[];
          recoveredRows.push(...pageRows);
          cursor = pageRows[pageRows.length - 1];
          if (pageRows.length < 100) break;
        }
      }
      if (cancelled || recoveredRows.length === 0) return;
      const recovered = await hydrateChatMedia(recoveredRows);
      if (!cancelled) setMessages((existing) => uniqueMessages([...existing, ...recovered]));
    };
    const bindTyping = (channel: ReturnType<typeof supabase.channel>) => channel.on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!payload?.userId || payload.userId === user.id) return;
        const name = payload.name || "Someone";
        setTypingUsers((current) => payload.typing
          ? [...new Set([...current, name])]
          : current.filter((value) => value !== name));
        if (payload.typing) setTimeout(() => setTypingUsers((current) => current.filter((value) => value !== name)), 3000);
      });
    function scheduleFallbackRestart() {
      if (cancelled || fallbackRestartTimer !== null) return;
      fallbackHealthy = false;
      const previous = fallbackChannel;
      fallbackChannel = null;
      fallbackStarted = false;
      if (previous) void supabase.removeChannel(previous);
      fallbackRestartTimer = setTimeout(() => {
        fallbackRestartTimer = null;
        startFallback();
      }, 1_500);
    }
    function startFallback() {
      if (fallbackStarted || cancelled) return;
      fallbackStarted = true;
      const channel = bindTyping(supabase.channel(`room-${activeRoom.id}`, { config: { broadcast: { self: false } } }))
        .on("postgres_changes", {
          event: "*", schema: "public", table: "messages", filter: `room_id=eq.${activeRoom.id}`,
        }, (payload: any) => { void applyMessage(payload.eventType, (payload.eventType === "DELETE" ? payload.old : payload.new) as ChatMessage); })
        .subscribe((status) => {
          if (cancelled || fallbackChannel !== channel) return;
          if (status === "SUBSCRIBED") {
            fallbackHealthy = true;
            void (recoveryController?.recoverNow() || recoverMissedMessages());
            return;
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            scheduleFallbackRestart();
          }
        });
      fallbackChannel = channel;
      roomChannelRef.current = channel;
    }
    recoveryController = createRealtimeRecoveryController({
      recover: recoverMissedMessages,
      ensureConnected: () => {
        if (!broadcastHealthy && !fallbackHealthy) startFallback();
      },
    });
    if (appSyncRealtimeEnabled) {
      const channels = chatAppSyncChannels(activeRoom.id);
      unsubscribeAppSyncMessage = subscribeAppSync(channels.message_channel, (event: any) => {
        if (!isChatMessageRealtimeEvent(event)) return;
        const eventType = String(event.eventType || "INSERT");
        const identity = (eventType === "DELETE" ? event.old : event.new) as { id?: unknown } | undefined;
        const messageId = typeof identity?.id === "string" ? identity.id : "";
        if (!messageId) { void (recoveryController?.recoverNow() || recoverMissedMessages()); return; }
        if (eventType === "DELETE") { void applyMessage(eventType, { id: messageId } as ChatMessage); return; }
        // AppSync carries only a row identity. Fetching through the API makes
        // current verification and room membership authoritative even when an
        // old AWS subscription has not yet expired.
        void supabase.from("messages").select("*")
          .eq("room_id", activeRoom.id).eq("id", messageId).maybeSingle()
          .then(({ data, error }) => {
            if (cancelled) return;
            if (error || !data) { void (recoveryController?.recoverNow() || recoverMissedMessages()); return; }
            void applyMessage(eventType, data as ChatMessage);
          });
      }, (status) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") {
          broadcastHealthy = true;
          void (recoveryController?.recoverNow() || recoverMissedMessages());
        } else if (status === "CHANNEL_ERROR" || status === "CLOSED") {
          broadcastHealthy = false;
          startFallback();
          void recoveryController?.recoverNow();
        }
      });
      // AppSync durable events are content-free invalidations. Typing stays on
      // the revocable Socket.IO transport so a removed member cannot keep
      // receiving identity/activity through an already-open AWS connection.
      void supabase.realtime.setAuth().then(() => {
        if (cancelled) return;
        broadcastChannel = bindTyping(supabase.channel(`chat:${activeRoom.id}`, { config: { private: true, broadcast: { self: false } } }))
          .subscribe();
        roomChannelRef.current = broadcastChannel;
      }).catch(() => { /* Typing is optional; durable delivery remains active. */ });
    } else void (async () => {
      const { data: broadcastReady } = await (supabase as any).rpc("chat_broadcast_ready");
      if (cancelled || broadcastReady !== true) { startFallback(); return; }
      await supabase.realtime.setAuth();
      if (cancelled) return;
      broadcastChannel = bindTyping(supabase.channel(`chat:${activeRoom.id}`, { config: { private: true, broadcast: { self: false } } }))
        .on("broadcast", { event: "INSERT" }, (payload: any) => { void applyMessage("INSERT", getForumBroadcastRow(payload, "new") as ChatMessage); })
        .on("broadcast", { event: "UPDATE" }, (payload: any) => { void applyMessage("UPDATE", getForumBroadcastRow(payload, "new") as ChatMessage); })
        .on("broadcast", { event: "DELETE" }, (payload: any) => { void applyMessage("DELETE", getForumBroadcastRow(payload, "old") as ChatMessage); })
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            broadcastHealthy = true;
            void (recoveryController?.recoverNow() || recoverMissedMessages());
          }
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            broadcastHealthy = false;
            startFallback();
            void recoveryController?.recoverNow();
          }
        });
      roomChannelRef.current = broadcastChannel;
    })().catch(startFallback);

    return () => {
      cancelled = true;
      recoveryController?.dispose();
      if (fallbackRestartTimer !== null) clearTimeout(fallbackRestartTimer);
      roomChannelRef.current = null;
      if (broadcastChannel) void supabase.removeChannel(broadcastChannel);
      if (fallbackChannel) void supabase.removeChannel(fallbackChannel);
      if (readTimerRef.current) clearTimeout(readTimerRef.current);
      unsubscribeAppSyncMessage?.();
    };
  }, [activeRoom, markReadSoon, queryClient, realtimeActive, user]);

  useEffect(() => {
    if (!activeRoom || !messages.length) return;
    messagesRef.current = messages;
    if (user?.id) void cacheMessages(user.id, activeRoom.id, messages);
    if (!prependRef.current && followLiveRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    prependRef.current = false;
  }, [activeRoom, messages, user?.id]);

  const loadOlder = async () => {
    if (!activeRoom || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    const container = scrollRef.current;
    const oldHeight = container?.scrollHeight || 0;
    const oldest = messages[0];
    const { data, error } = await supabase.from("messages").select("*")
      .eq("room_id", activeRoom.id)
      .or(`created_at.lt.${oldest.created_at},and(created_at.eq.${oldest.created_at},id.lt.${oldest.id})`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE);
    if (!error) {
      const page = await hydrateChatMedia(((data || []) as ChatMessage[]).reverse());
      prependRef.current = true;
      setMessages((current) => uniqueMessages([...page, ...current]));
      setHasOlder(page.length === PAGE_SIZE);
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight - oldHeight;
      });
    }
    setLoadingOlder(false);
  };

  const handleTyping = () => {
    const channel = roomChannelRef.current;
    if (!channel || !user) return;
    const now = Date.now();
    if (now - lastTypingBroadcastRef.current > 800) {
      lastTypingBroadcastRef.current = now;
      void channel.send({ type: "broadcast", event: "typing", payload: { userId: user.id, typing: true } });
    }
    if (typingStopRef.current) clearTimeout(typingStopRef.current);
    typingStopRef.current = setTimeout(() => {
      void channel.send({ type: "broadcast", event: "typing", payload: { userId: user.id, typing: false } });
    }, 1600);
  };

  const optimisticFromOutbox = useCallback((item: ChatOutboxItem): ChatMessage => {
    let previewUrl = item.mediaUrl || null;
    if (!previewUrl && item.media) {
      previewUrl = outboxPreviewUrlsRef.current.get(item.id) || URL.createObjectURL(item.media.blob);
      outboxPreviewUrlsRef.current.set(item.id, previewUrl);
    }
    return {
      id: `optimistic-${item.id}`,
      client_id: item.id,
      content: item.content,
      created_at: item.createdAt,
      media_url: previewUrl,
      media_path: item.mediaPath,
      media_bucket: "chat-media",
      message_type: item.messageType,
      voice_duration: item.voiceDuration,
      read_by: [item.userId],
      reply_to_message_id: item.replyToMessageId,
      room_id: item.roomId,
      sender_id: item.userId,
      status: item.lastError ? "failed" : "sending",
    };
  }, []);

  const persistOutboxItem = useCallback(async (source: ChatOutboxItem) => {
    let item = source;
    try {
      if (item.media && !item.mediaPath) {
        const extension = item.messageType === "image" ? "webp" : item.media.type.includes("webm") ? "webm" : "m4a";
        const path = `${item.userId}/${item.roomId}/${item.id}.${extension}`;
        const { error: uploadError } = await supabase.storage.from("chat-media").upload(path, item.media.blob, {
          contentType: item.media.type,
          cacheControl: "31536000",
          upsert: true,
        });
        if (uploadError) throw uploadError;
        item = { ...item, mediaPath: path };
        await putChatOutboxItem(item);
      }
      let { data, error } = await supabase.from("messages").insert({
        room_id: item.roomId,
        sender_id: item.userId,
        content: item.content,
        reply_to_message_id: item.replyToMessageId || null,
        client_id: item.id,
        message_type: item.messageType,
        media_url: null,
        media_path: item.mediaPath || null,
        media_bucket: "chat-media",
        voice_duration: item.voiceDuration || null,
        status: "sent",
        read_by: [item.userId],
      } as any).select().single();
      if (error?.code === "23505") {
        const existing = await supabase.from("messages").select("*").eq("sender_id", item.userId)
          .eq("client_id", item.id).maybeSingle();
        data = existing.data;
        error = existing.error;
      }
      if (error || !data) throw error || new Error("Message could not be persisted");
      requestRealtimeDispatch();
      const [delivered] = await hydrateChatMedia([data as ChatMessage]);
      await deleteChatOutboxItem(item.id);
      const preview = outboxPreviewUrlsRef.current.get(item.id);
      if (preview) { URL.revokeObjectURL(preview); outboxPreviewUrlsRef.current.delete(item.id); }
      setMessages((current) => uniqueMessages(current.map((message) => message.client_id === item.id ? delivered : message)));
      void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user?.id] });
      return delivered;
    } catch (error) {
      await markChatOutboxFailed(item, error);
      setMessages((current) => current.map((message) => message.client_id === item.id ? { ...message, status: "failed" } : message));
      throw error;
    }
  }, [queryClient, user?.id]);

  const sendMessage = async () => {
    const content = newMessage.trim();
    if (!content || !user || !activeRoom) return;
    const item: ChatOutboxItem = {
      id: crypto.randomUUID(), userId: user.id, roomId: activeRoom.id, content,
      createdAt: new Date().toISOString(), messageType: "text",
      replyToMessageId: replyTo?.id.startsWith("optimistic-") ? null : replyTo?.id || null,
      attempts: 0, nextAttemptAt: Date.now() + 30_000,
    };
    setNewMessage("");
    setReplyTo(null);
    setShowEmojiPicker(false);
    followLiveRef.current = true;
    await putChatOutboxItem(item);
    setMessages((current) => uniqueMessages([...current, optimisticFromOutbox(item)]));
    try { await persistOutboxItem(item); } catch { toast.error("Message queued. It will retry automatically."); }
  };

  const retryMessage = async (message: ChatMessage) => {
    if (message.status !== "failed") return;
    const queued = await listChatOutboxItems(message.sender_id);
    const item = queued.find((candidate) => candidate.id === message.client_id);
    if (!item) { toast.error("This retry is no longer available"); return; }
    const retry = { ...item, nextAttemptAt: 0, lastError: null };
    await putChatOutboxItem(retry);
    setMessages((current) => current.map((entry) => entry.client_id === retry.id ? { ...entry, status: "sending" } : entry));
    try { await persistOutboxItem(retry); } catch { toast.error("Still offline. Retry is scheduled."); }
  };

  const sendImage = async (file: File) => {
    if (!user || !activeRoom) return;
    if (file.size > 20 * 1024 * 1024) { toast.error("Please choose an image under 20 MB"); return; }
    setSendingImage(true);
    try {
      const optimized = await convertToWebP(file, 0.76, 1600);
      const item: ChatOutboxItem = {
        id: crypto.randomUUID(), userId: user.id, roomId: activeRoom.id,
        content: "Photo", createdAt: new Date().toISOString(), messageType: "image",
        media: { blob: optimized, name: `${file.name}.webp`, type: "image/webp" },
        attempts: 0, nextAttemptAt: Date.now() + 30_000,
      };
      followLiveRef.current = true;
      await putChatOutboxItem(item);
      setMessages((current) => uniqueMessages([...current, optimisticFromOutbox(item)]));
      try { await persistOutboxItem(item); } catch { toast.error("Photo queued. It will retry automatically."); }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      setSendingImage(false);
    }
  };

  const sendVoiceMessage = async (voiceUrl: string, duration: number, voicePath?: string) => {
    if (!user || !activeRoom || !voicePath) throw new Error("Voice note could not be prepared");
    const item: ChatOutboxItem = {
      id: crypto.randomUUID(), userId: user.id, roomId: activeRoom.id,
      content: "Voice message", createdAt: new Date().toISOString(), messageType: "voice",
      mediaPath: voicePath, mediaUrl: voiceUrl, voiceDuration: duration,
      attempts: 0, nextAttemptAt: Date.now() + 30_000,
    };
    followLiveRef.current = true;
    await putChatOutboxItem(item);
    setMessages((current) => uniqueMessages([...current, optimisticFromOutbox(item)]));
    setShowVoiceRecorder(false);
    try { await persistOutboxItem(item); } catch { toast.error("Voice note queued. It will retry automatically."); }
  };

  useEffect(() => {
    if (!user?.id) return;
    let disposed = false;
    const sync = async () => {
      const queued = await listChatOutboxItems(user.id);
      if (disposed) return;
      if (activeRoom) {
        const roomItems = queued.filter((item) => item.roomId === activeRoom.id).map(optimisticFromOutbox);
        setMessages((current) => uniqueMessages([...current, ...roomItems]));
      }
      const due = queued.find((item) => item.nextAttemptAt <= Date.now());
      if (!due || !navigator.onLine || processingOutboxRef.current) return;
      processingOutboxRef.current = true;
      try { await persistOutboxItem(due); } catch { /* failure state is persisted by persistOutboxItem */ }
      finally { processingOutboxRef.current = false; }
    };
    void sync();
    const unsubscribe = subscribeChatOutbox(() => void sync());
    const timer = window.setInterval(() => void sync(), 5_000);
    window.addEventListener("online", sync);
    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(timer);
      window.removeEventListener("online", sync);
    };
  }, [activeRoom, optimisticFromOutbox, persistOutboxItem, user?.id]);

  useEffect(() => () => {
    outboxPreviewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    outboxPreviewUrlsRef.current.clear();
  }, []);

  const startDM = useCallback(async (peerId: string) => {
    if (!user || !friendIds.includes(peerId)) return;
    const { data: roomId, error } = await supabase.rpc("get_or_create_direct_chat", { p_peer_id: peerId });
    if (error) {
      reportError(error, { flow: "direct_messages", action: "open_connection_chat", metadata: { peerId } });
      toast.error(error.message);
      return;
    }
    const peer = friendProfiles.find((profile) => profile.user_id === peerId);
    setActiveRoom({
      id: roomId,
      is_group: false,
      created_at: new Date().toISOString(),
      displayName: peer?.name || "User",
      displayAvatar: peer?.avatar_url,
      unreadCount: 0,
      peerId,
    });
    void queryClient.invalidateQueries({ queryKey: ["chat-rooms", user.id] });
  }, [friendIds, friendProfiles, queryClient, user]);

  useEffect(() => {
    const peerId = searchParams.get("peer");
    if (!peerId || !friendIds.includes(peerId)) return;
    void startDM(peerId).finally(() => {
      const next = new URLSearchParams(searchParams);
      next.delete("peer");
      setSearchParams(next, { replace: true });
    });
  }, [friendIds, searchParams, setSearchParams, startDM]);

  const timelineRows = useMemo(() => {
    const rows: Array<{ type: "date"; key: string; label: string } | { type: "message"; key: string; message: ChatMessage }> = [];
    let previousDate = "";
    messages.forEach((message) => {
      const date = formatMessageDate(message.created_at);
      if (date !== previousDate) {
        rows.push({ type: "date", key: `date-${date}`, label: date });
        previousDate = date;
      }
      rows.push({ type: "message", key: message.client_id || message.id, message });
    });
    return rows;
  }, [messages]);
  const messageVirtualizer = useVirtualizer({
    count: timelineRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = timelineRows[index];
      if (row?.type === "date") return 44;
      if (row?.message.message_type === "image") return 260;
      if (row?.message.message_type === "voice") return 84;
      return 66;
    },
    getItemKey: (index) => timelineRows[index]?.key || index,
    overscan: 14,
  });
  const scrollToLatest = useCallback(() => {
    if (!timelineRows.length) return;
    followLiveRef.current = true;
    setNewMessageCount(0);
    messageVirtualizer.scrollToIndex(timelineRows.length - 1, { align: "end", behavior: "smooth" });
  }, [messageVirtualizer, timelineRows.length]);

  useEffect(() => {
    if (!activeRoom || !timelineRows.length || prependRef.current || !followLiveRef.current) return;
    requestAnimationFrame(() => messageVirtualizer.scrollToIndex(timelineRows.length - 1, { align: "end" }));
  }, [activeRoom, messageVirtualizer, timelineRows.length]);

  if (activeRoom) {
    const openMemberProfile = () => {
      if (!activeRoom.is_group && activeRoom.peerId) navigate(getDirectChatProfileTarget(activeRoom.peerId));
    };
    const leaveConversation = () => {
      setReplyTo(null);
      setCallMode(null);
      setCallSessionId(null);
      if (!activeRoom.is_group) {
        navigate(getDirectChatBackTarget(), { replace: true });
        return;
      }
      setActiveRoom(null);
    };
    return (
      <div className="bg-background h-[100dvh] flex flex-col">
        <header className="flex-shrink-0 z-40 px-3 py-2.5 flex items-center gap-3 border-b border-border bg-card shadow-sm">
          <button onClick={leaveConversation} className="rounded-xl p-2 text-foreground hover:bg-accent" aria-label="Open Forum channels"><ArrowLeft className="w-5 h-5" /></button>
          <button onClick={openMemberProfile} disabled={activeRoom.is_group || !activeRoom.peerId} className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden disabled:cursor-default" aria-label={activeRoom.is_group ? undefined : `Open ${activeRoom.displayName}'s profile`}>
            {activeRoom.displayAvatar ? <img src={activeRoom.displayAvatar} className="w-full h-full object-cover" alt="" /> : <span className="text-sm font-bold text-primary">{getInitials(activeRoom.displayName)}</span>}
          </button>
          <button onClick={openMemberProfile} disabled={activeRoom.is_group || !activeRoom.peerId} className="flex-1 min-w-0 text-left disabled:cursor-default" aria-label={activeRoom.is_group ? undefined : `Open ${activeRoom.displayName}'s profile`}>
            <p className="text-sm font-semibold text-foreground truncate">{activeRoom.displayName}</p>
            <p className="text-[11px] text-muted-foreground">{typingUsers.length ? `${typingUsers.join(", ")} typing…` : activeRoom.is_group ? "Group chat" : "Connected"}</p>
          </button>
          {CALLS_ENABLED && <button onClick={() => { setCallSessionId(null); setCallMode("video"); }} className="p-2 text-muted-foreground hover:text-foreground" aria-label="Video call"><Video className="w-5 h-5" /></button>}
          {CALLS_ENABLED && <button onClick={() => { setCallSessionId(null); setCallMode("audio"); }} className="p-2 text-muted-foreground hover:text-foreground" aria-label="Audio call"><Phone className="w-5 h-5" /></button>}
          <NotificationBell />
          <button onClick={() => setShowConversationInfo(true)} className="p-2 text-muted-foreground hover:text-foreground" aria-label="Conversation options"><MoreVertical className="w-5 h-5" /></button>
        </header>

        <div ref={scrollRef} onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
          followLiveRef.current = nearBottom;
          if (nearBottom) setNewMessageCount(0);
        }} className="native-scroll-region relative flex-1 px-3 py-4 chat-wallpaper">
          {hasOlder && <div className="flex justify-center mb-3"><Button size="sm" variant="secondary" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}Load earlier messages</Button></div>}
          <div style={{ height: `${messageVirtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
            {messageVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = timelineRows[virtualRow.index];
              if (!row) return null;
              return (
                <div key={row.key} data-index={virtualRow.index} ref={messageVirtualizer.measureElement}
                  style={{ position: "absolute", left: 0, top: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}>
                  {row.type === "date" ? (
                    <div className="flex items-center justify-center py-3"><span className="text-[11px] bg-card/90 text-muted-foreground px-3 py-1 rounded-lg shadow-sm font-medium">{row.label}</span></div>
                  ) : (() => {
                const message = row.message;
                const isMine = message.sender_id === user?.id;
                const legacyImage = message.content.startsWith("📷 http") ? message.content.replace("📷 ", "") : null;
                const imageUrl = message.message_type === "image" ? message.media_url : legacyImage;
                const replied = message.reply_to_message_id ? messages.find((item) => item.id === message.reply_to_message_id) : null;
                return (
                  <div className={`flex ${isMine ? "justify-end" : "justify-start"} pb-1`}>
                    <button onClick={() => retryMessage(message)} disabled={message.status !== "failed"} className={`text-left max-w-[80%] rounded-2xl px-3.5 py-2 shadow-sm relative group ${isMine ? "bg-primary text-primary-foreground rounded-br-md" : "bg-card text-foreground rounded-bl-md"} ${message.status === "failed" ? "opacity-70" : ""}`}>
                      {replied && <div className={`text-[11px] mb-1 px-2 py-1 rounded-lg border-l-2 truncate ${isMine ? "bg-white/10 border-white/30" : "bg-muted border-primary/30"}`}>{replied.message_type === "image" ? "Photo" : replied.content}</div>}
                      {imageUrl ? <img src={imageUrl} alt="Shared" className="rounded-xl max-h-64 object-cover" loading="lazy" decoding="async" />
                        : message.message_type === "voice" && message.media_url
                          ? <audio controls preload="metadata" src={message.media_url} className="h-10 max-w-full" aria-label="Voice message" />
                          : <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>}
                      <div className={`flex items-center justify-end gap-1 mt-0.5 ${isMine ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                        {message.status === "failed" && <><RotateCcw className="w-3 h-3" /><span className="text-[10px]">Retry</span></>}
                        <span className="text-[10px]">{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        {isMine && (message.status === "sending" ? <Check className="w-3.5 h-3.5 opacity-50" /> : message.read_by && message.read_by.length > 1 ? <CheckCheck className="w-3.5 h-3.5 text-blue-300" /> : <Check className="w-3.5 h-3.5" />)}
                      </div>
                      <span onClick={(event) => { event.stopPropagation(); setReplyTo(message); }} className="absolute -top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-card border border-border rounded-full p-1 shadow-sm"><Reply className="w-3 h-3 text-muted-foreground" /></span>
                    </button>
                  </div>
                );
                  })()}
                </div>
              );
            })}
          </div>
          <div ref={messagesEndRef} className="h-px" />
        </div>

        {newMessageCount > 0 && <button onClick={scrollToLatest} className="absolute bottom-24 right-4 z-30 rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground shadow-lg">{newMessageCount} new {newMessageCount === 1 ? "message" : "messages"}</button>}

        {replyTo && <div className="bg-muted/50 px-4 py-2 flex items-center gap-2 border-t border-border"><Reply className="w-4 h-4 text-primary" /><p className="text-xs text-muted-foreground flex-1 truncate">{replyTo.message_type === "image" ? "Photo" : replyTo.content}</p><button onClick={() => setReplyTo(null)}><X className="w-4 h-4" /></button></div>}
        {showEmojiPicker && <div className="flex flex-wrap gap-1 border-t border-border bg-card px-3 py-2">
          {["😀","😂","😍","🥳","😢","😮","👍","👏","🙏","❤️","🔥","🎉"].map((emoji) => <button key={emoji} onClick={() => { setNewMessage((value) => `${value}${emoji}`); setShowEmojiPicker(false); }} className="h-9 w-9 rounded-lg text-xl hover:bg-muted" aria-label={`Add ${emoji}`}>{emoji}</button>)}
        </div>}
        {showVoiceRecorder && user && <div className="border-t border-border bg-card px-3 py-2"><VoiceRecorder userId={user.id} bucket="chat-media" pathPrefix={activeRoom.id} onSend={sendVoiceMessage} onCancel={() => setShowVoiceRecorder(false)} /></div>}
        <div className="flex-shrink-0 bg-card border-t border-border px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-2">
          <button onClick={() => { setShowEmojiPicker((value) => !value); setShowVoiceRecorder(false); }} className="p-2 text-muted-foreground" aria-label="Emoji"><Smile className="w-5 h-5" /></button>
          <button onClick={() => fileInputRef.current?.click()} disabled={sendingImage} className="p-2 text-muted-foreground" aria-label="Attach image">{sendingImage ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}</button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendImage(file); event.target.value = ""; }} />
          <Input placeholder="Type a message" value={newMessage} onChange={(event) => { setNewMessage(event.target.value); handleTyping(); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} className="flex-1 h-10 rounded-full bg-secondary border-0" />
          {newMessage.trim() ? <button onClick={() => void sendMessage()} className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground" aria-label="Send"><Send className="w-4 h-4" /></button> : <button onClick={() => { setShowVoiceRecorder((value) => !value); setShowEmojiPicker(false); }} className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground" aria-label="Voice message"><Mic className="w-4 h-4" /></button>}
        </div>
        {CALLS_ENABLED && incomingCallInvite?.roomId === activeRoom.id && (
          <Dialog open onOpenChange={(open) => { if (!open) clearCallInviteParams(); }}>
            <DialogContent className="max-w-sm">
              <DialogHeader><DialogTitle>Incoming {incomingCallInvite.mode} call</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">{activeRoom.displayName} is calling you.</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={clearCallInviteParams}>Decline</Button>
                <Button onClick={() => {
                  const currentInvite = parseCallInviteQuery(roomId, searchParams);
                  if (!currentInvite) {
                    clearCallInviteParams();
                    toast.error("This call invitation has expired");
                    return;
                  }
                  setCallSessionId(currentInvite.sessionId);
                  setCallMode(currentInvite.mode);
                  clearCallInviteParams();
                }}>Answer</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
        {callMode && <Suspense fallback={null}><CallModal roomId={activeRoom.id} mode={callMode} sessionId={callSessionId || undefined} onClose={() => { setCallMode(null); setCallSessionId(null); }} /></Suspense>}
        <Dialog open={showConversationInfo} onOpenChange={setShowConversationInfo}>
          <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Conversation details</DialogTitle></DialogHeader>
            <button onClick={() => { setShowConversationInfo(false); openMemberProfile(); }} disabled={activeRoom.is_group || !activeRoom.peerId} className="flex w-full items-center gap-3 rounded-xl py-2 text-left hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"><div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-primary/10">{activeRoom.displayAvatar ? <img src={activeRoom.displayAvatar} alt="" className="h-full w-full object-cover" /> : <span className="font-bold text-primary">{getInitials(activeRoom.displayName)}</span>}</div><div><p className="font-semibold">{activeRoom.displayName}</p><p className="text-xs text-muted-foreground">{activeRoom.is_group ? "System-managed group" : "View member profile"}</p></div></button>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  const filteredRooms = rooms.filter((room) => tab === "messages" ? !room.is_group : room.is_group)
    .filter((room) => !searchQuery || room.displayName.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div className="bg-background min-h-screen">
      <header className="sticky top-0 z-40 bg-primary">
        <div className="px-4 pt-4 pb-0">
          <div className="flex items-center justify-between max-w-lg mx-auto mb-3">
            <div className="flex items-center gap-3"><button onClick={() => navigate(-1)} className="p-1 text-primary-foreground"><ArrowLeft className="w-5 h-5" /></button><h1 className="text-xl font-bold text-primary-foreground">Chats</h1></div>
            <div className="flex items-center gap-1">
              <NotificationBell />
              <Dialog>
                <DialogTrigger asChild><button className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center"><Plus className="w-5 h-5 text-primary-foreground" /></button></DialogTrigger>
                <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>New Conversation</DialogTitle></DialogHeader><div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  <p className="text-xs text-muted-foreground pt-2 px-1 flex items-center gap-1"><Lock className="w-3 h-3" />Only your connections</p>
                  {friendProfiles.length ? friendProfiles.map((profile) => <button key={profile.user_id} onClick={() => void startDM(profile.user_id)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-muted/50">{profile.avatar_url ? <img src={profile.avatar_url} className="w-9 h-9 rounded-full object-cover" alt="" /> : <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center"><span className="text-xs font-bold text-primary">{getInitials(profile.name)}</span></div>}<span className="text-sm font-medium">{profile.name || "User"}</span></button>) : <p className="text-xs text-muted-foreground text-center py-4">Connect with people to start messaging.</p>}
                </div></DialogContent>
              </Dialog>
            </div>
          </div>
          <div className="max-w-lg mx-auto pb-3 relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary-foreground/50" /><input placeholder="Search conversations" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="w-full h-9 pl-10 pr-4 rounded-lg bg-white/15 text-primary-foreground text-sm placeholder:text-primary-foreground/50 border-0 outline-none" /></div>
        </div>
        <div className="max-w-lg mx-auto flex"><button onClick={() => setTab("messages")} className={`flex-1 text-sm font-semibold py-3 border-b-2 ${tab === "messages" ? "border-white text-primary-foreground" : "border-transparent text-primary-foreground/50"}`}>Chats</button><button onClick={() => setTab("groups")} className={`flex-1 text-sm font-semibold py-3 border-b-2 ${tab === "groups" ? "border-white text-primary-foreground" : "border-transparent text-primary-foreground/50"}`}>Groups</button></div>
      </header>

      <main className="max-w-lg mx-auto">
        {roomsLoading && !rooms.length ? <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div> : roomsError && !rooms.length ? <div className="text-center py-20 px-6"><p className="text-sm font-medium">Chat database setup is not complete.</p><p className="text-xs text-muted-foreground mt-2">Apply the committed Prisma migration, then refresh.</p></div> : filteredRooms.length ? filteredRooms.map((room) => <button key={room.id} onClick={() => setActiveRoom(room)} className="w-full text-left flex items-center gap-3 px-4 py-3.5 border-b border-border/50 hover:bg-muted/30"><div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden flex-shrink-0">{room.displayAvatar ? <img src={room.displayAvatar} className="w-full h-full object-cover" alt="" loading="lazy" decoding="async" /> : <span className="text-lg font-bold text-primary">{getInitials(room.displayName)}</span>}</div><div className="flex-1 min-w-0"><div className="flex items-center justify-between"><p className="font-semibold text-sm truncate">{room.displayName}</p><span className={`text-[11px] ${room.unreadCount ? "text-primary font-semibold" : "text-muted-foreground"}`}>{room.lastMessage ? formatDistanceToNow(new Date(room.lastMessage.created_at), { addSuffix: false }) : ""}</span></div><div className="flex items-center justify-between mt-0.5"><p className="text-xs text-muted-foreground truncate pr-2">{room.lastMessage?.message_type === "image" || room.lastMessage?.content?.startsWith("📷") ? "📷 Photo" : room.lastMessage?.content || "No messages yet"}</p>{room.unreadCount > 0 && <span className="min-w-[22px] h-[22px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1.5">{room.unreadCount > 99 ? "99+" : room.unreadCount}</span>}</div></div></button>) : <div className="flex flex-col items-center justify-center py-20 text-center"><p className="text-muted-foreground text-sm">No conversations yet</p><p className="text-xs text-muted-foreground mt-1">Tap + to message a connection</p></div>}
      </main>
    </div>
  );
};

export default Chats;
