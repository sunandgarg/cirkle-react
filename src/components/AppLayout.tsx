import { Outlet, useLocation, Navigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import BottomNav from "./BottomNav";
import AppHeader from "./AppHeader";
import DesktopSidebar from "./DesktopSidebar";
import { useAuth } from "@/hooks/useAuth";
import { usePrefetch } from "@/hooks/usePrefetch";
import LockedModeOverlay from "./LockedModeOverlay";
import { ErrorBoundary } from "./ErrorBoundary";
import GlobalSearchOverlay from "./GlobalSearchOverlay";
import ProfileCompletionBanner from "./ProfileCompletionBanner";
import { supabase } from "@/integrations/supabase/client";
import { shouldShowProfileCompletion } from "@/lib/profileCompletion";
import { useVisualViewportFrame } from "@/hooks/useVisualViewportHeight";
import {
  COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS,
  PageChromeRequestProvider,
  useRouteScopedPageChrome,
} from "@/contexts/PageChromeContext";

const AppLayout = () => {
  const { user, profile, isVerified, profileResolved } = useAuth();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const visualViewport = useVisualViewportFrame();
  const isForum = location.pathname.startsWith("/cirkle-forum");
  const routeChrome = useRouteScopedPageChrome(location.pathname);
  const sharedTopChromeRef = useRef<HTMLDivElement>(null);
  const showProfileCompletion = shouldShowProfileCompletion(location.pathname);

  useEffect(() => {
    if (sharedTopChromeRef.current) sharedTopChromeRef.current.inert = routeChrome.collapsed;
  }, [routeChrome.collapsed]);

  // Prefetch all critical data on login
  usePrefetch(user?.id, profile);

  // Cmd+K global search shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Count first-party activity without third-party tracking or exposing raw
  // account data. A browser-tab session is counted once; route views roll up
  // into the owner-only daily dashboard.
  useEffect(() => {
    if (!user?.id || !profileResolved) return;
    const key = `cirkle:activity-session:${user.id}`;
    let sessionId = sessionStorage.getItem(key);
    if (!sessionId) {
      sessionId = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, sessionId);
    }
    void (supabase as any).rpc("record_user_activity", {
      p_session_id: sessionId,
      p_path: `${location.pathname}${location.search}`,
    }).then(({ error }: { error?: { message?: string } | null }) => {
      if (error) console.warn("Activity tracking unavailable", error.message);
    });
  }, [location.pathname, location.search, profileResolved, user?.id]);

  // Block unverified users on all pages except settings/profile/iit-verify
  const allowedUnverified = ["/settings", "/profile", "/iit-verify"];
  const isProtectedPage = !allowedUnverified.some(p => location.pathname.startsWith(p));
  const showLockedOverlay = profileResolved && user && !isVerified && isProtectedPage;
  const sharedTopContent = (
    <>
      <AppHeader />
      {user && profile && isVerified && showProfileCompletion && (
        <ProfileCompletionBanner userId={user.id} profile={profile as unknown as Record<string, unknown>} />
      )}
    </>
  );

  // Show loading while profile is being fetched to prevent flash
  if (!profileResolved && user) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-x-0 bg-background flex w-full overflow-hidden"
      data-testid="app-viewport-shell"
      style={{ top: `${visualViewport.offsetTop}px`, height: `${visualViewport.height}px` }}
    >
      <DesktopSidebar />
      <div className="flex-1 flex flex-col min-w-0 max-w-full overflow-hidden">
        {!isForum && (routeChrome.eligible ? (
          <div
            ref={sharedTopChromeRef}
            aria-hidden={routeChrome.collapsed || undefined}
            data-testid="shared-top-page-chrome"
            className={`shrink-0 ${COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS} transition-[max-height,opacity,transform] duration-200 ease-out motion-reduce:transition-none lg:max-h-none lg:translate-y-0 lg:opacity-100 ${
              routeChrome.collapsed
                ? "pointer-events-none max-h-0 -translate-y-2 overflow-hidden opacity-0"
                : "max-h-56 translate-y-0 overflow-visible opacity-100"
            }`}
          >
            {sharedTopContent}
          </div>
        ) : sharedTopContent)}
        <main
          id="main-content"
          className={`flex-1 min-h-0 ${isForum || routeChrome.eligible ? "overflow-hidden" : "app-scroll-region"}`}
        >
          <PageChromeRequestProvider requestCollapsed={routeChrome.requestCollapsed}>
            <ErrorBoundary>
              <Outlet />
            </ErrorBoundary>
          </PageChromeRequestProvider>
        </main>
        {!isForum && <BottomNav collapsed={routeChrome.collapsed} collapseWithPage={routeChrome.eligible} />}
        {showLockedOverlay && <LockedModeOverlay />}
      </div>
      <GlobalSearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
};

export default AppLayout;
