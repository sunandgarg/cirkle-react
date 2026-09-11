import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

type PageChromeRequest = (collapsed: boolean) => void;

const PageChromeRequestContext = createContext<PageChromeRequest>(() => undefined);
const SharedTopPageChromeContext = createContext<ReactNode>(null);
const SharedTopPageChromeRefContext = createContext<RefObject<HTMLElement | null> | undefined>(undefined);

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
  sharedTopChrome = null,
  sharedTopChromeRef,
}: {
  children: ReactNode;
  requestCollapsed: PageChromeRequest;
  sharedTopChrome?: ReactNode;
  sharedTopChromeRef?: RefObject<HTMLElement | null>;
}) => (
  <SharedTopPageChromeRefContext.Provider value={sharedTopChromeRef}>
    <SharedTopPageChromeContext.Provider value={sharedTopChrome}>
      <PageChromeRequestContext.Provider value={requestCollapsed}>
        {children}
      </PageChromeRequestContext.Provider>
    </SharedTopPageChromeContext.Provider>
  </SharedTopPageChromeRefContext.Provider>
);

export const useSharedPageChromeRequest = () => useContext(PageChromeRequestContext);
export const useSharedTopPageChrome = () => useContext(SharedTopPageChromeContext);
export const useSharedTopPageChromeRef = () => useContext(SharedTopPageChromeRefContext);

/** Renders the layout-owned header at the route's chosen position. */
export const SharedTopPageChrome = () => <>{useSharedTopPageChrome()}</>;
