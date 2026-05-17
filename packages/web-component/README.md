# @syrotp/web-component

Framework-agnostic `<syrotp-verification>` custom element for the
Syrian Reverse OTP Protocol verification flow.

Same UI and lifecycle as [`@syrotp/react`](../react/), built on
native Custom Elements + Shadow DOM. Use it from plain HTML, Vue,
Svelte, Angular, vanilla JS — anywhere an `HTMLElement` is welcome.

## Install

```bash
pnpm add @syrotp/web-component
```

## How the data flow works

`startVerification()` is a **secret-keyed** operation — it must run
on your backend, never in the browser. The element is a pure
consumer: it receives the full result object and polls a public
read endpoint for status changes.

```
[Browser]                       [Your backend]                    [SYROTP server]
   │                                  │                                  │
   │   POST /api/start-verify ───────▶│                                  │
   │                                  │  client.startVerification(...) ──▶
   │                                  │◀──────────── { id, send_to,      │
   │                                  │              message, ... }      │
   │◀────────── verification ─────────│                                  │
   │                                                                     │
   │  <syrotp-verification base-url=...>                                   │
   │                                                                     │
   │  GET /v/:id/status (public, IP-rate-limited)  ──────────────────────▶
   │◀───────────────────────── { status, expires_at, verified_at }       │
```

## Usage

### From HTML

```html
<syrotp-verification
  base-url="https://syrotp.example.com"
  verification='{"id":"vrf_…","status":"pending","send_to":"+963…","message":"VERIFY 123456","phone_masked":"+963 99* *** *567","expires_at":"2026-05-03T12:00:00Z"}'
></syrotp-verification>

<script type="module">
  import "@syrotp/web-component";

  const el = document.querySelector("syrotp-verification");
  el.addEventListener("syrotp-verified", (e) => console.log("verified", e.detail));
  el.addEventListener("syrotp-expired", (e) => console.log("expired", e.detail));
  el.addEventListener("syrotp-cancelled", (e) => console.log("cancelled", e.detail));
  el.addEventListener("syrotp-error", (e) => console.error("syrotp error", e.detail));
</script>
```

### From JS (preferred when you have a real object)

```ts
import "@syrotp/web-component";
import type { Verification } from "@syrotp/web-component";

const el = document.createElement("syrotp-verification");
el.setAttribute("base-url", "https://syrotp.example.com");

// Pass the verification as an object via the property — avoids
// a JSON.stringify / JSON.parse round-trip and is friendlier to
// type checking.
(el as HTMLElement & { verification: Verification }).verification = {
  id: "vrf_…",
  status: "pending",
  send_to: "+963…",
  message: "VERIFY 123456",
  phone_masked: "+963 99* *** *567",
  expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  verified_at: null,
};

document.body.appendChild(el);
```

## Attributes

| Attribute | Notes |
| --- | --- |
| `base-url` | Origin of the SYROTP server (`https://syrotp.example.com`). The element appends `/v/:id/status`. |
| `verification` | The full result of `startVerification()`, JSON-encoded. Optional if you set `el.verification` as a property. |
| `poll-interval-ms` | Default `2500`. Polling stops on terminal status. |
| `initial-instruction` | Headline shown above the SMS message. Default: "Send this SMS to verify your phone." |

## Properties

| Property | Type | Notes |
| --- | --- | --- |
| `verification` | `Verification \| null` | Setting this restarts polling with the new state. |

## Events

| Event | `detail` |
| --- | --- |
| `syrotp-verified` | `Verification` (with `send_to`/`message` nulled) |
| `syrotp-expired` | `Verification` |
| `syrotp-cancelled` | `Verification` |
| `syrotp-error` | `Error` |

All events bubble and cross shadow boundaries (`composed: true`).

## Custom tag name

The element auto-registers as `syrotp-verification` on import. To
register under a different name, call `defineSyrotpVerification` —
it's a no-op if the name is already taken:

```ts
import { defineSyrotpVerification } from "@syrotp/web-component";
defineSyrotpVerification("my-app-verify");
```

## Headless controller

`VerificationController` is exported for consumers who want only
the polling/state-machine logic without the UI:

```ts
import { VerificationController } from "@syrotp/web-component";

const c = new VerificationController({
  baseUrl: "https://syrotp.example.com",
  verification,
  onVerified: (v) => /* ... */,
  onError: (err) => /* ... */,
});
c.start();
// later: c.stop();
```

## Out of scope (intentional)

- Inline WebAuthn UI — same posture as `@syrotp/react`.
- Heavy theming — the shadow DOM keeps host-page CSS from leaking
  in. CSS Custom Properties for theming are a future addition.
