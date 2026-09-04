import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers[\"set-cookie\"]",
      "password",
      "password_hash",
      "token",
      "refresh_token",
      "code",
    ],
    censor: "[REDACTED]",
  },
});
