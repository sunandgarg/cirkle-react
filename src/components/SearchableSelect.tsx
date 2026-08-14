import { useState, useEffect } from "react";
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

const SearchableSelect = ({ options, value, onChange, placeholder = "Select...", allowOther = true, className }: SearchableSelectProps) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isOther, setIsOther] = useState(false);
  const [otherValue, setOtherValue] = useState("");

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options;

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
    setIsOther(true);
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
        <div className="max-h-[200px] overflow-y-auto p-1">
          {filtered.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-3">No results</p>
          )}
          {filtered.map(opt => (
            <button
              key={opt}
              type="button"
              onClick={() => handleSelect(opt)}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                value === opt && "bg-accent font-medium"
              )}
            >
              {value === opt && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
              <span className={value === opt ? "" : "pl-5"}>{opt}</span>
            </button>
          ))}
          {allowOther && (
            <button
              type="button"
              onClick={handleOther}
              className="mt-1 flex min-h-11 w-full items-center gap-2 border-t border-border px-3 py-2 pt-2 text-left text-sm font-medium text-primary transition-colors hover:bg-accent"
            >
              <span className="pl-5">+ Other (custom)</span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default SearchableSelect;
