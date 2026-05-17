export type VerificationStatus =
  | "pending"
  | "verified"
  | "expired"
  | "cancelled"
  | "failed";

/**
 * The shape returned by `startVerification()` in any SYROTP server SDK
 * and required as the input for `<syrotp-verification>`.
 *
 * The developer's backend calls the secret-keyed SDK to create the
 * verification, then forwards this object to the frontend (do NOT
 * call `startVerification` from the browser — the secret key must
 * stay server-side).
 *
 * `send_to` and `message` are server-emitted only while the row is
 * `pending`; they go null on terminal states. The element mirrors
 * that contract so a stale verify code never lingers in the UI
 * after a `verified` / `expired` / `cancelled` transition.
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
  onChange?: (v: Verification, secondsLeft: number) => void;
  onVerified?: (v: Verification) => void;
  onExpired?: (v: Verification) => void;
  onCancelled?: (v: Verification) => void;
  onError?: (err: Error) => void;
}
