import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSyrotpVerification } from "../src/useSyrotpVerification.js";
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

describe("useSyrotpVerification", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the /v/:id/status endpoint against the configured baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "pending",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        verified_at: null,
      }),
    });
    const { unmount } = renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com/",
        verification: mkVerification(),
        pollIntervalMs: 50,
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://otp.example.com/v/vrf_abc123/status",
    );
    unmount();
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
    renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification(),
        pollIntervalMs: 50,
        onVerified,
      }),
    );
    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    const arg = onVerified.mock.calls[0]![0] as Verification;
    expect(arg.status).toBe("verified");
    expect(arg.send_to).toBeNull();
    expect(arg.message).toBeNull();
    expect(arg.verified_at).toBe(verifiedAt);
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
    renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification(),
        pollIntervalMs: 50,
        onCancelled,
      }),
    );
    await waitFor(() => {
      expect(onCancelled).toHaveBeenCalledTimes(1);
    });
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
    renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification(),
        pollIntervalMs: 50,
        onExpired,
      }),
    );
    await waitFor(() => {
      expect(onExpired).toHaveBeenCalledTimes(1);
    });
  });

  it("calls onError on HTTP failure but keeps state pending", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification(),
        pollIntervalMs: 50,
        onError,
      }),
    );
    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(result.current.verification.status).toBe("pending");
  });

  it("aborts in-flight fetches on unmount", async () => {
    let abortedSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      abortedSignal = init.signal as AbortSignal;
      return new Promise(() => {});
    });
    const { unmount } = renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification(),
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    unmount();
    expect(abortedSignal?.aborted).toBe(true);
  });

  it("locally falls back to expired when expires_at passes without a server transition", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const onExpired = vi.fn();
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const { result } = renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification({ expires_at: expiresAt }),
        pollIntervalMs: 100_000,
        onExpired,
      }),
    );
    expect(result.current.verification.status).toBe("pending");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current.verification.status).toBe("expired");
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("does not poll once the verification is already terminal", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "verified",
        expires_at: new Date().toISOString(),
        verified_at: new Date().toISOString(),
      }),
    });
    renderHook(() =>
      useSyrotpVerification({
        baseUrl: "https://otp.example.com",
        verification: mkVerification({
          status: "verified",
          send_to: null,
          message: null,
          verified_at: new Date().toISOString(),
        }),
        pollIntervalMs: 30,
      }),
    );
    await new Promise((r) => setTimeout(r, 120));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
