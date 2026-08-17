import {
  ArrowLeft, Search, Plus, Send, Check, CheckCheck, Smile, Reply,
  X, Phone, Video, MoreVertical, Mic, Paperclip, Lock, Loader2, RotateCcw,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

const PAGE_SIZE = 50;
const INBOX_CACHE_KEY = "cirkle:chat-inbox";
const CallModal = lazy(() => import("@/components/CallModal"));

type ChatMessage = {
  id: string;
  client_id?: string | null;
  content: string;
  created_at: string;
  media_url?: string | null;
  message_type?: string;
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
};

type RawRoom = Partial<ChatRoom> & Pick<ChatRoom, "id" | "is_group" | "created_at"> & {
  display_name?: string | null;
  display_avatar?: string | null;
  last_message?: unknown;
  unread_count?: number;
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
  displayName: room.display_name || room.displayName || (room.is_group ? room.name : "User") || "User",
  displayAvatar: room.display_avatar || room.displayAvatar || room.avatar_url,
  lastMessage: (room.last_message && typeof room.last_message === "object" ? room.last_message as ChatMessage : null) || room.lastMessage || null,
  unreadCount: Number(room.unread_count ?? room.unreadCount ?? 0),
});

const readInboxCache = (): ChatRoom[] => {
  try { return (JSON.parse(localStorage.getItem(INBOX_CACHE_KEY) || "[]") as RawRoom[]).map(normalizeRoom); }
  catch { return []; }
};

