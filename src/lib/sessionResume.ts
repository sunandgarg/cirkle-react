const LAST_ROUTE_PREFIX = "cirkle:last-route:";

const BLOCKED_ROUTES = ["/auth", "/otp-verify", "/phone-verify", "/iit-verify", "/admin"];

export const isSafeResumeRoute = (route: string) =>
  route.startsWith("/") &&
  !route.startsWith("//") &&
  !BLOCKED_ROUTES.some((blocked) => route === blocked || route.startsWith(`${blocked}/`));

export const readResumeRoute = (userId?: string | null) => {
  if (!userId) return "/cirkle-forum";
  try {
    const route = localStorage.getItem(`${LAST_ROUTE_PREFIX}${userId}`) || "";
    return isSafeResumeRoute(route) ? route : "/cirkle-forum";
  } catch {
    return "/cirkle-forum";
  }
};

export const resolvePostAuthRoute = (userId: string | null | undefined, isAdmin: boolean) =>
  isAdmin ? "/admin" : readResumeRoute(userId);

export const saveResumeRoute = (userId: string, route: string) => {
  if (!isSafeResumeRoute(route)) return;
  try { localStorage.setItem(`${LAST_ROUTE_PREFIX}${userId}`, route); }
  catch { /* Browsers may deny storage in privacy mode; route resume is optional. */ }
};
