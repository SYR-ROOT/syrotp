# @syrotp/sdk

Universal JavaScript / TypeScript SDK for the Syrian Reverse OTP Protocol (SYROTP).

```bash
npm install @syrotp/sdk
```

## Quick start (backend)

```ts
import { SyrotpClient } from "@syrotp/sdk";

const syrotp = new SyrotpClient({
  baseUrl: "https://otp.example.com",
  apiKey: process.env.SYROTP_SECRET_KEY!, // sk_live_xxx
});

const verification = await syrotp.startVerification({
  phone: "0991234567",
  purpose: "login",
  clientRef: "user_123",
});

console.log(`Ask the user to send "${verification.message}" to ${verification.send_to}`);

const result = await syrotp.waitForVerification(verification.id);
if (result.status === "verified") {
  console.log("✓ phone owned by sender");
}
```

## Quick start (frontend)

Use a **public key** (`pk_live_*`) only. Never embed a secret key in the browser.

```ts
const syrotp = new SyrotpClient({
  baseUrl: "https://otp.example.com",
  apiKey: PUBLIC_KEY,
});
const v = await syrotp.startVerification({ phone, purpose: "login" });
```

## API

| Method | Description |
|---|---|
| `startVerification(input)` | Begin a verification; returns the receiver number and message body. |
| `getVerification(id)` | Read current status. |
| `cancelVerification(id)` | Cancel a pending verification. |
| `waitForVerification(id, opts?)` | Poll until terminal (`verified`/`expired`/`cancelled`/`failed`) or timeout. |

## Errors

All non-2xx responses raise `SyrotpError` with `code`, `status`, `requestId`:

```ts
import { SyrotpError } from "@syrotp/sdk";

try {
  await syrotp.startVerification(...);
} catch (e) {
  if (e instanceof SyrotpError && e.code === "rate_limited") { /* back off */ }
}
```
