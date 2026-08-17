import { useState, useRef, useEffect } from "react";
import { X, Send, Reply, EyeOff, LocateFixed } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { format } from "date-fns";
import { toast } from "sonner";
import { renderFormattedMessage } from "./MessageFormatting";
import { appendForumTestPost, getForumTestPosts } from "@/hooks/useForumCache";
import { readMobileTestSession } from "@/lib/mobileVerification";

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const testSession = readMobileTestSession();

  // Fetch thread replies
  const { data: replies = [], isLoading } = useQuery({
    queryKey: ["thread-replies", parentPost.id],
    queryFn: async () => {
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
      const { data: repliesData } = await supabase.from("posts")
        .select("*")
        .eq("reply_to_id", parentPost.id)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });

      if (!repliesData?.length) return [];

      const authorIds = [...new Set(repliesData.map((r: any) => r.author_id))] as string[];
      const { data: profiles } = await supabase.from("profiles")
        .select("user_id, name, avatar_url, slug")
        .in("user_id", authorIds);

      const pMap = new Map(profiles?.map((p) => [p.user_id, p]) ?? []);

      return repliesData.map((r: any) => ({
        ...r,
        profile: pMap.get(r.author_id) ?? null,
      }));
    },
    staleTime: 10000,
  });

  const sendReply = useMutation({
    mutationFn: async () => {
      if (!user || !content.trim()) return;
      if (testSession) {
        appendForumTestPost(activeScope.type, activeScope.key, {
          id: `test-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          community_id: "test", scope_type: activeScope.type, scope_key: activeScope.key,
          channel: activeScope.type.toLowerCase().replace(/_/g, "-"), content: content.trim(),
          is_anonymous: isAnonymous, author_id: user.id, reply_to_id: parentPost.id,
          created_at: new Date().toISOString(), deleted_at: null,
          profile: { name: testSession.name || profile?.name || "Test User", avatar_url: null, slug: null },
        });
        return;
      }
      const { error } = await supabase.from("posts").insert({
        community_id: "default",
        scope_type: activeScope.type,
        scope_key: activeScope.key,
        channel: activeScope.type.toLowerCase().replace(/_/g, "-"),
        content: content.trim(),
        is_anonymous: isAnonymous,
        author_id: user.id,
        reply_to_id: parentPost.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setContent("");
      setIsAnonymous(false);
      queryClient.invalidateQueries({ queryKey: ["thread-replies", parentPost.id] });
      queryClient.invalidateQueries({ queryKey: ["forum-posts"] });
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 200);
    },
    onError: (err: any) => toast.error(err.message),
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [replies.length]);

  useEffect(() => {
    if (testSession) return;
    const channel = supabase.channel(`thread-${parentPost.id}-${crypto.randomUUID()}`)
      .on("postgres_changes", {
        event: "*", schema: "public", table: "posts", filter: `reply_to_id=eq.${parentPost.id}`,
      }, () => queryClient.invalidateQueries({ queryKey: ["thread-replies", parentPost.id] }))
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [parentPost.id, queryClient, testSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && content.trim()) {
      e.preventDefault();
      sendReply.mutate();
    }
  };

  const parentProfile = parentPost.profile;
  const parentIsMine = parentPost.author_id === user?.id;
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
            <div className={`w-8 h-8 rounded-full ${getUserColor(parentPost.author_id)} flex items-center justify-center`}>
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
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 min-h-0">
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
          replies.map((reply: any) => {
            const replyIsMine = reply.author_id === user?.id;
            const rName = reply.is_anonymous ? (replyIsMine ? "You · Anonymous" : "Anonymous") : reply.profile?.name || "User";
            return (
              <div key={reply.id} className={`flex items-start gap-2 rounded-xl p-1.5 ${reply.is_anonymous && replyIsMine ? "bg-primary/5 ring-1 ring-primary/10" : ""}`}>
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
                </div>
              </div>
            );
          })
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
