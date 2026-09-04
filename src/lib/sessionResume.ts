const LAST_ROUTE_PREFIX = "cirkle:last-route:";

const BLOCKED_ROUTES = ["/auth", "/otp-verify", "/phone-verify", "/iit-verify", "/admin"];
const hasControlCharacter = (route: string) => Array.from(route).some((character) => {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
});

export const isSafeResumeRoute = (route: string) => {
  const pathname = route.split(/[?#]/, 1)[0];
  return route.startsWith("/") &&
    !route.startsWith("//") &&
    !route.includes("\\") &&
    !hasControlCharacter(route) &&
    !BLOCKED_ROUTES.some((blocked) => pathname === blocked || pathname.startsWith(`${blocked}/`));
};

export const readSafeReturnRoute = (route: unknown): string | null =>
  typeof route === "string" && isSafeResumeRoute(route) ? route : null;

export const readResumeRoute = (userId?: string | null) => {
  if (!userId) return "/cirkle-forum";
  try {
    const route = localStorage.getItem(`${LAST_ROUTE_PREFIX}${userId}`) || "";
    return isSafeResumeRoute(route) ? route : "/cirkle-forum";
  } catch {
    return "/cirkle-forum";
  }
};

export const resolvePostAuthRoute = (
  userId: string | null | undefined,
  isAdmin: boolean,
  requestedRoute?: unknown,
) => readSafeReturnRoute(requestedRoute) ?? (isAdmin ? "/admin" : readResumeRoute(userId));

export const saveResumeRoute = (userId: string, route: string) => {
  if (!isSafeResumeRoute(route)) return;
  try { localStorage.setItem(`${LAST_ROUTE_PREFIX}${userId}`, route); }
  catch { /* Browsers may deny storage in privacy mode; route resume is optional. */ }
};
