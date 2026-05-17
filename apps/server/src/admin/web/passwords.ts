/**
 * Admin password hashing — scrypt with hardcoded sane parameters.
 *
 * Why scrypt:
 *   - memory-hard (resists GPU and ASIC attacks better than PBKDF2)
 *   - in node:crypto, no third-party dep
 *
 * Format we store in `ADMIN_PASSWORD_HASH`:
 *   scrypt$<saltHex>$<derivedKeyHex>
 *
 * Both segments are hex (matches the regex in config.ts). Salt is 16
 * bytes (32 hex chars), key is 64 bytes (128 hex chars). Parameters
 * are hardcoded; if we ever need to bump them, add a new prefix
 * (`scrypt2$...`) and dispatch in verifyAdminPassword.
 *
 * No params live in the hash string deliberately:
 *   - operators won't accidentally weaken N/r/p with a typo
 *   - upgrading the algorithm is a versioned-prefix migration, which
 *     is the same tactic Django, Postgres, etc. use (algo:rest)
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Tuned for ~50ms on a developer machine. Strong enough that an
// attacker with a leaked .env can't trivially brute-force, while still
// being fast enough that a doctor / login flow is imperceptible.
const SCRYPT_N = 16384; // 2^14
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
// scrypt's default maxmem is 32MB which is too small for N=16384 on
// some Node builds. Bump it explicitly so the call doesn't crash.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashAdminPassword(password: string, saltHex?: string): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  // Operators can supply their own salt for deterministic hashing in
  // tests; production callers omit it and we generate a fresh one.
  const salt = saltHex ? Buffer.from(saltHex, "hex") : randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyAdminPassword(stored: string, candidate: string): boolean {
  if (typeof stored !== "string" || typeof candidate !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const salt = safeHexToBuffer(parts[1]!);
  const expected = safeHexToBuffer(parts[2]!);
  if (!salt || !expected) return false;
  if (expected.length === 0) return false;

  // Derive with the SAME parameters; a mismatch in length means the
  // stored hash was produced by a different algorithm version and
  // should be rejected without leaking which.
  let derived: Buffer;
  try {
    derived = scryptSync(candidate, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }

  // timingSafeEqual throws on length mismatch; we already enforced
  // expected.length === derived.length via keylen.
  return timingSafeEqual(derived, expected);
}

function safeHexToBuffer(hex: string): Buffer | null {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}
