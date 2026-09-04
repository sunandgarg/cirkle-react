import { PrismaClient } from "@prisma/client";

const globalWithPrisma = globalThis as typeof globalThis & { __cirklePrisma?: PrismaClient };

export const prisma = globalWithPrisma.__cirklePrisma ?? new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

if (process.env.NODE_ENV !== "production") globalWithPrisma.__cirklePrisma = prisma;
