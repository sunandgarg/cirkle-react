import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { MessageSquare, EyeOff, Eye, Trash2, CornerDownRight, AlertCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";

const db = supabase as any;

type Comment = {
  id: string;
  blog_id: string;
  parent_id: string | null;
  author_id: string;
  content: string;
  is_hidden: boolean;
  created_at: string;
};

const BlogComments = ({ blogId, isAdmin }: { blogId: string; isAdmin?: boolean }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

  const { data: comments, isLoading, isError, refetch } = useQuery({
    queryKey: ["blog-comments", blogId],
    queryFn: async () => {
      const { data, error } = await db
        .from("blog_comments")
        .select("*")
        .eq("blog_id", blogId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Comment[];
    },
  });

  const authorIds = useMemo(() => [...new Set((comments ?? []).map((c) => c.author_id))], [comments]);

  const { data: authors } = useQuery({
    queryKey: ["blog-comment-authors", authorIds],
    queryFn: async () => {
      if (!authorIds.length) return {} as Record<string, any>;
      const { data } = await supabase.from("profiles").select("user_id, name, avatar_url, slug").in("user_id", authorIds);
      const map: Record<string, any> = {};
      data?.forEach((p) => { map[p.user_id] = p; });
      return map;
    },
    enabled: authorIds.length > 0,
  });

  const addComment = useMutation({
    mutationFn: async ({ content, parent_id }: { content: string; parent_id: string | null }) => {
      if (!user) throw new Error("Sign in to comment");
      const { error } = await db.from("blog_comments").insert({
        blog_id: blogId, parent_id, author_id: user.id, content: content.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blog-comments", blogId] });
      setDraft(""); setReplyDraft(""); setReplyTo(null);
    },
    onError: (e: any) => toast.error(e.message || "Could not post comment"),
  });

  const toggleHidden = useMutation({
    mutationFn: async (c: Comment) => {
      const { error } = await db.from("blog_comments").update({ is_hidden: !c.is_hidden }).eq("id", c.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blog-comments", blogId] }),
    onError: (e: any) => toast.error(e.message),
  });

  const removeComment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("blog_comments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["blog-comments", blogId] }); toast.success("Comment removed"); },
    onError: (e: any) => toast.error(e.message),
  });

  const roots = (comments ?? []).filter((c) => !c.parent_id);
  const childrenOf = (id: string) => (comments ?? []).filter((c) => c.parent_id === id);

  const renderComment = (c: Comment, depth = 0) => {
    const a = authors?.[c.author_id];
    const canModerate = isAdmin || user?.id === c.author_id;
    return (
      <div key={c.id} className={depth ? "pl-4 sm:pl-6 border-l border-border" : ""}>
        <div className="py-3">
          <div className="flex items-start gap-2.5">
            {a?.avatar_url ? (
              <img src={a.avatar_url} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-[10px] font-bold text-primary">{(a?.name || "U")[0]}</span>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-foreground">{a?.name || "Member"}</span>
                <span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}</span>
                {c.is_hidden && <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-semibold">Hidden</span>}
              </div>
              <p className={`text-sm leading-6 mt-1 whitespace-pre-wrap ${c.is_hidden ? "text-muted-foreground italic" : "text-foreground"}`}>
                {c.content}
              </p>
              <div className="flex items-center gap-3 mt-1.5">
                <button
                  onClick={() => { if (!user) return navigate("/auth"); setReplyTo(replyTo === c.id ? null : c.id); }}
                  className="text-[11px] font-semibold text-muted-foreground hover:text-primary flex items-center gap-1"
                >
                  <CornerDownRight className="w-3 h-3" /> Reply
                </button>
                {isAdmin && (
                  <button onClick={() => toggleHidden.mutate(c)} className="text-[11px] font-semibold text-muted-foreground hover:text-primary flex items-center gap-1">
                    {c.is_hidden ? <><Eye className="w-3 h-3" /> Unhide</> : <><EyeOff className="w-3 h-3" /> Hide</>}
                  </button>
                )}
                {canModerate && (
                  <button onClick={() => removeComment.mutate(c.id)} className="text-[11px] font-semibold text-muted-foreground hover:text-destructive flex items-center gap-1">
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                )}
              </div>

              {replyTo === c.id && (
                <div className="mt-2.5 space-y-2">
                  <Textarea
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    rows={2}
                    placeholder="Write a reply..."
                    className="bg-secondary border-border text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => { setReplyTo(null); setReplyDraft(""); }}>Cancel</Button>
                    <Button
                      size="sm"
                      disabled={!replyDraft.trim() || addComment.isPending}
                      onClick={() => addComment.mutate({ content: replyDraft, parent_id: c.id })}
                    >
                      Reply
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {childrenOf(c.id).map((child) => renderComment(child, depth + 1))}
      </div>
    );
  };

  return (
    <section className="mt-10 pt-6 border-t border-border">
      <h2 className="text-sm font-bold text-foreground flex items-center gap-2 mb-4">
        <MessageSquare className="w-4 h-4" /> Comments {comments?.length ? `(${comments.length})` : ""}
      </h2>

      {user ? (
        <div className="space-y-2 mb-6">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Share your thoughts..."
            className="bg-secondary border-border text-sm"
          />
          <div className="flex justify-end">
            <Button size="sm" disabled={!draft.trim() || addComment.isPending} onClick={() => addComment.mutate({ content: draft, parent_id: null })}>
              Post comment
            </Button>
          </div>
        </div>
      ) : (
        <div className="mb-6 bg-secondary/60 border border-border rounded-xl p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">Sign in to join the discussion.</p>
          <Button size="sm" onClick={() => navigate("/auth")}>Sign in</Button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-14 bg-secondary rounded-xl animate-pulse" />)}
        </div>
      ) : isError ? (
        <div className="text-center py-8">
          <AlertCircle className="w-8 h-8 text-destructive/60 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground mb-3">Could not load comments.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : roots.length ? (
        <div className="divide-y divide-border">{roots.map((c) => renderComment(c))}</div>
      ) : (
        <p className="text-sm text-muted-foreground py-6 text-center">No comments yet - be the first to respond.</p>
      )}
    </section>
  );
};

export default BlogComments;
