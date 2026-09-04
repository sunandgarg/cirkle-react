import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "../config.js";

export const newId = (): string => randomUUID();
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const randomOtp = (): string => randomInt(100_000, 1_000_000).toString();
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const keyedHash = (value: string): string => createHmac("sha256", config.IP_HASH_SECRET).update(value).digest("hex");

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string): Promise<boolean> => bcrypt.compare(password, hash);
export const hashOtp = (code: string): Promise<string> => bcrypt.hash(`${code}:${config.OTP_PEPPER}`, 10);
export const verifyOtpHash = (code: string, hash: string): Promise<boolean> => bcrypt.compare(`${code}:${config.OTP_PEPPER}`, hash);

export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
