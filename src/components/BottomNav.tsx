import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Users, Waypoints, Briefcase, Calendar } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import cirkLogo from "@/assets/cirkle-logo.png";

const DEFAULT_ICONS: Record<string, any> = {
  forum: null,
  network: Users,
  consult: Waypoints,
  jobs: Briefcase,
  calendar: Calendar,
};

// Bottom nav - Forum first, Events added
const ALL_TABS = [
  { path: "/cirkle-forum", key: "forum", fallbackLabel: "Forum", isLogo: true },
  { path: "/consult", key: "consult", fallbackLabel: "Consult", isLogo: false },
  { path: "/jobs", key: "jobs", fallbackLabel: "Jobs", isLogo: false },
  { path: "/calendar", key: "calendar", fallbackLabel: "Events", isLogo: false },
];

const BottomNav = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement && Boolean(target.closest("input, textarea, [contenteditable='true']"));

    const updateFromViewport = () => {
      if (!viewport) return;
      const keyboardHeight = window.innerHeight - viewport.height - viewport.offsetTop;
      setKeyboardOpen(keyboardHeight > 120 || isEditable(document.activeElement));
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (isEditable(event.target)) setKeyboardOpen(true);
    };
    const handleFocusOut = () => {
      window.setTimeout(() => {
        if (!isEditable(document.activeElement)) updateFromViewport();
      }, 80);
    };

    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    viewport?.addEventListener("resize", updateFromViewport);
    viewport?.addEventListener("scroll", updateFromViewport);
    return () => {
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      viewport?.removeEventListener("resize", updateFromViewport);
      viewport?.removeEventListener("scroll", updateFromViewport);
    };
  }, []);

  const { data: navConfig } = useQuery({
    queryKey: ["nav-config"],
    queryFn: async () => {
      const { data } = await supabase.from("nav_config").select("*");
      const map: Record<string, any> = {};
      (data as any[])?.forEach((c: any) => { map[c.tab_key] = c; });
      return map;
    },
    staleTime: Infinity,
  });

  return (
    <nav
      className={`z-50 safe-bottom lg:hidden overflow-hidden transition-[max-height,opacity,transform] duration-150 ${keyboardOpen ? "max-h-0 translate-y-2 opacity-0 pointer-events-none" : "max-h-20 translate-y-0 opacity-100"}`}
      role="navigation"
      aria-label="Main navigation"
      aria-hidden={keyboardOpen}
    >
      <div className="relative max-w-lg mx-auto">
        <div className="bg-card border-t border-border">
          <div className="flex items-center justify-around py-1.5 pb-2">
            {ALL_TABS.map(({ path, key, fallbackLabel, isLogo }) => {
              const isActive = location.pathname === path || location.pathname.startsWith(path + "/");
              const config = navConfig?.[key];
              const label = config?.label || fallbackLabel;
              const iconUrl = config?.icon_url;
              const Icon = DEFAULT_ICONS[key];

              return (
                <button
                  key={path}
                  onClick={() => navigate(path)}
                  aria-label={label}
                  aria-current={isActive ? "page" : undefined}
                  className={`relative flex flex-col items-center gap-0.5 flex-1 pt-1.5 pb-0.5 transition-colors ${
                    isActive ? "" : "opacity-45"
                  }`}
                >
                  {iconUrl ? (
                    <img src={iconUrl} alt={label} className="w-5 h-5 object-contain" />
                  ) : isLogo ? (
                    <img src={cirkLogo} alt="Cirkle" className={`w-5 h-5 object-contain rounded ${isActive ? "" : "grayscale"}`} />
                  ) : Icon ? (
                    <Icon className={`w-5 h-5 ${isActive ? "text-primary" : "text-foreground"}`} strokeWidth={isActive ? 2 : 1.5} />
                  ) : null}
                  <span className={`text-[10px] leading-none ${
                    isActive ? "font-semibold text-primary" : "font-medium text-foreground"
                  }`}>
                    {label}
                  </span>
                  {isActive && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-5 h-[2px] bg-primary rounded-full" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
};

export default BottomNav;
