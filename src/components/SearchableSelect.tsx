import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ChevronDown, Check, Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchableSelectProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  allowOther?: boolean;
  className?: string;
}

export const SEARCHABLE_SELECT_RESULT_LIMIT = 80;

export const rankSearchableOptions = (
  options: string[],
  query: string,
  limit = SEARCHABLE_SELECT_RESULT_LIMIT,
) => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) {
    return {
      options: options.slice(0, Math.max(1, limit)),
      totalMatches: options.length,
    };
  }
  const prefixes: string[] = [];
  const contains: string[] = [];

  for (const option of options) {
    const normalized = option.toLocaleLowerCase();
    if (normalized.startsWith(needle)) prefixes.push(option);
    else if (normalized.includes(needle)) contains.push(option);
  }

  const totalMatches = prefixes.length + contains.length;
  return {
    options: [...prefixes, ...contains].slice(0, Math.max(1, limit)),
    totalMatches,
  };
};

const SearchableSelect = ({ options, value, onChange, placeholder = "Select...", allowOther = true, className }: SearchableSelectProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isOther, setIsOther] = useState(false);
  const [otherValue, setOtherValue] = useState("");
  const deferredSearch = useDeferredValue(search);
  const ranked = useMemo(
    () => rankSearchableOptions(options, deferredSearch),
    [deferredSearch, options],
  );
  const hiddenResultCount = Math.max(0, ranked.totalMatches - ranked.options.length);

  useEffect(() => { if (open) setSearch(""); }, [open]);

  // Check if current value is a custom "other" value
  useEffect(() => {
    if (value && !options.includes(value)) {
      setIsOther(true);
      setOtherValue(value);
    }
  }, [value, options]);

  const handleSelect = (opt: string) => {
    onChange(opt);
    setIsOther(false);
    setOpen(false);
  };

  const handleOther = () => {
    const customValue = search.trim();
    setIsOther(true);
    setOtherValue(customValue);
    if (customValue) onChange(customValue);
    setOpen(false);
  };

  if (isOther) {
    return (
      <div className="flex gap-2">
        <Input
          value={otherValue}
          onChange={e => { setOtherValue(e.target.value); onChange(e.target.value); }}
          placeholder="Type custom value..."
          className={cn("bg-secondary border-border flex-1", className)}
        />
        <button
          type="button"
          onClick={() => { setIsOther(false); setOtherValue(""); onChange(""); }}
          className="text-xs text-muted-foreground hover:text-foreground px-2"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-12 w-full items-center justify-between rounded-xl border border-input bg-secondary px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
            !value && "text-muted-foreground",
            className
          )}
        >
          <span className="truncate">{value || placeholder}</span>
          <ChevronDown className="w-4 h-4 opacity-50 flex-shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="z-[100] w-[min(var(--radix-popover-trigger-width),calc(100vw-24px))] overflow-hidden rounded-2xl border-border p-0 shadow-2xl" align="start" sideOffset={6} collisionPadding={12}>
        <div className="p-2 border-b border-border">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              className="h-11 rounded-xl border-border bg-background pl-8 text-[16px]"
            />
          </div>
        </div>
        <div className="max-h-[min(42vh,320px)] overflow-y-auto overscroll-contain p-1" role="listbox">
          {ranked.totalMatches === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">No results</p>
          )}
          {ranked.options.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => handleSelect(opt)}
              role="option"
              aria-selected={value === opt}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                value === opt && "bg-accent font-medium"
              )}
            >
              {value === opt && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
              <span className={value === opt ? "" : "pl-5"}>{opt}</span>
            </button>
          ))}
          {hiddenResultCount > 0 && (
            <p className="px-3 py-2 text-center text-[11px] text-muted-foreground" aria-live="polite">
              {hiddenResultCount.toLocaleString()} more matches — type to narrow the list
            </p>
          )}
          {allowOther && (
            <button
              type="button"
              onClick={handleOther}
              className="mt-1 flex min-h-11 w-full items-center gap-2 border-t border-border px-3 py-2 pt-2 text-left text-sm font-medium text-primary transition-colors hover:bg-accent"
            >
              <span className="min-w-0 truncate pl-5">{search.trim() ? `Use “${search.trim()}”` : "+ Other (custom)"}</span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SearchableSelect;
