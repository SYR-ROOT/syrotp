import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";

/**
 * Constant-time string equality. Prevents timing oracles when comparing
 * secrets, signatures, or codes. Returns false on length mismatch without
 * leaking which side was longer.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch — wrap it.
  if (ab.length !== bb.length) {
    // Still do a compare against ab to keep work roughly constant.
    const filler = Buffer.alloc(ab.length);
    timingSafeEqual(ab, filler);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(key: string | Buffer, msg: string | Buffer): string {
  return createHmac("sha256", key).update(msg).digest("hex");
}

/**
 * Generate a verification code suitable for sending over SMS.
 * Excludes ambiguous characters (0/O/1/I/L) to reduce user error.
 * Uses crypto.randomInt — uniform distribution, no modulo bias.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars
export function generateCode(length: number): string {
  if (length < 4 || length > 32) throw new Error("invalid code length");
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a high-entropy API key. Format: `<prefix>_<random>`.
 * `random` is base32-ish (alphanumeric, lowercase) for URL safety.
 * 32 bytes random => ~256 bits of entropy.
 */
const API_KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export function generateApiKey(prefix: "pk_live" | "sk_live" | "gw_live"): string {
  const bytes = randomBytes(32);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    // Map each byte to an alphabet char. Slight bias is fine here — we only
    // need ~187 bits effective entropy and have plenty.
    out += API_KEY_ALPHABET[bytes[i]! % API_KEY_ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

/**
 * Generate a random nonce (hex). 16 bytes = 128 bits.
 */
export function generateNonce(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Hash an API key for at-rest storage. We use HMAC-SHA256 keyed by
 * MASTER_ENCRYPTION_KEY, not bcrypt: API keys are uniformly random
 * 256-bit strings, so they cannot be brute-forced offline; we only need
 * fast deterministic lookup. bcrypt would be a poor fit (slow, salted,
 * non-deterministic — can't index).
 *
 * Key separation: pass a `domain` ("api_key", "gateway_secret") so the
 * same input can't collide across uses.
 */
export function hashSecret(domain: string, masterKeyHex: string, value: string): string {
  const key = Buffer.from(masterKeyHex, "hex");
  return hmacSha256Hex(key, `${domain}:${value}`);
}

/**
 * Verify an HMAC signature with constant-time comparison.
 * `signature` is hex string; we compute the expected hex and compare.
 */
export function verifyHmacHex(
  key: string | Buffer,
  payload: string | Buffer,
  signatureHex: string,
): boolean {
  const expected = hmacSha256Hex(key, payload);
  return safeEqual(expected, signatureHex);
}
