import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { ApiError, errorHandler, notFound } from "./lib/errors.js";
import { authRouter } from "./routes/auth.js";
import { dataRouter } from "./routes/data.js";
import { functionsRouter } from "./routes/functions.js";
import { featuresRouter } from "./routes/features.js";
import { healthRouter } from "./routes/health.js";
import { rpcRouter } from "./routes/rpc.js";
import { realtimeRouter } from "./routes/realtime.js";
import { storageRouter } from "./routes/storage.js";
import { requestPathForLog, responseForLog } from "./security/logging.js";

export function createApp(): Express {
  const app = express();
  app.disable("x-powered-by");
  if (config.NODE_ENV === "production") app.set("trust proxy", config.TRUST_PROXY_HOPS);
  app.use((req, res, next) => { req.requestId = req.get("x-request-id")?.slice(0, 100) || randomUUID(); res.setHeader("x-request-id", req.requestId); next(); });
  app.use(pinoHttp({
    logger,
    genReqId: (req: express.Request) => req.headers["x-request-id"]?.toString() || randomUUID(),
    wrapSerializers: false,
    serializers: {
      req(req) {
        const request = req as express.Request;
        return {
          id: request.requestId,
          method: request.method,
          url: requestPathForLog(request.originalUrl || request.url),
          remoteAddress: request.socket.remoteAddress,
          remotePort: request.socket.remotePort,
        };
      },
      res: responseForLog,
    },
  }));
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
      else callback(new ApiError(403, "origin_not_allowed", "Request origin is not allowed"));
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id", "X-Recruiter-Scan-Secret"],
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb", strict: true }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));
  app.use(rateLimit({
    windowMs: 15 * 60_000,
    limit: config.NODE_ENV === "test" ? 10_000 : 600,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // AppSync invokes this endpoint once for every connection/subscription.
    // Requests carrying the exact server-only authorizer secret have already
    // crossed an AWS-controlled boundary and must not share a public-IP quota.
    // Invalid/missing secrets remain under the normal public limiter.
    skip: (req) => {
      if (req.method !== "POST" || req.path !== "/api/realtime/appsync/authorize" || !config.APPSYNC_ENABLED || !config.APPSYNC_AUTHORIZER_SECRET) return false;
      const supplied = Buffer.from(req.get("x-cirkle-appsync-secret") || "");
      const expected = Buffer.from(config.APPSYNC_AUTHORIZER_SECRET);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  }));

  app.use(healthRouter);
  app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, limit: config.NODE_ENV === "test" ? 10_000 : 100, standardHeaders: "draft-7", legacyHeaders: false }), authRouter);
  app.use("/api/features", featuresRouter);
  app.use("/api/data", dataRouter);
  app.use("/api/rpc", rpcRouter);
  app.use("/api/realtime", realtimeRouter);
  app.use("/api/functions", functionsRouter);
  app.use("/api/storage", storageRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
