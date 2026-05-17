export type VerificationStatus =
  | "pending"
  | "verified"
  | "expired"
  | "cancelled"
  | "failed";

/**
 * The shape returned by `startVerification()` in the server SDK and
 * required as the `verification` prop of `<SyrotpVerification />`.
 *
 * The developer's backend calls the secret-keyed SDK to create the
 * verification, then forwards this object to the frontend (do NOT
 * call `startVerification` from the browser — the secret key must
 * stay server-side).
 *
 * `send_to` and `message` are server-emitted only while the row is
 * `pending`; they go null on terminal states. The component mirrors
 * that contract internally so a stale `message` never lingers in the
 * UI after `verified` / `expired` / `cancelled`.
 */
export interface Verification {
  id: string;
  status: VerificationStatus;
  send_to: string | null;
  message: string | null;
  phone_masked: string;
  expires_at: string;
  verified_at?: string | null;
}

export interface SyrotpVerificationCallbacks {
  onVerified?: (v: Verification) => void;
  onExpired?: (v: Verification) => void;
  onCancelled?: (v: Verification) => void;
  onError?: (err: Error) => void;
}
