import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { ArrowLeft, BookOpen, Clock, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { format, formatDistanceToNow } from "date-fns";
import { isBlogLive } from "@/lib/blogVisibility";

const db = supabase as any;

const slugify = (title: string, id: string) =>
  `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}-${id.slice(0, 8)}`;

const readTime = (content: string) => Math.max(1, Math.round(content.trim().split(/\s+/).length / 200));

const BlogAuthor = () => {
  const { authorId } = useParams();
  const navigate = useNavigate();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["blog-author-page", authorId],
    queryFn: async () => {
      const [{ data: profile }, { data: posts, error }] = await Promise.all([
        supabase.from("profiles").select("user_id, name, avatar_url, headline, bio, cover_photo_url").eq("user_id", authorId!).maybeSingle(),
        db.from("blogs").select("*").eq("author_id", authorId!).eq("published", true).order("created_at", { ascending: false }),
      ]);
      if (error) throw error;
      return { profile, posts: ((posts ?? []) as any[]).filter((post) => isBlogLive(post)) };
    },
    enabled: !!authorId,
  });

  if (isLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (isError) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">Could not load this author.</p>
        <Button variant="outline" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const profile = data?.profile as any;
  const posts = data?.posts ?? [];

  return (
    <div className="bg-background min-h-screen pb-24">
      <header className="sticky top-0 z-40 bg-card/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="flex items-center gap-3 max-w-5xl mx-auto">
          <button onClick={() => navigate("/blogs")} className="p-1 text-foreground" aria-label="Back to news"><ArrowLeft className="w-5 h-5" /></button>
          <h1 className="text-base font-bold text-foreground truncate">Author</h1>
        </div>
      </header>

      <section className="bg-primary/5 border-b border-border">
        <div className="max-w-5xl mx-auto px-4 py-8 flex items-center gap-4">
          {profile?.avatar_url ? (
            <img src={profile.avatar_url} alt={profile?.name || "Author"} className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover border border-border" />
          ) : (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-xl font-bold text-primary">{(profile?.name || "C")[0]}</span>
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold text-foreground truncate">{profile?.name || "Cirkle Desk"}</h2>
            {profile?.headline && <p className="text-sm text-muted-foreground mt-0.5">{profile.headline}</p>}
            <p className="text-xs text-muted-foreground mt-1">{posts.length} {posts.length === 1 ? "article" : "articles"}</p>
          </div>
        </div>
        {profile?.bio && (
          <div className="max-w-5xl mx-auto px-4 pb-6">
            <p className="text-sm text-muted-foreground leading-6 max-w-3xl">{profile.bio}</p>
          </div>
        )}
      </section>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <h3 className="text-base font-bold text-foreground mb-4">Latest articles</h3>
        {posts.length ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {posts.map((b: any) => (
              <button key={b.id} onClick={() => navigate(`/blogs/${slugify(b.title, b.id)}`)} className="text-left bg-card border border-border rounded-2xl overflow-hidden hover:border-primary/40 transition-colors">
                <div className="h-36 bg-secondary">
                  {b.cover_image_url ? (
                    <img src={b.cover_image_url} alt={b.title} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><BookOpen className="w-8 h-8 text-muted-foreground/30" /></div>
                  )}
                </div>
                <div className="p-4">
                  <h4 className="text-sm font-bold text-foreground line-clamp-2">{b.title}</h4>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" />{format(new Date(b.created_at), "dd MMM yyyy")}</span>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{readTime(b.content)} min</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">{formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}</p>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-center py-16">
            <BookOpen className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">This author has not published anything yet.</p>
          </div>
        )}
      </main>
    </div>
  );
};

export default BlogAuthor;
