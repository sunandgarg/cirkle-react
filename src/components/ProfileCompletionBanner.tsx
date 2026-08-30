import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, CheckCircle2, X } from "lucide-react";
import { getProfileCompletion, nextProfileReminder } from "@/lib/profileCompletion";

type ReminderState = { dismissals: number; nextAt: number | null };

const readReminder = (key: string): ReminderState => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) || "null") as ReminderState | null;
    return parsed && typeof parsed.dismissals === "number" ? parsed : { dismissals: 0, nextAt: null };
  } catch {
    return { dismissals: 0, nextAt: null };
  }
};

const ProfileCompletionBanner = ({ userId, profile }: { userId: string; profile: Record<string, unknown> }) => {
  const navigate = useNavigate();
  const storageKey = `cirkle:profile-reminder:${userId}`;
  const completion = useMemo(() => getProfileCompletion(profile), [profile]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (completion.percent === 100) {
      sessionStorage.removeItem(storageKey);
      setVisible(false);
      return;
    }
    const state = readReminder(storageKey);
    if (state.dismissals >= 2) {
      setVisible(false);
      return;
    }
    const delay = Math.max(0, (state.nextAt || 0) - Date.now());
    if (delay === 0) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), delay);
    return () => window.clearTimeout(timer);
  }, [completion.percent, storageKey]);

  if (!visible || completion.percent === 100) return null;

  const missing = completion.missing.slice(0, 2).map((item) => item.label).join(" and ");
  return (
    <aside className="relative z-40 border-b border-primary/20 bg-gradient-to-r from-primary via-primary to-blue-600 px-3 py-2.5 text-primary-foreground shadow-sm sm:px-5" aria-label="Profile completion reminder">
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-[11px] font-black ring-2 ring-white/30">
          {completion.percent}%
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold">Complete your profile</p>
          <p className="truncate text-[11px] text-white/80">Add {missing} to help trusted members discover you.</p>
        </div>
        <button onClick={() => navigate("/profile")} className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-white px-3 text-xs font-bold text-primary shadow-sm transition-transform active:scale-95">
          Complete <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label="Dismiss profile reminder"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/15 hover:text-white"
          onClick={() => {
            const current = readReminder(storageKey);
            const next = nextProfileReminder(current.dismissals, Date.now());
            sessionStorage.setItem(storageKey, JSON.stringify(next));
            setVisible(false);
            if (next.nextAt) window.setTimeout(() => setVisible(true), Math.max(0, next.nextAt - Date.now()));
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
        <div className="h-full bg-white" style={{ width: `${completion.percent}%` }} />
      </div>
    </aside>
  );
};

export default ProfileCompletionBanner;
