import { useEffect, useState } from "react";
import { Cookie } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { acceptCookieConsent, hasCookieConsent } from "@/lib/cookieConsent";

const CookieConsentBar = () => {
  const { user, profile, profileResolved } = useAuth();
  const eligible = !!user && profileResolved && !!profile?.is_verified && !!profile?.onboarding_completed;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(eligible && !hasCookieConsent());
  }, [eligible, user?.id]);

  if (!visible) return null;

  const accept = () => {
    acceptCookieConsent();
    setVisible(false);
    // Persistent storage protects the offline chat outbox/cache from routine
    // browser eviction where the platform supports it.
    void navigator.storage?.persist?.().catch(() => false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      className="fixed inset-x-0 top-0 z-[120] border-b border-border bg-card px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 shadow-lg lg:top-auto lg:bottom-0 lg:border-t lg:border-b-0 lg:py-2"
    >
      <div className="mx-auto flex max-w-5xl items-center gap-2.5 sm:gap-3">
        <Cookie className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground sm:text-xs">
          Cirkle uses required cookies and browser storage to keep you signed in, remember preferences, and load chats faster.
        </p>
        <button
          type="button"
          onClick={accept}
          className="h-9 shrink-0 rounded-full bg-primary px-5 text-xs font-bold text-primary-foreground shadow-sm transition-transform active:scale-95"
        >
          OK
        </button>
      </div>
    </div>
  );
};

export default CookieConsentBar;
