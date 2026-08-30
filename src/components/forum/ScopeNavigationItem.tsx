import { useState } from "react";
import { ChevronDown, Hash } from "lucide-react";
import type { ForumScope } from "@/lib/forumScopes";

interface ScopeNavigationItemProps {
  scope: ForumScope;
  activeScope: { type: string; key: string };
  unreadDots: Record<string, boolean>;
  onSelect: (type: string, key: string) => void;
  onToggle: (scopeId: string, index: number) => void;
}

const ScopeNavigationItem = ({ scope, activeScope, unreadDots, onSelect, onToggle }: ScopeNavigationItemProps) => {
  const [expanded, setExpanded] = useState(false);
  const options = scope.hasToggle ? scope.toggleOptions : undefined;
  const activeOptionIndex = options?.findIndex(
    (option) => option.type === activeScope.type && option.key === activeScope.key,
  ) ?? -1;
  const activeOption = activeOptionIndex >= 0 ? options?.[activeOptionIndex] : undefined;
  const isActive = activeOptionIndex >= 0 || (activeScope.type === scope.type && activeScope.key === scope.key);
  const hasUnread = options?.length
    ? options.some((option) => unreadDots[`${option.type}_${option.key}`])
    : unreadDots[`${scope.type}_${scope.key}`];
  const showOptions = !!options?.length && (expanded || isActive);

  const handleScopeClick = () => {
    if (options?.length) {
      // Grouped channels are folders. Changing chat requires an explicit room
      // choice, which also keeps the mobile sidebar open at this stage.
      setExpanded((current) => !current);
      return;
    }
    onSelect(scope.type, scope.key);
  };

  return (
    <div className={`mx-2 rounded-md transition-all ${isActive ? "border-l-[3px] border-primary bg-primary/8" : ""}`}>
      <button
        type="button"
        onClick={handleScopeClick}
        aria-expanded={options?.length ? showOptions : undefined}
        className={`flex w-full items-start gap-2.5 rounded-md px-3 py-2.5 text-[14px] transition-all ${isActive ? "font-semibold text-primary" : "text-foreground hover:bg-accent/60"}`}
      >
        <Hash className={`mt-0.5 h-4 w-4 shrink-0 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
        <div className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5 truncate">
            {(isActive && activeOption?.scopeLabel) || scope.label}
            {hasUnread && !isActive && <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-primary" />}
          </span>
          {((isActive && activeOption?.subtitle) || scope.subtitle) && (
            <span className="mt-0.5 block truncate text-[11px] font-normal text-muted-foreground">
              {(isActive && activeOption?.subtitle) || scope.subtitle}
            </span>
          )}
        </div>
        {!!options?.length && (
          <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showOptions ? "rotate-180" : ""}`} />
        )}
      </button>

      {showOptions && options && (
        <div className="px-4 pb-3 pl-9 pt-0" role="group" aria-label={`Choose ${scope.label} room`}>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Choose a room</p>
          <div className="flex items-center gap-1.5">
            {options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggle(scope.id, index);
                }}
                aria-current={activeOptionIndex === index ? "page" : undefined}
                className={`min-h-8 flex-1 rounded-lg px-3 py-1 text-[11px] font-semibold transition-colors ${activeOptionIndex === index ? "bg-primary text-primary-foreground" : "bg-accent text-muted-foreground hover:text-foreground"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default ScopeNavigationItem;
