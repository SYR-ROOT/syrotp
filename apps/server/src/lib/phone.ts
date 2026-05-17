import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export interface NormalizedPhone {
  e164: string;        // canonical, e.g. "+963991234567"
  national: string;    // e.g. "0991234567"
  country: string;     // ISO-3166 alpha-2
}

/**
 * Normalize raw user input into E.164. Throws if invalid.
 * Default region biases parsing for users who omit the +country prefix
 * (the common Syrian case where they type "0991234567").
 */
export function normalizePhone(raw: string, defaultRegion: string): NormalizedPhone {
  if (typeof raw !== "string") throw new PhoneError("invalid_phone");
  const trimmed = raw.trim();
  if (trimmed.length < 5 || trimmed.length > 20) throw new PhoneError("invalid_phone");

  const parsed = parsePhoneNumberFromString(trimmed, defaultRegion as CountryCode);
  if (!parsed || !parsed.isValid()) throw new PhoneError("invalid_phone");

  // Reject types we should never verify against.
  // (premium-rate, shared-cost, etc. are rare but possible — block them.)
  const type = parsed.getType();
  if (type === "PREMIUM_RATE" || type === "SHARED_COST") {
    throw new PhoneError("phone_type_not_allowed");
  }

  return {
    e164: parsed.number,
    national: parsed.nationalNumber,
    country: parsed.country ?? defaultRegion,
  };
}

/**
 * Mask phone for display. Preserves country code and last 3 digits.
 * "+963991234567" => "+96399****567"
 */
export function maskPhone(e164: string): string {
  if (!e164.startsWith("+") || e164.length < 7) return "***";
  // Keep enough of the prefix to show the country code, plus a few digits;
  // keep the last 3 digits so the user recognizes their own number.
  const keepFront = Math.min(6, e164.length - 4);
  const keepBack = 3;
  const front = e164.slice(0, keepFront);
  const back = e164.slice(-keepBack);
  const stars = "*".repeat(Math.max(0, e164.length - keepFront - keepBack));
  return `${front}${stars}${back}`;
}

export class PhoneError extends Error {
  constructor(public readonly code: "invalid_phone" | "phone_type_not_allowed") {
    super(code);
    this.name = "PhoneError";
  }
}
