import type { Request, RequestHandler, Response } from "express";

export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";
// Current clients generate versioned public-object paths, but deletion does
// not yet issue an edge purge. Bound cache lifetime so an old public URL cannot
// stay at the edge for a year after its database metadata is removed.
export const PUBLIC_OBJECT_CACHE_CONTROL = "public, max-age=3600, must-revalidate";

type MutableHeaders = Record<string, string | string[] | undefined>;

/**
 * Set a fail-closed policy before any parser, rate limiter, router, or error can
 * answer. Routes may opt into public caching only after producing public data.
 */
export const defaultPrivateCachePolicy: RequestHandler = (_req, res, next) => {
  setPrivateNoStore(res);
  next();
};

export function setPrivateNoStore(res: Response): void {
  res.setHeader("Cache-Control", PRIVATE_NO_STORE_CACHE_CONTROL);
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
}

/** Socket.IO/Engine.IO responses do not pass through the Express middleware. */
export function setPrivateNoStoreHeaders(headers: MutableHeaders): void {
  headers["cache-control"] = PRIVATE_NO_STORE_CACHE_CONTROL;
  headers.pragma = "no-cache";
  headers.expires = "0";
}

/**
 * Credentialed, cross-origin, partial-content, and query-shaped requests stay
 * private even when the underlying resource is public. This keeps the
 * exception narrow and avoids cache-key ambiguity at an intermediary.
 */
export function isPublicCacheRequest(req: Request): boolean {
  const queryMarker = req.originalUrl.indexOf("?");
  const rawQuery = queryMarker === -1 ? "" : req.originalUrl.slice(queryMarker + 1);
  return (req.method === "GET" || req.method === "HEAD")
    && !req.get("authorization")
    && !req.get("cookie")
    && !req.get("origin")
    && !req.get("range")
    && rawQuery.length === 0
    && Object.keys(req.query).length === 0;
}

export function setPublicCache(res: Response, cacheControl: string): void {
  res.setHeader("Cache-Control", cacheControl);
  res.removeHeader("Pragma");
  res.removeHeader("Expires");
  // These are generated per request by middleware mounted before storage.
  // Replaying them from a shared edge cache would expose another request's
  // trace ID and stale rate-limit quota metadata.
  res.removeHeader("X-Request-Id");
  res.removeHeader("RateLimit");
  res.removeHeader("RateLimit-Policy");
  // CORS emits a request-origin-specific allow-origin header. Intermediaries
  // must keep those representations separate.
  res.vary("Origin");
}
