import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";

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
  const normalized = error instanceof ZodError
    ? new ApiError(400, "validation_error", "Request validation failed", error.flatten())
    : error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "An unexpected server error occurred");

  if (normalized.status >= 500) logger.error({ err: error, request_id: req.requestId }, "request failed");
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
