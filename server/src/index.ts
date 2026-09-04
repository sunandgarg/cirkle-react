import { createServer } from "node:http";
import { app } from "./app.js";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { prisma } from "./lib/prisma.js";
import { attachSocketServer } from "./realtime/socket.js";

const httpServer = createServer(app);
const io = attachSocketServer(httpServer);

const cleanupTimer = setInterval(() => {
  const now = new Date();
  void Promise.all([
    prisma.emailOtp.deleteMany({ where: { expires_at: { lt: now } } }),
    prisma.passwordReset.deleteMany({ where: { expires_at: { lt: now } } }),
    prisma.oAuthCode.deleteMany({ where: { expires_at: { lt: now } } }),
    prisma.refreshSession.deleteMany({ where: { expires_at: { lt: now } } }),
  ]).catch((error: unknown) => logger.error({ err: error }, "auth cleanup failed"));
}, 60 * 60_000);
cleanupTimer.unref();

httpServer.listen(config.PORT, config.HOST, () => logger.info({ host: config.HOST, port: config.PORT }, "Cirkle API listening"));

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "graceful shutdown started");
  clearInterval(cleanupTimer);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  io.close();
  httpServer.close(async () => {
    await prisma.$disconnect();
    clearTimeout(force);
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (error) => logger.fatal({ err: error }, "unhandled rejection"));
process.on("uncaughtException", (error) => { logger.fatal({ err: error }, "uncaught exception"); void shutdown("uncaughtException"); });
