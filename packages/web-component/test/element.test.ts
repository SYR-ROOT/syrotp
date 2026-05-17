import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/index.js"; // side-effect: registers <syrotp-verification>
import type { Verification } from "../src/types.js";

function mkVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: "vrf_abc123",
    status: "pending",
    send_to: "+963998887777",
    message: "VERIFY 654321",
    phone_masked: "+963 99* *** *567",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    verified_at: null,
    ...overrides,
  };
}

function shadow(el: Element): ShadowRoot {
  const sr = el.shadowRoot;
  if (!sr) throw new Error("no shadowRoot");
  return sr;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("<syrotp-verification>", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("registers under the default tag name and creates an open shadow root", () => {
    const ctor = customElements.get("syrotp-verification");
    expect(ctor).toBeDefined();
    const el = document.createElement("syrotp-verification");
    document.body.appendChild(el);
    expect(el.shadowRoot).not.toBeNull();
  });

  it("renders message + send_to + countdown when verification is set via the property", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification();
    document.body.appendChild(el);
    await flush();

    const sr = shadow(el);
    expect(sr.querySelector('[data-syrotp="message"]')?.textContent).toBe("VERIFY 654321");
    expect(sr.querySelector('[data-syrotp="send-to"]')?.textContent).toContain(
      "+963998887777",
    );
    expect(sr.querySelector('[role="timer"]')).not.toBeNull();
  });

  it("parses verification from a JSON attribute when no property is set", async () => {
    const el = document.createElement("syrotp-verification");
    el.setAttribute("base-url", "https://otp.example.com");
    el.setAttribute("verification", JSON.stringify(mkVerification()));
    document.body.appendChild(el);
    await flush();

    expect(shadow(el).querySelector('[data-syrotp="message"]')?.textContent).toBe(
      "VERIFY 654321",
    );
  });

  it("emits sms: link with the URL-encoded message body", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification();
    document.body.appendChild(el);
    await flush();

    const link = shadow(el).querySelector<HTMLAnchorElement>('[data-syrotp="sms-link"]');
    expect(link?.getAttribute("href")).toBe(
      "sms:+963998887777?body=VERIFY%20654321",
    );
  });

  it("dispatches syrotp-error on invalid verification JSON", async () => {
    const el = document.createElement("syrotp-verification");
    el.setAttribute("base-url", "https://otp.example.com");
    el.setAttribute("verification", "{not valid json");
    const onError = vi.fn();
    el.addEventListener("syrotp-error", onError);
    document.body.appendChild(el);
    await flush();
    expect(onError).toHaveBeenCalled();
  });

  it("dispatches syrotp-verified when polling reports verified", async () => {
    const verifiedAt = new Date().toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "verified",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        verified_at: verifiedAt,
      }),
    }) as unknown as typeof fetch;

    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.setAttribute("poll-interval-ms", "50");
    el.verification = mkVerification();
    const onVerified = vi.fn();
    el.addEventListener("syrotp-verified", onVerified);
    document.body.appendChild(el);

    await new Promise<void>((resolve) => {
      el.addEventListener("syrotp-verified", () => resolve(), { once: true });
    });
    expect(onVerified).toHaveBeenCalledTimes(1);
    const detail = (onVerified.mock.calls[0]![0] as CustomEvent<Verification>).detail;
    expect(detail.status).toBe("verified");
    expect(detail.send_to).toBeNull();
    expect(detail.message).toBeNull();
  });

  it("renders the verified state and never surfaces the message", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification({
      status: "verified",
      send_to: null,
      message: null,
      verified_at: new Date().toISOString(),
    });
    document.body.appendChild(el);
    await flush();

    const sr = shadow(el);
    expect(sr.querySelector('[data-syrotp="message"]')).toBeNull();
    expect(sr.querySelector('[data-syrotp="status"]')?.textContent).toMatch(
      /verified/i,
    );
  });

  it("renders the expired state", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification({
      status: "expired",
      send_to: null,
      message: null,
    });
    document.body.appendChild(el);
    await flush();
    expect(shadow(el).querySelector('[data-syrotp="status"]')?.textContent).toMatch(
      /expired/i,
    );
  });

  it("renders the cancelled state", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification({
      status: "cancelled",
      send_to: null,
      message: null,
    });
    document.body.appendChild(el);
    await flush();
    expect(shadow(el).querySelector('[data-syrotp="status"]')?.textContent).toMatch(
      /cancelled/i,
    );
  });

  it("respects the initial-instruction attribute", async () => {
    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.setAttribute("initial-instruction", "Send the SMS now to confirm.");
    el.verification = mkVerification();
    document.body.appendChild(el);
    await flush();
    expect(
      shadow(el).querySelector('[data-syrotp="instruction"]')?.textContent,
    ).toBe("Send the SMS now to confirm.");
  });

  it("aborts polling on disconnectedCallback", async () => {
    let abortedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      abortedSignal = init.signal as AbortSignal;
      return new Promise(() => {});
    }) as unknown as typeof fetch;

    const el = document.createElement("syrotp-verification") as HTMLElement & {
      verification: Verification;
    };
    el.setAttribute("base-url", "https://otp.example.com");
    el.verification = mkVerification();
    document.body.appendChild(el);
    await flush();
    el.remove();
    expect(abortedSignal?.aborted).toBe(true);
  });
});
