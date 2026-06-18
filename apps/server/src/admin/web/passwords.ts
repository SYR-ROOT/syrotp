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
 *
 * Sync vs async:
 *   - `hashAdminPassword` is sync — it runs once at provisioning
 *     time via the `admin-password-hash` CLI, never on a request path.
 *   - `verifyAdminPassword` is async (Promise<boolean>) — it sits on
 *     the /admin/* request path. Each scrypt derivation costs ~50ms
 *     of CPU, so running it on the main event loop (scryptSync) lets
 *     a modest attack rate (~10-20 req/s) starve the entire server.
 *     The async form hands the work to libuv's thread pool.
 */
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

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
  // Sync is fine here — this function only runs at provisioning time
  // through the `admin-password-hash` CLI (or in tests). It is NOT on
  // any request path.
  const key = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyAdminPassword(stored: string, candidate: string): Promise<boolean> {
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
  //
  // Async scrypt offloads the derivation to libuv's thread pool so the
  // main event loop stays responsive under sustained admin auth load
  // (see the comment at the top of this file).
  let derived: Buffer;
  try {
    derived = await scryptAsync(candidate, salt, expected.length, {
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
