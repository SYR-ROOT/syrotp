# @syrotp/react

React component for the Syrian Reverse OTP Protocol verification flow.

Renders the "send this SMS" UI: receiver msisdn, the `VERIFY <code>`
message, copy button, `sms:` deep link, expiry countdown, and the
verified / expired / cancelled / failed terminal states. Polls the
public `/v/:id/status` endpoint shipped in SYROTP server v0.5.0 and
fires the right callback on each transition.

## Install

```bash
pnpm add @syrotp/react react
```

`react ^18 || ^19` is a peer dependency.

## How the data flow works

`startVerification()` is a **secret-keyed** operation — it must run
on your backend, never in the browser. The React component is a
pure consumer: it receives the full result object as a prop and
polls a public read endpoint for status changes.

```
[Browser]                       [Your backend]                    [SYROTP server]
   │                                  │                                  │
   │   POST /api/start-verify ───────▶│                                  │
   │                                  │  client.startVerification(...) ──▶
   │                                  │◀──────────── { id, send_to,      │
   │                                  │              message, ... }      │
   │◀────────── verification ─────────│                                  │
   │                                                                     │
   │  <SyrotpVerification verification={...} />                            │
   │                                                                     │
   │  GET /v/:id/status (public, IP-rate-limited)  ──────────────────────▶
   │◀───────────────────────── { status, expires_at, verified_at }       │
```

## Usage

```tsx
import { SyrotpVerification, type Verification } from "@syrotp/react";

function VerifyScreen({ verification }: { verification: Verification }) {
  return (
    <SyrotpVerification
      baseUrl="https://syrotp.example.com"
      verification={verification}
      onVerified={(v) => console.log("verified", v)}
      onExpired={(v) => console.log("expired", v)}
      onCancelled={(v) => console.log("cancelled", v)}
      onError={(err) => console.error("syrotp error", err)}
    />
  );
}
```

The `verification` prop is the full object your backend got back
from `startVerification()`. It must contain `id`, `status`,
`send_to`, `message`, `phone_masked`, and `expires_at`.

## Props

| Prop | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Origin of the SYROTP server (`https://syrotp.example.com`). The component appends `/v/:id/status`. |
| `verification` | `Verification` | The full result of `startVerification()`. Used as the initial state; the component polls and updates from there. |
| `pollIntervalMs` | `number?` | Default `2500`. Polling stops automatically on terminal status. |
| `className` | `string?` | When set, the component drops its inline default styles and lets your CSS take over. |
| `initialInstruction` | `string?` | Headline shown above the SMS message. Default: "Send this SMS to verify your phone." |
| `onVerified`, `onExpired`, `onCancelled` | `(v: Verification) => void` | Fired exactly once on the corresponding `pending → terminal` transition. |
| `onError` | `(err: Error) => void` | Fired on poll/clipboard errors. The component keeps polling. |

## Headless hook

If you want to render your own UI, the same logic is exposed as
`useSyrotpVerification`:

```tsx
import { useSyrotpVerification } from "@syrotp/react";

const { verification, secondsLeft } = useSyrotpVerification({
  baseUrl: "https://syrotp.example.com",
  verification: initial,
});
```

## Out of scope (intentional)

- Inline WebAuthn UI — the hosted page links to a developer-supplied
  fallback URL; if you want passkeys in your own flow, build it on top
  of the four `/v1/webauthn/*` endpoints.
- React Native — see `@syrotp/react-native` (planned).
- Heavy theming — pass `className` and override styles with your own CSS.
