import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerificationController } from "../src/controller.js";
import type { Verification } from "../src/types.js";

function mkVerification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: "vrf_abc123",
    status: "pending",
    send_to: "+963998887777",
    message: "VERIFY 123456",
    phone_masked: "+963 99* *** *567",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    verified_at: null,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  // Drain microtasks so awaited fetch promises in the controller's
  // `poll()` resolve before the next assertion.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("VerificationController", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls /v/:id/status against the configured baseUrl with trailing slash trimmed", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "pending",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        verified_at: null,
      }),
    });
    const c = new VerificationController({
      baseUrl: "https://otp.example.com/",
      verification: mkVerification(),
      pollIntervalMs: 50,
    });
    c.start();
    await flush();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://otp.example.com/v/vrf_abc123/status",
    );
    c.stop();
  });

  it("fires onChange immediately on start with the initial state", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const onChange = vi.fn();
    const initial = mkVerification();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: initial,
      onChange,
    });
    c.start();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(initial);
    c.stop();
  });

  it("fires onVerified on the pending → verified transition and clears send_to/message", async () => {
    const verifiedAt = new Date().toISOString();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "verified",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        verified_at: verifiedAt,
      }),
    });
    const onVerified = vi.fn();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification(),
      pollIntervalMs: 50,
      onVerified,
    });
    c.start();
    await flush();
    expect(onVerified).toHaveBeenCalledTimes(1);
    const arg = onVerified.mock.calls[0]![0] as Verification;
    expect(arg.status).toBe("verified");
    expect(arg.send_to).toBeNull();
    expect(arg.message).toBeNull();
    expect(arg.verified_at).toBe(verifiedAt);
    c.stop();
  });

  it("fires onCancelled on the pending → cancelled transition", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "cancelled",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        verified_at: null,
      }),
    });
    const onCancelled = vi.fn();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification(),
      pollIntervalMs: 50,
      onCancelled,
    });
    c.start();
    await flush();
    expect(onCancelled).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("fires onExpired when the server reports expired", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "expired",
        expires_at: new Date(Date.now() - 1000).toISOString(),
        verified_at: null,
      }),
    });
    const onExpired = vi.fn();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification(),
      pollIntervalMs: 50,
      onExpired,
    });
    c.start();
    await flush();
    expect(onExpired).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("calls onError on HTTP failure but keeps state pending", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const onError = vi.fn();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification(),
      pollIntervalMs: 50,
      onError,
    });
    c.start();
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(c.getState().status).toBe("pending");
    c.stop();
  });

  it("aborts in-flight fetches on stop()", async () => {
    let abortedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      abortedSignal = init.signal as AbortSignal;
      return new Promise(() => {});
    });
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification(),
    });
    c.start();
    await flush();
    expect(fetchMock).toHaveBeenCalled();
    c.stop();
    expect(abortedSignal?.aborted).toBe(true);
  });

  it("locally falls back to expired when expires_at passes", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const onExpired = vi.fn();
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification({ expires_at: expiresAt }),
      pollIntervalMs: 100_000,
      onExpired,
    });
    c.start();
    expect(c.getState().status).toBe("pending");
    vi.advanceTimersByTime(3000);
    expect(c.getState().status).toBe("expired");
    expect(onExpired).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("does not poll when the initial state is already terminal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: "verified", expires_at: "", verified_at: null }),
    });
    const c = new VerificationController({
      baseUrl: "https://otp.example.com",
      verification: mkVerification({
        status: "verified",
        send_to: null,
        message: null,
        verified_at: new Date().toISOString(),
      }),
      pollIntervalMs: 30,
    });
    c.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchMock).not.toHaveBeenCalled();
    c.stop();
  });
});
