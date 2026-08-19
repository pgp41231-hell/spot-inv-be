import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { unauthorized } from "./errors.js";

const encode = (value) => Buffer.from(value).toString("base64url");

export function createEquipmentToken(secret) {
  if (!secret) throw new Error("QR_TOKEN_SECRET is required");
  const opaque = encode(randomBytes(32));
  const signature = createHmac("sha256", secret).update(opaque).digest("base64url");
  return `${opaque}.${signature}`;
}

export function verifyEquipmentToken(token, secret) {
  const [opaque, provided] = String(token || "").split(".");
  if (!opaque || !provided || !secret) throw unauthorized("Invalid equipment QR token");
  const expected = createHmac("sha256", secret).update(opaque).digest();
  let supplied;
  try { supplied = Buffer.from(provided, "base64url"); } catch { throw unauthorized("Invalid equipment QR token"); }
  // Reject non-canonical base64url spellings too. Without this check, changing
  // unused bits in the final character can decode to the same signature bytes.
  if (encode(supplied) !== provided || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw unauthorized("Invalid equipment QR token");
  return token;
}

export const equipmentTokenHash = (token) => createHash("sha256").update(String(token)).digest("hex");
