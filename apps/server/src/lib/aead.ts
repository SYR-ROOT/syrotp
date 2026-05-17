import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM authenticated encryption keyed by MASTER_ENCRYPTION_KEY.
 *
 * Wire format (base64url-encoded):
 *   v1.<iv-12bytes>.<tag-16bytes>.<ciphertext>
 *
 * Wrapping a value:
 *   - 96-bit random IV (NIST SP 800-38D recommended length).
 *   - Optional `aad` ("additional authenticated data") binds the ciphertext
 *     to a context, e.g. "receiver:rcv_xxx", so a record swap (copy one
 *     receiver's wrapped key onto another row) doesn't validate.
 *
 * Threat coverage:
 *   - DB-only breach (no MASTER_ENCRYPTION_KEY): wrapped values are useless.
 *   - Tampering: GCM tag fails verification on any modification.
 *
 * Out of scope:
 *   - Key rotation: a new MASTER_ENCRYPTION_KEY requires re-wrapping every
 *     value. Operators must re-issue gateway signing keys after rotation.
 */

const VERSION = "v1";

export function wrap(masterKeyHex: string, plaintext: string, aad?: string): string {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64u(iv)}.${b64u(tag)}.${b64u(ct)}`;
}

export function unwrap(masterKeyHex: string, wrapped: string, aad?: string): string {
  const parts = wrapped.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("bad wrap format");
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) throw new Error("master key must be 32 bytes");
  const iv = b64uDecode(parts[1]!);
  const tag = b64uDecode(parts[2]!);
  const ct = b64uDecode(parts[3]!);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function b64u(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}
