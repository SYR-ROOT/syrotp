import { useEffect, useRef, useState } from "react";
import type {
  SyrotpVerificationCallbacks,
  Verification,
  VerificationStatus,
} from "./types.js";

export interface UseSyrotpVerificationOptions extends SyrotpVerificationCallbacks {
  baseUrl: string;
  verification: Verification;
  pollIntervalMs?: number;
}

export interface UseSyrotpVerificationResult {
  verification: Verification;
  secondsLeft: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2500;

interface StatusResponse {
  status: VerificationStatus;
  expires_at: string;
  verified_at: string | null;
}

function isTerminal(s: VerificationStatus): boolean {
  return s !== "pending";
}

function computeSecondsLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}

/**
 * Headless hook driving the verification lifecycle. Polls
 * `${baseUrl}/v/:id/status` (the public, IP-rate-limited endpoint
 * shipped in v0.5.0), maintains a 1Hz countdown, and calls the
 * appropriate transition callback exactly once per state change
 * out of `pending`. Aborts in-flight polls on unmount.
 *
 * The `pending → expired` callback fires from either source —
 * server-reported status or local TTL fallback — whichever wins.
 * Server-side lazy-expire usually wins, but the local fallback
 * keeps the UI honest even if the network is slow.
 */
export function useSyrotpVerification(
  options: UseSyrotpVerificationOptions,
): UseSyrotpVerificationResult {
  const {
    baseUrl,
    verification: initial,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = options;

  // Hold callbacks behind a ref so a parent re-render with new inline
  // closures doesn't tear down + restart the polling loop.
  const callbacksRef = useRef<SyrotpVerificationCallbacks>({});
  callbacksRef.current = {
    onVerified: options.onVerified,
    onExpired: options.onExpired,
    onCancelled: options.onCancelled,
    onError: options.onError,
  };

  const [verification, setVerification] = useState<Verification>(initial);
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    computeSecondsLeft(initial.expires_at),
  );

  const prevStatusRef = useRef<VerificationStatus>(initial.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = verification.status;
    if (prev === verification.status) return;
    if (prev !== "pending") return;
    const cb = callbacksRef.current;
    if (verification.status === "verified") cb.onVerified?.(verification);
    else if (verification.status === "expired") cb.onExpired?.(verification);
    else if (verification.status === "cancelled") cb.onCancelled?.(verification);
  }, [verification]);

  useEffect(() => {
    if (isTerminal(verification.status)) return;
    const id = window.setInterval(() => {
      setSecondsLeft(computeSecondsLeft(verification.expires_at));
    }, 1000);
    return () => window.clearInterval(id);
  }, [verification.status, verification.expires_at]);

  useEffect(() => {
    if (isTerminal(verification.status)) return;

    let stopped = false;
    const controller = new AbortController();
    const url = `${baseUrl.replace(/\/+$/, "")}/v/${encodeURIComponent(verification.id)}/status`;

    const tick = async (): Promise<void> => {
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`status poll failed: HTTP ${res.status}`);
        }
        const body = (await res.json()) as StatusResponse;
        if (stopped) return;
        setVerification((prev) => {
          if (body.status === prev.status) {
            return body.expires_at !== prev.expires_at
              ? { ...prev, expires_at: body.expires_at }
              : prev;
          }
          return {
            ...prev,
            status: body.status,
            expires_at: body.expires_at,
            verified_at: body.verified_at,
            send_to: body.status === "pending" ? prev.send_to : null,
            message: body.status === "pending" ? prev.message : null,
          };
        });
      } catch (err) {
        if (stopped) return;
        if (err instanceof Error && err.name === "AbortError") return;
        callbacksRef.current.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    };

    void tick();
    const intervalId = window.setInterval(tick, pollIntervalMs);

    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [baseUrl, verification.id, verification.status, pollIntervalMs]);

  useEffect(() => {
    if (verification.status !== "pending") return;
    if (secondsLeft > 0) return;
    setVerification((prev) =>
      prev.status === "pending"
        ? { ...prev, status: "expired", send_to: null, message: null }
        : prev,
    );
  }, [secondsLeft, verification.status]);

  return { verification, secondsLeft };
}
