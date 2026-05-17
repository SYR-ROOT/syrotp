import { VerificationController } from "./controller.js";
import { STYLES, buildSmsLink, escapeHtml, formatCountdown } from "./render.js";
import type { Verification } from "./types.js";

const DEFAULT_INSTRUCTION = "Send this SMS to verify your phone.";

/**
 * `<syrotp-verification>` — the framework-agnostic counterpart to
 * `@syrotp/react`'s `<SyrotpVerification />`. Same wire contract,
 * same lifecycle, same callbacks (delivered as `CustomEvent`s here).
 *
 * Required input: a `verification` object (the full result of
 * `startVerification()` from the secret-keyed SDK on the developer's
 * backend) and a `base-url` attribute pointing at the SYROTP server.
 *
 * The verification can be supplied two ways:
 *   - As a JSON string via the `verification` attribute (handy for
 *     server-rendered pages embedding the element directly).
 *   - As an object via the `verification` property (when JS code is
 *     constructing the element).
 *
 * Events:
 *   - `syrotp-verified`  — `detail: Verification`
 *   - `syrotp-expired`   — `detail: Verification`
 *   - `syrotp-cancelled` — `detail: Verification`
 *   - `syrotp-error`     — `detail: Error`
 *
 * Polling stops automatically on terminal status and on
 * `disconnectedCallback`.
 */
export class SyrotpVerificationElement extends HTMLElement {
  static readonly tagName = "syrotp-verification";

  private _verification: Verification | null = null;
  private controller: VerificationController | null = null;
  private root: ShadowRoot;

  static get observedAttributes(): string[] {
    return ["base-url", "verification", "poll-interval-ms", "initial-instruction"];
  }

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
  }

  set verification(v: Verification | null) {
    this._verification = v;
    if (this.isConnected) this.restart();
  }
  get verification(): Verification | null {
    return this._verification;
  }

  connectedCallback(): void {
    if (!this._verification) {
      const attr = this.getAttribute("verification");
      if (attr) {
        try {
          this._verification = JSON.parse(attr) as Verification;
        } catch (err) {
          this.dispatchError(err);
        }
      }
    }
    this.restart();
  }

  disconnectedCallback(): void {
    this.controller?.stop();
    this.controller = null;
  }

  attributeChangedCallback(
    name: string,
    _oldValue: string | null,
    newValue: string | null,
  ): void {
    if (name === "verification") {
      if (newValue) {
        try {
          this._verification = JSON.parse(newValue) as Verification;
        } catch (err) {
          this.dispatchError(err);
          return;
        }
      } else {
        this._verification = null;
      }
    }
    if (this.isConnected) this.restart();
  }

  private restart(): void {
    this.controller?.stop();
    this.controller = null;

    if (!this._verification) {
      this.root.innerHTML = "";
      return;
    }

    const baseUrl = this.getAttribute("base-url") ?? "";
    const pollAttr = this.getAttribute("poll-interval-ms");
    const pollIntervalMs = pollAttr ? Number(pollAttr) : undefined;

    this.controller = new VerificationController({
      baseUrl,
      verification: this._verification,
      pollIntervalMs,
      onChange: (state, secs) => this.render(state, secs),
      onVerified: (state) => this.dispatchDetailEvent("syrotp-verified", state),
      onExpired: (state) => this.dispatchDetailEvent("syrotp-expired", state),
      onCancelled: (state) => this.dispatchDetailEvent("syrotp-cancelled", state),
      onError: (err) => this.dispatchError(err),
    });
    this.controller.start();
  }

  private dispatchDetailEvent(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private dispatchError(err: unknown): void {
    const e = err instanceof Error ? err : new Error(String(err));
    this.dispatchDetailEvent("syrotp-error", e);
  }

  private render(v: Verification, secsLeft: number): void {
    const instruction =
      this.getAttribute("initial-instruction") ?? DEFAULT_INSTRUCTION;

    if (v.status === "pending" && v.send_to && v.message) {
      this.root.innerHTML = `
        <style>${STYLES}</style>
        <div class="container" data-syrotp="container" role="region" aria-label="Phone verification">
          <div data-syrotp="instruction">${escapeHtml(instruction)}</div>
          <div data-syrotp="phone-masked" class="muted">From: <span>${escapeHtml(v.phone_masked)}</span></div>
          <div data-syrotp="send-to" class="muted">To: <code>${escapeHtml(v.send_to)}</code></div>
          <div data-syrotp="message" class="msg" aria-label="SMS message body">${escapeHtml(v.message)}</div>
          <div class="actions">
            <button type="button" data-syrotp="copy" aria-label="Copy SMS body to clipboard">Copy</button>
            <a class="btn" data-syrotp="sms-link" href="${escapeHtml(buildSmsLink(v.send_to, v.message))}">Open SMS app</a>
          </div>
          <div data-syrotp="countdown" role="timer" aria-label="Time remaining" class="small">
            Expires in <span>${formatCountdown(secsLeft)}</span>
          </div>
        </div>
      `;
      const btn = this.root.querySelector<HTMLButtonElement>('[data-syrotp="copy"]');
      if (btn) btn.addEventListener("click", () => void this.handleCopy(btn));
      return;
    }

    const statusBlock = (cls: string, text: string): string => `
      <style>${STYLES}</style>
      <div class="container" data-syrotp="container" role="region" aria-label="Phone verification">
        <div data-syrotp="status" class="status ${cls}" role="status" aria-live="polite">${escapeHtml(text)}</div>
      </div>
    `;

    if (v.status === "verified") {
      this.root.innerHTML = statusBlock("ok", "Phone verified.");
    } else if (v.status === "expired") {
      this.root.innerHTML = statusBlock(
        "warn",
        "Verification expired. Start a new one to continue.",
      );
    } else if (v.status === "cancelled") {
      this.root.innerHTML = statusBlock("muted", "Verification cancelled.");
    } else if (v.status === "failed") {
      this.root.innerHTML = statusBlock("error", "Verification failed.");
    } else {
      this.root.innerHTML = "";
    }
  }

  private async handleCopy(btn: HTMLButtonElement): Promise<void> {
    const v = this._verification;
    if (!v?.message) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(v.message);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = v.message;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      }
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        if (btn.isConnected) btn.textContent = original ?? "Copy";
      }, 1500);
    } catch (err) {
      this.dispatchError(err);
    }
  }
}
