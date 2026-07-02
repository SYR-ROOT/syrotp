import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyrotpVerification } from "../src/SyrotpVerification.js";
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

describe("<SyrotpVerification />", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  it("renders message + send_to + countdown while pending", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification()}
      />,
    );
    expect(screen.getByText("VERIFY 654321")).toBeInTheDocument();
    expect(screen.getByText("+963998887777")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toBeInTheDocument();
  });

  it("emits an sms: link with the URL-encoded message body", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification()}
      />,
    );
    const link = screen.getByRole("link", { name: /open sms app/i });
    expect(link).toHaveAttribute(
      "href",
      "sms:+963998887777?body=VERIFY%20654321",
    );
  });

  it("copies the message to the clipboard when the copy button is clicked", async () => {
    // userEvent.setup() installs a stub navigator.clipboard in jsdom; spy on
    // the writeText it provides instead of trying to redefine the property
    // (defineProperty races with user-event's own setup).
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /copy sms body/i }));
    expect(writeText).toHaveBeenCalledWith("VERIFY 654321");
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it("renders the verified state and never surfaces the message", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification({
          status: "verified",
          send_to: null,
          message: null,
          verified_at: new Date().toISOString(),
        })}
      />,
    );
    expect(screen.queryByText(/VERIFY/)).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/verified/i);
  });

  it("renders the expired state", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification({
          status: "expired",
          send_to: null,
          message: null,
        })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/expired/i);
  });

  it("renders the cancelled state", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification({
          status: "cancelled",
          send_to: null,
          message: null,
        })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/cancelled/i);
  });

  it("respects a custom initialInstruction prop", () => {
    render(
      <SyrotpVerification
        baseUrl="https://otp.example.com"
        verification={mkVerification()}
        initialInstruction="Send the SMS now to confirm."
      />,
    );
    expect(
      screen.getByText("Send the SMS now to confirm."),
    ).toBeInTheDocument();
  });
});
