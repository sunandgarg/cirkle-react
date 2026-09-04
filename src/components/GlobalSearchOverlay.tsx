import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Search, X, User, Briefcase, Calendar, MessageSquare, LoaderCircle } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { purgeLegacyRecentSearches, readRecentSearches, saveRecentSearch } from "@/lib/recentSearches";

interface SearchResult {
  id: string;
  type: "post" | "user" | "job" | "event";
  title: string;
  subtitle?: string;
  scopeType?: string;
  scopeKey?: string;
}

interface GlobalSearchOverlayProps {
  open: boolean;
  onClose: () => void;
  onSelect?: (result: SearchResult) => void;
}

const TYPE_ICONS: Record<string, any> = {
  post: MessageSquare,
  user: User,
  job: Briefcase,
  event: Calendar,
};

const TYPE_LABELS: Record<string, string> = {
  post: "Posts",
  user: "People",
  job: "Jobs",
  event: "Events",
};

export const GlobalSearchOverlay = ({ open, onClose, onSelect }: GlobalSearchOverlayProps) => {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    purgeLegacyRecentSearches();
    setRecentSearches(readRecentSearches(user?.id));
  }, [user?.id]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      setQuery("");
      setResults([]);
      setError(null);
    }
  }, [open]);

  // Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        if (open) onClose();
      }
      if (e.key === "Escape" && open) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const saveSearch = useCallback((term: string) => {
    setRecentSearches(saveRecentSearch(user?.id, term));
  }, [user?.id]);

  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      const pattern = `%${term}%`;
      try {
        const [profiles, jobs, posts, events] = await Promise.all([
          supabase.from("profiles").select("user_id, name, headline, avatar_url").or(`name.ilike.${pattern},headline.ilike.${pattern}`).limit(5),
          supabase.from("jobs").select("id, title, company, location").or(`title.ilike.${pattern},company.ilike.${pattern}`).limit(5),
          supabase.from("posts").select("id, content, scope_type, scope_key").is("reply_to_id", null).ilike("content", pattern).limit(5),
          supabase.from("events").select("id, title, location, start_time").ilike("title", pattern).limit(5),
        ]);
        if (controller.signal.aborted) return;
        const firstError = profiles.error || jobs.error || posts.error || events.error;
        if (firstError) throw firstError;
        setResults([
          ...(profiles.data ?? []).map((item: any) => ({ id: item.user_id, type: "user" as const, title: item.name || "Member", subtitle: item.headline || "Community member" })),
          ...(jobs.data ?? []).map((item: any) => ({ id: item.id, type: "job" as const, title: item.title || "Job", subtitle: [item.company, item.location].filter(Boolean).join(" · ") })),
          ...(posts.data ?? []).map((item: any) => ({
            id: item.id,
            type: "post" as const,
            title: String(item.content || "Post").slice(0, 90),
            subtitle: "Forum post",
            scopeType: item.scope_type,
            scopeKey: item.scope_key,
          })),
          ...(events.data ?? []).map((item: any) => ({ id: item.id, type: "event" as const, title: item.title || "Event", subtitle: item.location || "Community event" })),
        ]);
        setActiveIndex(0);
      } catch (searchError) {
        if (controller.signal.aborted) return;
        setResults([]);
        setError(searchError instanceof Error ? searchError.message : "Search is temporarily unavailable");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const selectResult = useCallback((result: SearchResult) => {
    saveSearch(query.trim());
    onSelect?.(result);
    onClose();
    if (onSelect) return;
    if (result.type === "user") navigate(`/profile/${result.id}`);
    else if (result.type === "job") navigate(`/jobs?job=${encodeURIComponent(result.id)}`);
    else if (result.type === "event") navigate(`/calendar?event=${encodeURIComponent(result.id)}`);
    else {
      const params = new URLSearchParams({ post: result.id });
      if (result.scopeType) params.set("scope_type", result.scopeType);
      if (result.scopeKey) params.set("scope_key", result.scopeKey);
      navigate(`/cirkle-forum?${params.toString()}`);
    }
  }, [navigate, onClose, onSelect, query, saveSearch]);

  const groupedResults = useMemo(() => {
    return Object.entries(
      results.reduce<Record<string, SearchResult[]>>((groups, result) => {
        (groups[result.type] ||= []).push(result);
        return groups;
      }, {}),
    );
  }, [results]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh]" role="dialog" aria-modal="true" aria-label="Search">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg mx-4 bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-scale-in">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <Search className="w-5 h-5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && results.length) {
                e.preventDefault();
                setActiveIndex((index) => (index + 1) % results.length);
              } else if (e.key === "ArrowUp" && results.length) {
                e.preventDefault();
                setActiveIndex((index) => (index - 1 + results.length) % results.length);
              } else if (e.key === "Enter" && results[activeIndex]) {
                e.preventDefault();
                selectResult(results[activeIndex]);
              } else if (e.key === "Enter" && query.trim()) saveSearch(query.trim());
            }}
            placeholder="Search posts, people, jobs, events…"
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            autoComplete="off"
          />
          <kbd className="hidden sm:inline-flex text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded border border-border font-mono">
            ESC
          </kbd>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-accent touch-target" aria-label="Close search">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Results / empty state */}
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {!query.trim() ? (
            <div className="p-4">
              {recentSearches.length > 0 && (
                <>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Recent</p>
                  {recentSearches.map((term, i) => (
                    <button
                      key={i}
                      onClick={() => setQuery(term)}
                      className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors"
                    >
                      {term}
                    </button>
                  ))}
                </>
              )}
              {recentSearches.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Start typing to search across all content
                </p>
              )}
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" aria-live="polite">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Searching…
            </div>
          ) : error ? (
            <p className="px-4 py-10 text-center text-sm text-destructive" role="alert">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">No matching people, posts, jobs, or events.</p>
          ) : (
            <div className="p-2">
              {groupedResults.map(([type, items]) => (
                <section key={type} className="mb-2 last:mb-0" aria-label={TYPE_LABELS[type]}>
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{TYPE_LABELS[type]}</p>
                  {items.map((result) => {
                    const Icon = TYPE_ICONS[result.type];
                    const resultIndex = results.indexOf(result);
                    return (
                      <button
                        key={`${result.type}-${result.id}`}
                        type="button"
                        onMouseEnter={() => setActiveIndex(resultIndex)}
                        onClick={() => selectResult(result)}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${activeIndex === resultIndex ? "bg-accent" : "hover:bg-accent/70"}`}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{result.title}</span>
                          {result.subtitle && <span className="block truncate text-xs text-muted-foreground">{result.subtitle}</span>}
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-border flex items-center gap-4 text-[10px] text-muted-foreground">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>⌘K Toggle</span>
        </div>
      </div>
    </div>
  );
};

export default GlobalSearchOverlay;