const uniqueMessages = (items: ChatMessage[]) => {
  const byKey = new Map<string, ChatMessage>();
  for (const message of items) {
    const key = message.client_id || message.id;
    const previous = byKey.get(key);
    if (!previous || previous.id.startsWith("optimistic-")) byKey.set(key, message);
  }
  return [...byKey.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
};

const Chats = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const roomChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const typingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingBroadcastRef = useRef(0);
  const prependRef = useRef(false);

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
      const { data, error } = await supabase.rpc("get_chat_inbox");
      if (error) throw error;
      const inbox = (data || []).map(normalizeRoom);
      localStorage.setItem(INBOX_CACHE_KEY, JSON.stringify(inbox));
      return inbox as ChatRoom[];
    },
    enabled: !!user,
    placeholderData: readInboxCache,
    staleTime: 30_000,
    refetchOnReconnect: true,
  });

  const markReadSoon = useCallback((roomId: string) => {
    if (readTimerRef.current) clearTimeout(readTimerRef.current);
    readTimerRef.current = setTimeout(async () => {
      await supabase.rpc("mark_chat_read", { p_room_id: roomId });
      queryClient.setQueryData<ChatRoom[]>(["chat-rooms", user?.id], (current = []) =>
        current.map((room) => room.id === roomId ? { ...room, unreadCount: 0 } : room));
    }, 500);
  }, [queryClient, user?.id]);

  useEffect(() => {
    if (!activeRoom || !user) return;
    let cancelled = false;
    setMessages([]);
    setHasOlder(false);

    void getCachedMessages<ChatMessage>(activeRoom.id).then((cached) => {
      if (!cancelled && cached.length) setMessages(uniqueMessages(cached));
    });

    void (async () => {
      const { data, error } = await supabase.from("messages").select("*")
        .eq("room_id", activeRoom.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE_SIZE);
      if (cancelled) return;
      if (error) { toast.error("Could not refresh messages"); return; }
      const page = ((data || []) as ChatMessage[]).reverse();
      setMessages(page);
      setHasOlder(page.length === PAGE_SIZE);
      void cacheMessages(activeRoom.id, page);
      markReadSoon(activeRoom.id);
    })();

    const channel = supabase
      .channel(`room-${activeRoom.id}`, { config: { broadcast: { self: false } } })
      .on("postgres_changes", {
        event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${activeRoom.id}`,
      }, (payload) => {
        const incoming = payload.new as ChatMessage;
        setMessages((current) => uniqueMessages([...current, incoming]));
        if (incoming.sender_id !== user.id) markReadSoon(activeRoom.id);
        queryClient.invalidateQueries({ queryKey: ["chat-rooms", user.id] });
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (!payload?.userId || payload.userId === user.id) return;
        const name = payload.name || "Someone";
        setTypingUsers((current) => payload.typing
          ? [...new Set([...current, name])]
          : current.filter((value) => value !== name));
        if (payload.typing) setTimeout(() => setTypingUsers((current) => current.filter((value) => value !== name)), 3000);
      })
      .subscribe();
    roomChannelRef.current = channel;

    return () => {
      cancelled = true;
      roomChannelRef.current = null;
      void supabase.removeChannel(channel);
      if (readTimerRef.current) clearTimeout(readTimerRef.current);
    };
  }, [activeRoom, markReadSoon, queryClient, user]);

  useEffect(() => {
    if (!activeRoom || !messages.length) return;
    void cacheMessages(activeRoom.id, messages);
    if (!prependRef.current) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    prependRef.current = false;
  }, [activeRoom, messages]);

  const loadOlder = async () => {
    if (!activeRoom || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    const container = scrollRef.current;
    const oldHeight = container?.scrollHeight || 0;
    const { data, error } = await supabase.from("messages").select("*")
      .eq("room_id", activeRoom.id)
      .lt("created_at", messages[0].created_at)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE_SIZE);
    if (!error) {
      const page = ((data || []) as ChatMessage[]).reverse();
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

  const persistMessage = async (optimistic: ChatMessage) => {
    const { data, error } = await supabase.from("messages").insert({
      room_id: optimistic.room_id,
      sender_id: optimistic.sender_id,
      content: optimistic.content,
      reply_to_message_id: optimistic.reply_to_message_id || null,
      client_id: optimistic.client_id,
      message_type: optimistic.message_type || "text",
      media_url: optimistic.media_url || null,
      status: "sent",
      read_by: [optimistic.sender_id],
    }).select().single();

    if (error) {
      setMessages((current) => current.map((item) => item.client_id === optimistic.client_id ? { ...item, status: "failed" } : item));
      toast.error("Message not sent. Tap retry.");
      return;
    }
    setMessages((current) => uniqueMessages(current.map((item) => item.client_id === optimistic.client_id ? data as ChatMessage : item)));
    queryClient.invalidateQueries({ queryKey: ["chat-rooms", user?.id] });
  };

  const sendMessage = async () => {
    const content = newMessage.trim();
    if (!content || !user || !activeRoom) return;
    const clientId = crypto.randomUUID();
    const optimistic: ChatMessage = {
      id: `optimistic-${clientId}`,
      client_id: clientId,
      content,
      created_at: new Date().toISOString(),
      message_type: "text",
      read_by: [user.id],
      reply_to_message_id: replyTo?.id.startsWith("optimistic-") ? null : replyTo?.id || null,
      room_id: activeRoom.id,
      sender_id: user.id,
      status: "sending",
    };
    setNewMessage("");
    setReplyTo(null);
    setMessages((current) => uniqueMessages([...current, optimistic]));
    await persistMessage(optimistic);
  };

  const retryMessage = async (message: ChatMessage) => {
    if (message.status !== "failed") return;
    setMessages((current) => current.map((item) => item.id === message.id ? { ...item, status: "sending" } : item));
    const { data: existing } = await supabase.from("messages").select("*").eq("sender_id", message.sender_id)
      .eq("client_id", message.client_id!).maybeSingle();
    if (existing) {
      setMessages((current) => uniqueMessages(current.map((item) => item.client_id === message.client_id ? existing as ChatMessage : item)));
      return;
    }
    await persistMessage({ ...message, status: "sending" });
  };

  const sendImage = async (file: File) => {
    if (!user || !activeRoom) return;
    if (file.size > 20 * 1024 * 1024) { toast.error("Please choose an image under 20 MB"); return; }
    setSendingImage(true);
    try {
      const optimized = await convertToWebP(file, 0.76, 1600);
      const clientId = crypto.randomUUID();
      const path = `${user.id}/${activeRoom.id}/${clientId}.webp`;
      const { error: uploadError } = await supabase.storage.from("post-images").upload(path, optimized, {
        contentType: "image/webp",
        cacheControl: "31536000",
        upsert: false,
      });
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from("post-images").getPublicUrl(path);
      const optimistic: ChatMessage = {
        id: `optimistic-${clientId}`,
        client_id: clientId,
        content: "Photo",
        created_at: new Date().toISOString(),
        media_url: urlData.publicUrl,
        message_type: "image",
        read_by: [user.id],
        room_id: activeRoom.id,
        sender_id: user.id,
        status: "sending",
      };
      setMessages((current) => uniqueMessages([...current, optimistic]));
      await persistMessage(optimistic);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Image upload failed");
    } finally {
      setSendingImage(false);
    }
  };

  const startDM = useCallback(async (peerId: string) => {
    if (!user || !friendIds.includes(peerId)) return;
    const { data: roomId, error } = await supabase.rpc("get_or_create_direct_chat", { p_peer_id: peerId });
    if (error) { toast.error(error.message); return; }
    const peer = friendProfiles.find((profile) => profile.user_id === peerId);
    setActiveRoom({
      id: roomId,
      is_group: false,
      created_at: new Date().toISOString(),
      displayName: peer?.name || "User",
      displayAvatar: peer?.avatar_url,
      unreadCount: 0,
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

  const groupedMessages = messages.reduce<{ date: string; items: ChatMessage[] }[]>((groups, message) => {
    const date = formatMessageDate(message.created_at);
    const last = groups[groups.length - 1];
    if (last?.date === date) last.items.push(message);
    else groups.push({ date, items: [message] });
    return groups;
  }, []);

  if (activeRoom) {
    return (
      <div className="bg-background h-[100dvh] flex flex-col">
        <header className="flex-shrink-0 z-40 px-3 py-2.5 flex items-center gap-3 bg-primary shadow-md">
          <button onClick={() => { setActiveRoom(null); setReplyTo(null); setCallMode(null); }} className="text-primary-foreground p-1" aria-label="Back to conversations"><ArrowLeft className="w-5 h-5" /></button>
          <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center overflow-hidden">
            {activeRoom.displayAvatar ? <img src={activeRoom.displayAvatar} className="w-full h-full object-cover" alt="" /> : <span className="text-sm font-bold text-primary-foreground">{getInitials(activeRoom.displayName)}</span>}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-primary-foreground truncate">{activeRoom.displayName}</p>
            <p className="text-[11px] text-primary-foreground/70">{typingUsers.length ? `${typingUsers.join(", ")} typing…` : activeRoom.is_group ? "Group chat" : "Connected"}</p>
          </div>
          <button onClick={() => setCallMode("video")} className="p-2 text-primary-foreground/80" aria-label="Video call"><Video className="w-5 h-5" /></button>
          <button onClick={() => setCallMode("audio")} className="p-2 text-primary-foreground/80" aria-label="Audio call"><Phone className="w-5 h-5" /></button>
          <button className="p-2 text-primary-foreground/80" aria-label="Conversation options"><MoreVertical className="w-5 h-5" /></button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 chat-wallpaper overscroll-contain">
          {hasOlder && <div className="flex justify-center mb-3"><Button size="sm" variant="secondary" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}Load earlier messages</Button></div>}
          {groupedMessages.map((group) => (
            <div key={group.date}>
              <div className="flex items-center justify-center my-3"><span className="text-[11px] bg-card/90 text-muted-foreground px-3 py-1 rounded-lg shadow-sm font-medium">{group.date}</span></div>
              {group.items.map((message) => {
                const isMine = message.sender_id === user?.id;
                const legacyImage = message.content.startsWith("📷 http") ? message.content.replace("📷 ", "") : null;
                const imageUrl = message.message_type === "image" ? message.media_url : legacyImage;
                const replied = message.reply_to_message_id ? messages.find((item) => item.id === message.reply_to_message_id) : null;
                return (
                  <div key={message.client_id || message.id} className={`flex ${isMine ? "justify-end" : "justify-start"} mb-1`}>
                    <button onClick={() => retryMessage(message)} disabled={message.status !== "failed"} className={`text-left max-w-[80%] rounded-2xl px-3.5 py-2 shadow-sm relative group ${isMine ? "bg-primary text-primary-foreground rounded-br-md" : "bg-card text-foreground rounded-bl-md"} ${message.status === "failed" ? "opacity-70" : ""}`}>
                      {replied && <div className={`text-[11px] mb-1 px-2 py-1 rounded-lg border-l-2 truncate ${isMine ? "bg-white/10 border-white/30" : "bg-muted border-primary/30"}`}>{replied.message_type === "image" ? "Photo" : replied.content}</div>}
                      {imageUrl ? <img src={imageUrl} alt="Shared" className="rounded-xl max-h-64 object-cover" loading="lazy" decoding="async" /> : <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">{message.content}</p>}
                      <div className={`flex items-center justify-end gap-1 mt-0.5 ${isMine ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                        {message.status === "failed" && <><RotateCcw className="w-3 h-3" /><span className="text-[10px]">Retry</span></>}
                        <span className="text-[10px]">{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                        {isMine && (message.status === "sending" ? <Check className="w-3.5 h-3.5 opacity-50" /> : message.read_by && message.read_by.length > 1 ? <CheckCheck className="w-3.5 h-3.5 text-blue-300" /> : <Check className="w-3.5 h-3.5" />)}
                      </div>
                      <span onClick={(event) => { event.stopPropagation(); setReplyTo(message); }} className="absolute -top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-card border border-border rounded-full p-1 shadow-sm"><Reply className="w-3 h-3 text-muted-foreground" /></span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {replyTo && <div className="bg-muted/50 px-4 py-2 flex items-center gap-2 border-t border-border"><Reply className="w-4 h-4 text-primary" /><p className="text-xs text-muted-foreground flex-1 truncate">{replyTo.message_type === "image" ? "Photo" : replyTo.content}</p><button onClick={() => setReplyTo(null)}><X className="w-4 h-4" /></button></div>}
        <div className="flex-shrink-0 bg-card border-t border-border px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex items-center gap-2">
          <button className="p-2 text-muted-foreground" aria-label="Emoji"><Smile className="w-5 h-5" /></button>
          <button onClick={() => fileInputRef.current?.click()} disabled={sendingImage} className="p-2 text-muted-foreground" aria-label="Attach image">{sendingImage ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}</button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void sendImage(file); event.target.value = ""; }} />
          <Input placeholder="Type a message" value={newMessage} onChange={(event) => { setNewMessage(event.target.value); handleTyping(); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} className="flex-1 h-10 rounded-full bg-secondary border-0" />
          {newMessage.trim() ? <button onClick={() => void sendMessage()} className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground" aria-label="Send"><Send className="w-4 h-4" /></button> : <button className="w-10 h-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground" aria-label="Voice message"><Mic className="w-4 h-4" /></button>}
        </div>
        {callMode && <Suspense fallback={null}><CallModal roomId={activeRoom.id} mode={callMode} onClose={() => setCallMode(null)} /></Suspense>}
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
            <Dialog>
              <DialogTrigger asChild><button className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center"><Plus className="w-5 h-5 text-primary-foreground" /></button></DialogTrigger>
              <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>New Conversation</DialogTitle></DialogHeader><div className="space-y-2 max-h-[50vh] overflow-y-auto">
                <p className="text-xs text-muted-foreground pt-2 px-1 flex items-center gap-1"><Lock className="w-3 h-3" />Only your connections</p>
                {friendProfiles.length ? friendProfiles.map((profile) => <button key={profile.user_id} onClick={() => void startDM(profile.user_id)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-muted/50">{profile.avatar_url ? <img src={profile.avatar_url} className="w-9 h-9 rounded-full object-cover" alt="" /> : <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center"><span className="text-xs font-bold text-primary">{getInitials(profile.name)}</span></div>}<span className="text-sm font-medium">{profile.name || "User"}</span></button>) : <p className="text-xs text-muted-foreground text-center py-4">Connect with people to start messaging.</p>}
              </div></DialogContent>
            </Dialog>
          </div>
          <div className="max-w-lg mx-auto pb-3 relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary-foreground/50" /><input placeholder="Search conversations" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} className="w-full h-9 pl-10 pr-4 rounded-lg bg-white/15 text-primary-foreground text-sm placeholder:text-primary-foreground/50 border-0 outline-none" /></div>
        </div>
        <div className="max-w-lg mx-auto flex"><button onClick={() => setTab("messages")} className={`flex-1 text-sm font-semibold py-3 border-b-2 ${tab === "messages" ? "border-white text-primary-foreground" : "border-transparent text-primary-foreground/50"}`}>Chats</button><button onClick={() => setTab("groups")} className={`flex-1 text-sm font-semibold py-3 border-b-2 ${tab === "groups" ? "border-white text-primary-foreground" : "border-transparent text-primary-foreground/50"}`}>Groups</button></div>
      </header>

      <main className="max-w-lg mx-auto">
        {roomsLoading && !rooms.length ? <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div> : roomsError && !rooms.length ? <div className="text-center py-20 px-6"><p className="text-sm font-medium">Chat database setup is not complete.</p><p className="text-xs text-muted-foreground mt-2">Apply the included Supabase migration, then refresh.</p></div> : filteredRooms.length ? filteredRooms.map((room) => <button key={room.id} onClick={() => setActiveRoom(room)} className="w-full text-left flex items-center gap-3 px-4 py-3.5 border-b border-border/50 hover:bg-muted/30"><div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden flex-shrink-0">{room.displayAvatar ? <img src={room.displayAvatar} className="w-full h-full object-cover" alt="" loading="lazy" decoding="async" /> : <span className="text-lg font-bold text-primary">{getInitials(room.displayName)}</span>}</div><div className="flex-1 min-w-0"><div className="flex items-center justify-between"><p className="font-semibold text-sm truncate">{room.displayName}</p><span className={`text-[11px] ${room.unreadCount ? "text-primary font-semibold" : "text-muted-foreground"}`}>{room.lastMessage ? formatDistanceToNow(new Date(room.lastMessage.created_at), { addSuffix: false }) : ""}</span></div><div className="flex items-center justify-between mt-0.5"><p className="text-xs text-muted-foreground truncate pr-2">{room.lastMessage?.message_type === "image" || room.lastMessage?.content?.startsWith("📷") ? "📷 Photo" : room.lastMessage?.content || "No messages yet"}</p>{room.unreadCount > 0 && <span className="min-w-[22px] h-[22px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center px-1.5">{room.unreadCount > 99 ? "99+" : room.unreadCount}</span>}</div></div></button>) : <div className="flex flex-col items-center justify-center py-20 text-center"><p className="text-muted-foreground text-sm">No conversations yet</p><p className="text-xs text-muted-foreground mt-1">Tap + to message a connection</p></div>}
      </main>
    </div>
  );
};

export default Chats;
