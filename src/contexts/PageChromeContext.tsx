import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type PageChromeRequest = (collapsed: boolean) => void;

const PageChromeRequestContext = createContext<PageChromeRequest>(() => undefined);

export const isCollapsiblePageChromeRoute = (pathname: string) =>
  /^\/(?:consult|jobs)(?:\/|$)/.test(pathname);

// These routes deliberately own their only vertical scroll surface. AppLayout
// must not add a second scroller around them or gestures can change owners at
// the sticky-header boundary.
export const isOwnedPageScrollRoute = (pathname: string) =>
  /^\/(?:consult|jobs|calendar)(?:\/|$)/.test(pathname);

// AppHeader's notification dialog is positioned inside the header. Keep that
// header above the adjacent profile reminder while this wrapper is expanded.
export const COLLAPSIBLE_PAGE_CHROME_STACKING_CLASS = "relative z-50 [&>header]:z-50";

/**
 * Shared-layout state is keyed by the exact route. A collapsed request from a
 * page can therefore never leak into another page during router reconciliation.
 */
export const useRouteScopedPageChrome = (pathname: string) => {
  const eligible = isCollapsiblePageChromeRoute(pathname);
  const [request, setRequest] = useState({ pathname, collapsed: false });
  const requestCollapsed = useCallback<PageChromeRequest>((collapsed) => {
    setRequest({ pathname, collapsed: eligible && collapsed });
  }, [eligible, pathname]);

  return {
    collapsed: eligible && request.pathname === pathname && request.collapsed,
    eligible,
    requestCollapsed,
  };
};

export const PageChromeRequestProvider = ({
  children,
  requestCollapsed,
}: {
  children: ReactNode;
  requestCollapsed: PageChromeRequest;
}) => (
  <PageChromeRequestContext.Provider value={requestCollapsed}>
    {children}
  </PageChromeRequestContext.Provider>
);

export const useSharedPageChromeRequest = () => useContext(PageChromeRequestContext);
