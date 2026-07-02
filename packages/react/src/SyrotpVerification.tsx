import { type CSSProperties, type ReactElement, useCallback, useState } from "react";
import type { SyrotpVerificationCallbacks, Verification } from "./types.js";
import { useSyrotpVerification } from "./useSyrotpVerification.js";

export interface SyrotpVerificationProps extends SyrotpVerificationCallbacks {
  baseUrl: string;
  verification: Verification;
  pollIntervalMs?: number;
  /** Pass-through class on the outer `<div>`. When set, the component drops
   * its inline default styles and lets the consumer style everything. */
  className?: string;
  /** Optional override for the headline. Default:
   * "Send this SMS to verify your phone." */
  initialInstruction?: string;
}

const containerStyle: CSSProperties = {
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  maxWidth: 420,
  padding: 16,
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const messageBoxStyle: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 18,
  padding: "10px 12px",
  background: "#f3f4f6",
  borderRadius: 6,
  border: "1px solid #e5e7eb",
  userSelect: "all",
};

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "#ffffff",
  cursor: "pointer",
  fontSize: 14,
};

const linkButtonStyle: CSSProperties = {
  ...buttonStyle,
  color: "#1d4ed8",
  textDecoration: "none",
  display: "inline-block",
};

const statusStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
};

function buildSmsLink(sendTo: string, body: string): string {
  return `sms:${sendTo}?body=${encodeURIComponent(body)}`;
}

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function SyrotpVerification(props: SyrotpVerificationProps): ReactElement {
  const {
    baseUrl,
    verification: initial,
    pollIntervalMs,
    className,
    initialInstruction = "Send this SMS to verify your phone.",
    onVerified,
    onExpired,
    onCancelled,
    onError,
  } = props;

  const { verification, secondsLeft } = useSyrotpVerification({
    baseUrl,
    verification: initial,
    pollIntervalMs,
    onVerified,
    onExpired,
    onCancelled,
    onError,
  });

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    if (!verification.message) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(verification.message);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = verification.message;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }, [verification.message, onError]);

  const useDefaultStyles = !className;
  const wrapperStyle = useDefaultStyles ? containerStyle : undefined;
  const isPending =
    verification.status === "pending" &&
    verification.send_to !== null &&
    verification.message !== null;

  return (
    <div
      className={className}
      style={wrapperStyle}
      data-syrotp="container"
      role="region"
      aria-label="Phone verification"
    >
      {isPending && verification.send_to && verification.message && (
        <>
          <div data-syrotp="instruction">{initialInstruction}</div>
          <div data-syrotp="phone-masked" style={{ fontSize: 14, color: "#4b5563" }}>
            From: <span>{verification.phone_masked}</span>
          </div>
          <div data-syrotp="send-to" style={{ fontSize: 14 }}>
            To: <code>{verification.send_to}</code>
          </div>
          <div
            data-syrotp="message"
            style={messageBoxStyle}
            aria-label="SMS message body"
          >
            {verification.message}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={handleCopy}
              style={buttonStyle}
              aria-label="Copy SMS body to clipboard"
              data-syrotp="copy"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <a
              href={buildSmsLink(verification.send_to, verification.message)}
              style={linkButtonStyle}
              data-syrotp="sms-link"
            >
              Open SMS app
            </a>
          </div>
          <div
            data-syrotp="countdown"
            role="timer"
            aria-label="Time remaining"
            style={{ fontSize: 13, color: "#6b7280" }}
          >
            Expires in <span>{formatCountdown(secondsLeft)}</span>
          </div>
        </>
      )}

      {verification.status === "verified" && (
        <div
          data-syrotp="status"
          role="status"
          aria-live="polite"
          style={{ ...statusStyle, color: "#15803d" }}
        >
          Phone verified.
        </div>
      )}
      {verification.status === "expired" && (
        <div
          data-syrotp="status"
          role="status"
          aria-live="polite"
          style={{ ...statusStyle, color: "#b45309" }}
        >
          Verification expired. Start a new one to continue.
        </div>
      )}
      {verification.status === "cancelled" && (
        <div
          data-syrotp="status"
          role="status"
          aria-live="polite"
          style={{ ...statusStyle, color: "#6b7280" }}
        >
          Verification cancelled.
        </div>
      )}
      {verification.status === "failed" && (
        <div
          data-syrotp="status"
          role="status"
          aria-live="polite"
          style={{ ...statusStyle, color: "#b91c1c" }}
        >
          Verification failed.
        </div>
      )}
    </div>
  );
}
