import { useState, useCallback, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Search, X, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface GifResult {
  id: string;
  slug: string;
  title: string;
  url: string;
  preview: string;
  width: number;
  height: number;
}

interface GifPickerProps {
  onSelect: (gifUrl: string) => void;
  onEmojiSelect: (emoji: string) => void;
  onClose: () => void;
}

const EMOJI_GROUPS = [
  { label: "Recent", items: ["❤️", "😂", "👍", "🔥", "🙏", "🎉", "😍", "😭"] },
  { label: "Smileys", items: ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😊", "🙂", "😉", "😌", "🥰", "😘", "😎", "🤩", "🥳"] },
  { label: "People", items: ["👋", "🤝", "👏", "🙌", "👌", "✌️", "🤞", "💪", "🫶", "🧠", "👀", "💯"] },
  { label: "Things", items: ["🚀", "✨", "⚡", "💡", "📌", "✅", "❌", "🎓", "💼", "📊", "📷", "🎤"] },
];

const GifPicker = ({ onSelect, onEmojiSelect, onClose }: GifPickerProps) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [activeTab, setActiveTab] = useState<"emoji" | "gifs">("emoji");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const requestIdRef = useRef(0);

  const searchGifs = useCallback(async (q: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setErrorMessage("");
    try {
      const { data, error } = await supabase.functions.invoke("klipy-search", {
        body: { q, type: "gifs", limit: 20 },
      });
      if (error) throw error;
      if (requestId !== requestIdRef.current) return;
      setResults(data?.results || []);
      setHasSearched(true);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setResults([]);
      setHasSearched(true);
      setErrorMessage("GIFs are temporarily unavailable. Please try again.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  const registerShare = useCallback((slug: string) => {
    if (!slug) return;
    void supabase.functions
      .invoke("klipy-search", { body: { action: "share", type: "gifs", slug } })
      .catch(() => undefined);
  }, []);

  // Load trending on mount and tab change
  useEffect(() => {
    if (activeTab === "gifs") searchGifs("");
  }, [searchGifs, activeTab]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => searchGifs(value), 350);
  };

  return (
    <div className="bg-card border border-border rounded-xl shadow-xl overflow-hidden animate-fade-in w-full max-w-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-0">
          <button
            onClick={() => {
              requestIdRef.current += 1;
              setLoading(false);
              setActiveTab("emoji");
              setQuery("");
            }}
            className={`min-h-9 px-4 py-1 text-xs font-semibold rounded-full transition-colors ${activeTab === "emoji" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Emoji
          </button>
          <button
            onClick={() => { setActiveTab("gifs"); setQuery(""); }}
            className={`min-h-9 px-4 py-1 text-xs font-semibold rounded-full transition-colors ${activeTab === "gifs" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            GIFs
          </button>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>
      {activeTab === "gifs" && <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search KLIPY"
            aria-label="Search KLIPY GIFs"
            className="h-8 pl-8 text-xs bg-secondary border-border rounded-lg"
          />
        </div>
      </div>}
      {activeTab === "emoji" ? (
        <div className="max-h-64 overflow-y-auto px-3 py-2">
          {EMOJI_GROUPS.map((group) => (
            <section key={group.label} className="mb-2">
              <p className="px-1 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{group.label}</p>
              <div className="grid grid-cols-8 gap-0.5">
                {group.items.map((emoji) => (
                  <button key={`${group.label}-${emoji}`} type="button" onClick={() => onEmojiSelect(emoji)}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-xl hover:bg-accent active:scale-90"
                    aria-label={`Insert ${emoji}`}>{emoji}</button>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : <div className="grid grid-cols-2 gap-1 px-2 pb-2 max-h-60 overflow-y-auto">
        {loading && (
          <div className="col-span-2 flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && results.map((gif) => (
          <button
            key={gif.id}
            onClick={() => { registerShare(gif.slug); onSelect(gif.url); }}
            className="rounded-lg overflow-hidden hover:ring-2 hover:ring-primary transition-all"
          >
            <img
              src={gif.preview}
              alt={gif.title}
              className="w-full h-24 object-cover"
              loading="lazy"
            />
          </button>
        ))}
        {!loading && hasSearched && results.length === 0 && (
          <div className="col-span-2 py-6 text-center text-xs text-muted-foreground">
            {errorMessage || "No GIFs found"}
          </div>
        )}
      </div>}
      {activeTab === "gifs" && <div className="px-3 py-1 border-t border-border">
        <p className="text-[9px] text-muted-foreground text-right">Powered by KLIPY</p>
      </div>}
    </div>
  );
};

export default GifPicker;
