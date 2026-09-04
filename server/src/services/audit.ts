import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { keyedHash } from "../security/crypto.js";

export async function writeAudit(input: {
  actor_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  ip?: string;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actor_id: input.actor_id,
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      ip_hash: input.ip ? keyedHash(input.ip) : undefined,
      metadata: input.metadata,
    },
  });
}
