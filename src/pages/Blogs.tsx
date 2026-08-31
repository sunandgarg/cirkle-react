import { useState, useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Plus, X, Pencil, Trash2, BookOpen, Search, Clock, CalendarDays,
  Heart, Bookmark, AlertCircle, Filter, Eye, Send, FileText, CalendarClock,
} from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { format, formatDistanceToNow, isAfter, isBefore, parseISO } from "date-fns";
import BlogComments from "@/components/blog/BlogComments";

const db = supabase as any;

const slugify = (title: string, id: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${id.slice(0, 8)}`;

const readTime = (content: string) => Math.max(1, Math.round(content.trim().split(/\s+/).length / 200));

const isLive = (b: any) =>
  b.published && (b.status ?? "published") === "published" && (!b.scheduled_at || new Date(b.scheduled_at) <= new Date());

const emptyForm = {
  title: "", content: "", category: "General", cover_image_url: "",
  tags: "", status: "published" as "published" | "draft" | "scheduled", scheduled_at: "",
};

const Blogs = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { slug } = useParams();
  const queryClient = useQueryClient();
  const [showEditor, setShowEditor] = useState(false);
  const [preview, setPreview] = useState(false);
  const [editingBlog, setEditingBlog] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [adminView, setAdminView] = useState<"live" | "drafts">("live");
  const [form, setForm] = useState(emptyForm);

  const { data: isAdmin } = useQuery({
    queryKey: ["is-admin-blogs", user?.id],
    queryFn: async () => {
      if (!user) return false;
      const { data } = await supabase.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin");
      return (data && data.length > 0) || false;
    },
    enabled: !!user,
  });

  const { data: blogs, isLoading, isError, refetch } = useQuery({
    queryKey: ["blogs", isAdmin],
    queryFn: async () => {
      let q = db.from("blogs").select("*").order("created_at", { ascending: false });
      if (!isAdmin) q = q.eq("published", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as any[];
    },
  });

  const visibleBlogs = useMemo(
    () => (blogs ?? []).filter((b) => isAdmin || isLive(b)),
    [blogs, isAdmin]
  );

  const { data: blogAuthors } = useQuery({
    queryKey: ["blog-authors", visibleBlogs.length],
    queryFn: async () => {
      if (!visibleBlogs.length) return {} as Record<string, any>;
      const ids = [...new Set(visibleBlogs.map((b: any) => b.author_id))];
      const { data } = await supabase.from("profiles").select("user_id, name, avatar_url").in("user_id", ids);
      const map: Record<string, any> = {};
      data?.forEach((p) => { map[p.user_id] = p; });
      return map;
    },
    enabled: visibleBlogs.length > 0,
  });

  // ── Likes & bookmarks ──
  const { data: likes } = useQuery({
    queryKey: ["blog-likes"],
    queryFn: async () => {
      const { data } = await db.from("blog_likes").select("blog_id, user_id");
      return (data ?? []) as { blog_id: string; user_id: string }[];
    },
  });

  const { data: bookmarks } = useQuery({
    queryKey: ["blog-bookmarks", user?.id],
    queryFn: async () => {
      if (!user) return [] as { blog_id: string }[];
      const { data } = await db.from("blog_bookmarks").select("blog_id").eq("user_id", user.id);
      return (data ?? []) as { blog_id: string }[];
    },
    enabled: !!user,
  });

  const likeCount = (id: string) => (likes ?? []).filter((l) => l.blog_id === id).length;
  const hasLiked = (id: string) => !!user && (likes ?? []).some((l) => l.blog_id === id && l.user_id === user.id);
  const hasBookmarked = (id: string) => (bookmarks ?? []).some((b) => b.blog_id === id);

  const toggleLike = useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error("Sign in to like articles");
      if (hasLiked(id)) {
        const { error } = await db.from("blog_likes").delete().eq("blog_id", id).eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("blog_likes").insert({ blog_id: id, user_id: user.id });
        if (error) throw error;
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["blog-likes"] }),
    onError: (e: any) => toast.error(e.message),
  });

  const toggleBookmark = useMutation({
    mutationFn: async (id: string) => {
      if (!user) throw new Error("Sign in to save articles");
      if (hasBookmarked(id)) {
        const { error } = await db.from("blog_bookmarks").delete().eq("blog_id", id).eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("blog_bookmarks").insert({ blog_id: id, user_id: user.id });
        if (error) throw error;
      }
    },
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ["blog-bookmarks", user?.id] });
      toast.success(hasBookmarked(id) ? "Removed from saved" : "Saved for later");
    },
    onError: (e: any) => toast.error(e.message),
  });

  // ── Admin publishing ──
  const saveBlog = useMutation({
    mutationFn: async () => {
      if (!user) return;
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const payload: any = {
        title: form.title,
        content: form.content,
        category: form.category,
        cover_image_url: form.cover_image_url || null,
        tags,
        status: form.status,
        scheduled_at: form.status === "scheduled" && form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null,
        published: form.status !== "draft",
      };
      if (editingBlog) {
        const { error } = await db.from("blogs").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", editingBlog.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("blogs").insert({ ...payload, author_id: user.id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blogs"] });
      setShowEditor(false); setPreview(false); setEditingBlog(null); setForm(emptyForm);
      toast.success(editingBlog ? "Post updated" : form.status === "draft" ? "Draft saved" : form.status === "scheduled" ? "Post scheduled" : "Post published");
    },
    onError: (err: any) => toast.error(err.message),
  });

  const publishNow = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("blogs").update({ status: "published", published: true, scheduled_at: null }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["blogs"] }); toast.success("Published"); },
    onError: (e: any) => toast.error(e.message),
  });

  const deleteBlog = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("blogs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["blogs"] }); toast.success("Blog deleted"); },
  });

  const openEdit = (blog: any) => {
    setForm({
      title: blog.title,
      content: blog.content,
      category: blog.category || "General",
      cover_image_url: blog.cover_image_url || "",
      tags: (blog.tags ?? []).join(", "),
      status: (blog.status as any) || (blog.published ? "published" : "draft"),
      scheduled_at: blog.scheduled_at ? format(new Date(blog.scheduled_at), "yyyy-MM-dd'T'HH:mm") : "",
    });
    setEditingBlog(blog);
    setPreview(false);
    setShowEditor(true);
  };

  const listSource = useMemo(() => {
    if (isAdmin && adminView === "drafts") return visibleBlogs.filter((b) => !isLive(b));
    return visibleBlogs.filter(isLive);
  }, [visibleBlogs, isAdmin, adminView]);

  const categories = useMemo(() => {
    const set = new Set<string>(listSource.map((b: any) => b.category || "General"));
    return ["All", ...Array.from(set)];
  }, [listSource]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    listSource.forEach((b: any) => (b.tags ?? []).forEach((t: string) => set.add(t)));
    return Array.from(set).slice(0, 24);
  }, [listSource]);

  const filtersActive = category !== "All" || !!activeTag || !!fromDate || !!toDate || !!search.trim();

  const clearFilters = () => { setCategory("All"); setActiveTag(null); setFromDate(""); setToDate(""); setSearch(""); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return listSource.filter((b: any) => {
      if (category !== "All" && (b.category || "General") !== category) return false;
      if (activeTag && !(b.tags ?? []).includes(activeTag)) return false;
      const created = new Date(b.created_at);
      if (fromDate && isBefore(created, parseISO(fromDate))) return false;
      if (toDate && isAfter(created, new Date(parseISO(toDate).getTime() + 86400000 - 1))) return false;
      if (q) {
        const hay = `${b.title} ${b.content} ${(b.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [listSource, search, category, activeTag, fromDate, toDate]);

  const activeBlog = useMemo(
    () => (slug ? visibleBlogs.find((b: any) => slugify(b.title, b.id) === slug || b.id === slug) : null),
    [slug, visibleBlogs]
  );

  // ── Article detail view ──
  if (slug) {
    if (isLoading) {
      return <div className="min-h-screen bg-background flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
    }
    if (!activeBlog) {
      return (
        <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 px-6 text-center">
          <BookOpen className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">This article is no longer available.</p>
          <Button variant="outline" onClick={() => navigate("/blogs")}>Back to News</Button>
        </div>
      );
    }
    const author = blogAuthors?.[activeBlog.author_id];
    const related = visibleBlogs.filter((b: any) => isLive(b) && b.id !== activeBlog.id && (b.category || "General") === (activeBlog.category || "General")).slice(0, 3);
    return (
      <div className="bg-background min-h-screen pb-24">
        <header className="sticky top-0 z-40 bg-card/95 backdrop-blur border-b border-border px-4 py-3">
          <div className="flex items-center gap-3 max-w-3xl mx-auto">
            <button onClick={() => navigate("/blogs")} className="p-1 text-foreground" aria-label="Back to news"><ArrowLeft className="w-5 h-5" /></button>
            <h1 className="text-base font-bold text-foreground truncate">News</h1>
          </div>
        </header>
        <article className="max-w-3xl mx-auto px-4 py-6">
          {!isLive(activeBlog) && (
            <div className="mb-4 text-xs font-semibold px-3 py-2 rounded-xl bg-amber-500/10 text-amber-700 border border-amber-500/20">
              Preview - this post is {activeBlog.status === "scheduled" ? `scheduled for ${format(new Date(activeBlog.scheduled_at), "dd MMM yyyy, HH:mm")}` : "a draft"} and is not visible to readers.
            </div>
          )}
          <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">{activeBlog.category || "General"}</span>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground leading-tight mt-3 mb-3">{activeBlog.title}</h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mb-5">
            <button onClick={() => navigate(`/blogs/author/${activeBlog.author_id}`)} className="flex items-center gap-1.5 hover:text-primary transition-colors">
              {author?.avatar_url ? <img src={author.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" /> : <div className="w-5 h-5 rounded-full bg-primary/10" />}
              {author?.name || "Cirkle Desk"}
            </button>
            <span className="flex items-center gap-1"><CalendarDays className="w-3.5 h-3.5" />{format(new Date(activeBlog.created_at), "dd MMM yyyy")}</span>
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{readTime(activeBlog.content)} min read</span>
          </div>
          {activeBlog.cover_image_url && (
            <img src={activeBlog.cover_image_url} alt={activeBlog.title} className="w-full rounded-2xl border border-border mb-6 object-cover max-h-[380px]" loading="lazy" />
          )}
          <div className="text-[15px] leading-7 text-foreground whitespace-pre-wrap">{activeBlog.content}</div>

          {(activeBlog.tags ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2 mt-6">
              {(activeBlog.tags ?? []).map((t: string) => (
                <button key={t} onClick={() => { setActiveTag(t); navigate("/blogs"); }} className="text-[11px] px-2.5 py-1 rounded-full bg-secondary text-muted-foreground hover:text-primary">#{t}</button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 mt-6">
            <button
              onClick={() => (user ? toggleLike.mutate(activeBlog.id) : navigate("/auth"))}
              className={`h-10 px-4 rounded-full border text-sm font-semibold flex items-center gap-2 transition-colors ${hasLiked(activeBlog.id) ? "bg-primary/10 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground hover:border-primary/40"}`}
            >
              <Heart className={`w-4 h-4 ${hasLiked(activeBlog.id) ? "fill-current" : ""}`} /> {likeCount(activeBlog.id)}
            </button>
            <button
              onClick={() => (user ? toggleBookmark.mutate(activeBlog.id) : navigate("/auth"))}
              className={`h-10 px-4 rounded-full border text-sm font-semibold flex items-center gap-2 transition-colors ${hasBookmarked(activeBlog.id) ? "bg-primary/10 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground hover:border-primary/40"}`}
            >
              <Bookmark className={`w-4 h-4 ${hasBookmarked(activeBlog.id) ? "fill-current" : ""}`} /> {hasBookmarked(activeBlog.id) ? "Saved" : "Save"}
            </button>
          </div>

          <BlogComments blogId={activeBlog.id} isAdmin={!!isAdmin} />

          {related.length > 0 && (
            <section className="mt-10 pt-6 border-t border-border">
              <h2 className="text-sm font-bold text-foreground mb-3">Related news</h2>
              <div className="grid sm:grid-cols-3 gap-3">
                {related.map((b: any) => (
                  <button key={b.id} onClick={() => navigate(`/blogs/${slugify(b.title, b.id)}`)} className="text-left bg-card border border-border rounded-xl p-3 hover:border-primary/40 transition-colors">
                    <p className="text-xs font-semibold text-foreground line-clamp-2">{b.title}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">{formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</p>
                  </button>
                ))}
              </div>
            </section>
          )}
        </article>
      </div>
    );
  }

  const [featured, ...rest] = filtered;

  // ── News listing ──
  return (
    <div className="bg-background min-h-screen pb-24">
      <header className="sticky top-0 z-40 bg-card border-b border-border px-4 py-3">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="p-1 text-foreground" aria-label="Go back"><ArrowLeft className="w-5 h-5" /></button>
            <h1 className="text-lg font-bold text-foreground">News</h1>
          </div>
          {isAdmin && (
            <Button size="sm" className="gap-1.5 rounded-full" onClick={() => { setShowEditor(true); setPreview(false); setEditingBlog(null); setForm(emptyForm); }}>
              <Plus className="w-4 h-4" /> New Post
            </Button>
          )}
        </div>
      </header>

      {/* Hero banner */}
      <section className="bg-primary/5 border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-8 sm:py-12">
          <h2 className="text-2xl sm:text-4xl font-bold text-foreground">Cirkle News</h2>
          <p className="text-sm sm:text-base text-muted-foreground mt-2 max-w-2xl">
            Useful ideas, opportunities and member stories from across Cirkle communities.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[220px] max-w-md">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search news, tags..."
                className="pl-9 h-11 rounded-xl bg-card border-border"
              />
            </div>
            <Button variant="outline" className="h-11 rounded-xl gap-1.5" onClick={() => setShowFilters((s) => !s)}>
              <Filter className="w-4 h-4" /> Filters
            </Button>
            {filtersActive && (
              <Button variant="ghost" className="h-11 rounded-xl" onClick={clearFilters}>Clear</Button>
            )}
          </div>

          {showFilters && (
            <div className="mt-4 bg-card border border-border rounded-2xl p-4 grid sm:grid-cols-2 gap-4 max-w-2xl">
              <div>
                <Label className="text-xs">From date</Label>
                <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-11 rounded-xl bg-secondary border-border mt-1" />
              </div>
              <div>
                <Label className="text-xs">To date</Label>
                <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-11 rounded-xl bg-secondary border-border mt-1" />
              </div>
              {allTags.length > 0 && (
                <div className="sm:col-span-2">
                  <Label className="text-xs">Tags</Label>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {allTags.map((t) => (
                      <button
                        key={t}
                        onClick={() => setActiveTag(activeTag === t ? null : t)}
                        className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${activeTag === t ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border hover:border-primary/40"}`}
                      >
                        #{t}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Category chips + admin view switch */}
      <div className="border-b border-border bg-card/60">
        <div className="max-w-5xl mx-auto px-4 py-3 flex gap-2 overflow-x-auto scrollbar-none">
          {isAdmin && (
            <>
              <button onClick={() => setAdminView("live")} className={`whitespace-nowrap text-xs font-semibold px-3.5 py-2 rounded-full border ${adminView === "live" ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground border-border"}`}>Live</button>
              <button onClick={() => setAdminView("drafts")} className={`whitespace-nowrap text-xs font-semibold px-3.5 py-2 rounded-full border ${adminView === "drafts" ? "bg-foreground text-background border-foreground" : "bg-card text-muted-foreground border-border"}`}>Drafts &amp; scheduled</button>
              <span className="w-px bg-border mx-1" />
            </>
          )}
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`whitespace-nowrap text-xs font-semibold px-3.5 py-2 rounded-full border transition-colors ${
                category === c ? "bg-primary text-primary-foreground border-primary" : "bg-card text-muted-foreground border-border hover:border-primary/40"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Editor Modal */}
      {showEditor && isAdmin && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-card w-full max-w-lg rounded-2xl border border-border p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-foreground">{editingBlog ? "Edit Post" : "New Post"}</h3>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setPreview((p) => !p)}>
                  {preview ? <><Pencil className="w-3.5 h-3.5" /> Edit</> : <><Eye className="w-3.5 h-3.5" /> Preview</>}
                </Button>
                <button onClick={() => { setShowEditor(false); setPreview(false); }} aria-label="Close editor"><X className="w-5 h-5 text-muted-foreground" /></button>
              </div>
            </div>

            {preview ? (
              <div className="space-y-3">
                {form.cover_image_url && <img src={form.cover_image_url} alt="" className="w-full rounded-xl border border-border object-cover max-h-52" />}
                <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">{form.category || "General"}</span>
                <h2 className="text-xl font-bold text-foreground leading-snug">{form.title || "Untitled post"}</h2>
                <p className="text-xs text-muted-foreground">{readTime(form.content || " ")} min read</p>
                <div className="text-[15px] leading-7 text-foreground whitespace-pre-wrap">{form.content}</div>
              </div>
            ) : (
              <div className="space-y-4">
                <div><Label>Title</Label><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Headline..." className="bg-secondary border-border h-11" /></div>
                <div><Label>Category</Label><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="General, Placements, Exams..." className="bg-secondary border-border h-11" /></div>
                <div><Label>Tags (comma separated)</Label><Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="placements, iitb, internships" className="bg-secondary border-border h-11" /></div>
                <div><Label>Cover Image URL (optional)</Label><Input value={form.cover_image_url} onChange={(e) => setForm({ ...form, cover_image_url: e.target.value })} placeholder="https://..." className="bg-secondary border-border h-11" /></div>
                <div><Label>Content</Label><Textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Write the story..." rows={10} className="bg-secondary border-border" /></div>
                <div>
                  <Label>Publish workflow</Label>
                  <div className="grid grid-cols-3 gap-2 mt-1.5">
                    {([
                      { key: "draft", label: "Draft", icon: FileText },
                      { key: "scheduled", label: "Schedule", icon: CalendarClock },
                      { key: "published", label: "Publish", icon: Send },
                    ] as const).map(({ key, label, icon: Icon }) => (
                      <button
                        key={key}
                        onClick={() => setForm({ ...form, status: key })}
                        className={`h-11 rounded-xl border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${form.status === key ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border"}`}
                      >
                        <Icon className="w-3.5 h-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                </div>
                {form.status === "scheduled" && (
                  <div>
                    <Label>Publish at</Label>
                    <Input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} className="bg-secondary border-border h-11" />
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 mt-5">
              <Button variant="outline" className="flex-1 h-11" onClick={() => { setShowEditor(false); setPreview(false); }}>Cancel</Button>
              <Button
                className="flex-1 h-11"
                onClick={() => saveBlog.mutate()}
                disabled={!form.title.trim() || !form.content.trim() || saveBlog.isPending || (form.status === "scheduled" && !form.scheduled_at)}
              >
                {editingBlog ? "Update" : form.status === "draft" ? "Save draft" : form.status === "scheduled" ? "Schedule" : "Publish"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6">
        {isLoading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="bg-card border border-border rounded-2xl overflow-hidden animate-pulse">
                <div className="h-40 bg-secondary" />
                <div className="p-4 space-y-2">
                  <div className="h-4 bg-secondary rounded w-3/4" />
                  <div className="h-3 bg-secondary rounded w-full" />
                  <div className="h-3 bg-secondary rounded w-2/3" />
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-16">
            <AlertCircle className="w-12 h-12 text-destructive/50 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">We could not load the news right now.</p>
            <Button variant="outline" onClick={() => refetch()}>Try again</Button>
          </div>
        ) : filtered.length ? (
          <>
            {/* Featured */}
            <button
              onClick={() => navigate(`/blogs/${slugify(featured.title, featured.id)}`)}
              className="w-full text-left grid md:grid-cols-2 gap-0 bg-card border border-border rounded-2xl overflow-hidden mb-8 hover:border-primary/40 transition-colors"
            >
              <div className="h-52 md:h-full bg-secondary">
                {featured.cover_image_url ? (
                  <img src={featured.cover_image_url} alt={featured.title} className="w-full h-full object-cover" loading="lazy" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center"><BookOpen className="w-10 h-10 text-muted-foreground/30" /></div>
                )}
              </div>
              <div className="p-5 sm:p-6 flex flex-col justify-center">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">{isLive(featured) ? "Featured" : featured.status === "scheduled" ? "Scheduled" : "Draft"}</span>
                  <span className="text-[10px] text-muted-foreground">{format(new Date(featured.created_at), "dd MMM yyyy")}</span>
                </div>
                <h3 className="text-xl font-bold text-foreground leading-snug mb-2">{featured.title}</h3>
                <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">{featured.content}</p>
                <span className="text-xs font-semibold text-primary mt-3">Read more -&gt;</span>
              </div>
            </button>

            <h2 className="text-base font-bold text-foreground mb-4">{adminView === "drafts" && isAdmin ? "Unpublished posts" : "Latest Posts"}</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {rest.map((blog: any) => {
                const author = blogAuthors?.[blog.author_id];
                return (
                  <article key={blog.id} className="bg-card border border-border rounded-2xl overflow-hidden flex flex-col hover:border-primary/40 transition-colors">
                    <button onClick={() => navigate(`/blogs/${slugify(blog.title, blog.id)}`)} className="text-left">
                      <div className="h-40 bg-secondary">
                        {blog.cover_image_url ? (
                          <img src={blog.cover_image_url} alt={blog.title} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><BookOpen className="w-8 h-8 text-muted-foreground/30" /></div>
                        )}
                      </div>
                      <div className="p-4">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full bg-primary/10 text-primary">{blog.category || "General"}</span>
                          {!isLive(blog) && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700">
                              {blog.status === "scheduled" ? `Scheduled ${blog.scheduled_at ? format(new Date(blog.scheduled_at), "dd MMM HH:mm") : ""}` : "Draft"}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">{formatDistanceToNow(new Date(blog.created_at), { addSuffix: true })}</span>
                        </div>
                        <h3 className="text-sm font-bold text-foreground leading-snug line-clamp-2 mb-1.5">{blog.title}</h3>
                        <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">{blog.content}</p>
                      </div>
                    </button>
                    <div className="mt-auto px-4 pb-4 space-y-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={() => navigate(`/blogs/author/${blog.author_id}`)} className="flex items-center gap-2 min-w-0 hover:text-primary transition-colors">
                          {author?.avatar_url ? (
                            <img src={author.avatar_url} className="w-6 h-6 rounded-full object-cover" alt="" />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                              <span className="text-[10px] font-bold text-primary">{(author?.name || "A")[0]}</span>
                            </div>
                          )}
                          <span className="text-xs text-muted-foreground truncate">{author?.name || "Cirkle Desk"}</span>
                        </button>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Clock className="w-3 h-3" />{readTime(blog.content)} min</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => (user ? toggleLike.mutate(blog.id) : navigate("/auth"))}
                          className={`h-8 px-2.5 rounded-full border text-[11px] font-semibold flex items-center gap-1.5 ${hasLiked(blog.id) ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary border-border text-muted-foreground"}`}
                          aria-label="Like article"
                        >
                          <Heart className={`w-3.5 h-3.5 ${hasLiked(blog.id) ? "fill-current" : ""}`} /> {likeCount(blog.id)}
                        </button>
                        <button
                          onClick={() => (user ? toggleBookmark.mutate(blog.id) : navigate("/auth"))}
                          className={`h-8 px-2.5 rounded-full border text-[11px] font-semibold flex items-center gap-1.5 ${hasBookmarked(blog.id) ? "bg-primary/10 border-primary/40 text-primary" : "bg-secondary border-border text-muted-foreground"}`}
                          aria-label="Save article"
                        >
                          <Bookmark className={`w-3.5 h-3.5 ${hasBookmarked(blog.id) ? "fill-current" : ""}`} />
                        </button>
                        {isAdmin && (
                          <div className="flex gap-1 ml-auto">
                            {!isLive(blog) && (
                              <button onClick={() => publishNow.mutate(blog.id)} className="p-1.5 text-muted-foreground hover:text-primary rounded-lg" aria-label="Publish now"><Send className="w-3.5 h-3.5" /></button>
                            )}
                            <button onClick={() => openEdit(blog)} className="p-1.5 text-muted-foreground hover:text-primary rounded-lg" aria-label="Edit post"><Pencil className="w-3.5 h-3.5" /></button>
                            <button onClick={() => deleteBlog.mutate(blog.id)} className="p-1.5 text-muted-foreground hover:text-destructive rounded-lg" aria-label="Delete post"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-center py-16">
            <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              {filtersActive ? "No posts match these filters." : adminView === "drafts" ? "No drafts or scheduled posts." : "No posts published yet."}
            </p>
            {filtersActive && <Button variant="outline" className="mt-4" onClick={clearFilters}>Clear filters</Button>}
          </div>
        )}
      </main>
    </div>
  );
};

export default Blogs;
