/**
 * Display-only redaction helpers for the admin dashboard.
 *
 * The dashboard renders read-only views of receivers, verifications,
 * and inbound SMS. None of these views needs to surface a full phone
 * number, the verification code, the SMS body, or any signing key.
 * These helpers enforce that — every template uses them, and the
 * security tests assert they're applied.
 */

import { maskPhone as maskE164 } from "../../lib/phone.js";

export const maskPhone = maskE164;

/**
 * Short, identifying view of a verification or receiver id.
 * Keeps the prefix + first few characters of the ULID.
 *   vrf_01H...
 *   rcv_01H...
 */
export function shortId(id: string): string {
  if (typeof id !== "string" || id.length === 0) return "—";
  const underscore = id.indexOf("_");
  if (underscore < 0) return id.slice(0, 8) + "…";
  const prefix = id.slice(0, underscore + 1);
  const tail = id.slice(underscore + 1);
  if (tail.length <= 4) return prefix + tail;
  return prefix + tail.slice(0, 4) + "…";
}

/**
 * Render an inbound SMS body for diagnostic display WITHOUT leaking
 * the verification code. We surface:
 *   - the leading verb (so operators can tell "VERIFY" vs other prefixes)
 *   - the byte length (so they can spot suspiciously long bodies)
 *   - a placeholder for the rest
 *
 * Example:
 *   "VERIFY A7K9P2"   →  "VERIFY *** (13 bytes)"
 *   "noise text"      →  "noise *** (10 bytes)"
 *   ""                →  "(empty)"
 *
 * If you need the full body, query inbound_sms in psql with audit
 * justification — that's deliberately MORE friction than reading the
 * dashboard.
 */
export function maskInboundBody(body: string): string {
  if (typeof body !== "string") return "(unknown)";
  if (body.length === 0) return "(empty)";
  const trimmed = body.trim();
  // First word — letters+digits only — preserved verbatim.
  const verbMatch = trimmed.match(/^[A-Za-z][A-Za-z0-9]{0,15}/);
  const verb = verbMatch ? verbMatch[0] : "";
  return `${verb} *** (${body.length} bytes)`.trim();
}

/**
 * Format a Date relative to now in a human-readable, low-precision way.
 * Used in tables ("3m ago", "2h ago", "yesterday"). If the date is in
 * the future (e.g. expires_at), prefix "in".
 */
export function relativeTime(d: Date | null | undefined, now: Date = new Date()): string {
  if (!d) return "—";
  const ts = d instanceof Date ? d.getTime() : new Date(d).getTime();
  if (!Number.isFinite(ts)) return "—";
  const diff = ts - now.getTime();
  const future = diff > 0;
  const abs = Math.abs(diff);
  const unit = abs < 60_000
    ? `${Math.floor(abs / 1000)}s`
    : abs < 3600_000
      ? `${Math.floor(abs / 60_000)}m`
      : abs < 86_400_000
        ? `${Math.floor(abs / 3600_000)}h`
        : `${Math.floor(abs / 86_400_000)}d`;
  return future ? `in ${unit}` : `${unit} ago`;
}

/**
 * Receiver ID full vs short — receivers are server-minted and we
 * already render them in metric labels, so showing them in full is
 * fine. shortId() above is for verifications/inbound where the full
 * ULID just clutters tables.
 */
export function receiverShort(id: string): string {
  return shortId(id);
}
