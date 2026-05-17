/**
 * Defense-in-depth HTML escaping for any string interpolated into
 * the shadow DOM. The SYROTP server tightly constrains every field —
 * `phone_masked` and the `VERIFY <code>` message are server-emitted
 * and never user-controlled — but escaping keeps a future
 * developer-supplied field (e.g., `initialInstruction`) from being
 * able to inject markup.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function buildSmsLink(sendTo: string, body: string): string {
  return `sms:${sendTo}?body=${encodeURIComponent(body)}`;
}

export const STYLES = `
  :host { display: block; }
  .container {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    max-width: 420px;
    padding: 16px;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .muted { font-size: 14px; color: #4b5563; }
  .small { font-size: 13px; color: #6b7280; }
  .msg {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 18px;
    padding: 10px 12px;
    background: #f3f4f6;
    border-radius: 6px;
    border: 1px solid #e5e7eb;
    user-select: all;
  }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button, a.btn {
    padding: 8px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #ffffff;
    cursor: pointer;
    font-size: 14px;
    color: #111827;
    text-decoration: none;
    display: inline-block;
  }
  a.btn { color: #1d4ed8; }
  .status { font-size: 14px; font-weight: 500; }
  .status.ok { color: #15803d; }
  .status.warn { color: #b45309; }
  .status.error { color: #b91c1c; }
  .status.muted { color: #6b7280; }
`;
