import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";
import { setPrivateNoStore } from "../security/cachePolicy.js";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const normalized = (error as { code?: string })?.code === "LIMIT_FILE_SIZE"
    ? new ApiError(413, "upload_source_too_large", "Upload source must be 10 MB or smaller")
    : error instanceof ZodError
    ? new ApiError(400, "validation_error", "Request validation failed", error.flatten())
    : error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "An unexpected server error occurred");

  if (normalized.status >= 500) logger.error({ err: error, request_id: req.requestId }, "request failed");
  // An endpoint that normally returns public data may still fail. Never let a
  // previous public override make its error response cacheable.
  setPrivateNoStore(res);
  res.status(normalized.status).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      request_id: req.requestId,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  });
};

export const asyncHandler = <T extends RequestHandler>(handler: T): RequestHandler =>
  (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
