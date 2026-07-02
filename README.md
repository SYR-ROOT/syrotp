# SYROTP — Syrian Reverse OTP Protocol

> *إلى أرواح شهداء سوريا.*
>
> *To the souls of the martyrs of Syria.*

> Reverse SMS verification for regions where outbound OTP delivery is
> unreliable. Instead of sending an OTP **to** the user, the user sends a
> short verification message **from** their phone to a local receiver
> number — domestic SMS works even when international inbound routes are
> blocked.

![status](https://img.shields.io/badge/status-v1.0.0-green)
![protocol](https://img.shields.io/badge/protocol-1.0.0%20frozen-blue)
![license](https://img.shields.io/badge/license-MIT-blue.svg)

---

## Why this exists

In regions where international **outbound** SMS routes are unreliable
(Syria and similar networks), traditional OTP-by-SMS is broken.
SYROTP flips the direction:

1. Your app calls `POST /v1/verifications` with a phone number.
2. The server returns a unique code and a local receiver MSISDN.
3. The user sends `VERIFY <code>` to the receiver from their own phone.
4. A receiver gateway (Android app or USB GSM modem) forwards the
   inbound SMS to the server.
5. The server verifies the **sender** matches the asked-for phone, and
   the verification turns `verified`.

Because the user's carrier delivers the SMS domestically — which works
even when international inbound is blocked — the protocol is robust
where outbound OTP is not.

---

## Repository contents

| Path | Description |
|------|-------------|
| `apps/server` | Core verification server (Node + Postgres + Redis). |
| `apps/android-gateway` | Android app that captures inbound SMS and forwards it. |
| `apps/gsm-gateway` | Python USB GSM modem alternative for Linux. |
| `apps/web-demo` | Vanilla-JS verification demo. |
| `packages/sdk-js` | TypeScript/JavaScript client SDK. |
| `packages/sdk-python` | Python client SDK. |
| `packages/sdk-php` | PHP client SDK + Laravel package. |
| `packages/sdk-swift` | Swift client SDK. |
| `packages/sdk-kotlin` | Kotlin client SDK. |
| `packages/cli` | Operator CLI for bootstrap, smoke, and loadtest. |
| `packages/react` | React UI components for the verification flow. |
| `packages/web-component` | Vanilla web-component (framework-agnostic). |
| `packages/flutter` | Flutter widget package. |
| `packages/android-ui` | Android-native UI components (Compose). |
| `packages/swift-ui` | SwiftUI components for iOS. |
| `docs` | Operator + integration documentation. |
| `openapi.yaml` | OpenAPI 3.1 contract for the server. |
| `docs/ar/integration-guide.md` | **دليل التكامل العربي الشامل** — Arabic-language full integration guide for Arab developers (Fusha). |

---

## Quickstart (operators)

```bash
pnpm install
cp .env.example .env
# Generate fresh secrets:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Paste the output into MASTER_ENCRYPTION_KEY and COOKIE_SECRET in .env

docker compose up -d postgres redis
docker compose --profile migrate run --rm migrate
docker compose up -d server

pnpm syrotp doctor
pnpm syrotp bootstrap \
  --app-name "My App" \
  --msisdn +963991234567 \
  --simulate-heartbeat

pnpm syrotp smoke    # end-to-end verification dry run
```

> ⚠️ **Secrets shown once.** Bootstrap prints the publishable key
> (`pk_live_*`), the secret API key (`sk_live_*`), and the gateway
> signing key **exactly once**. Save them in your secret manager
> *before* you run anything else — they are never displayed again.

---

## SDK usage

```ts
import { SyrotpClient } from "@syrotp/sdk";

const syrotp = new SyrotpClient({
  baseUrl: "https://otp.example.com",
  apiKey: process.env.SYROTP_SECRET_KEY!,
});

const v = await syrotp.startVerification({
  phone: "0991234567",
  purpose: "login",
});

console.log(`Send "${v.message}" to ${v.send_to}`);

const result = await syrotp.waitForVerification(v.id);
if (result.status === "verified") {
  // phone owned by sender
}
```

The web demo at [`apps/web-demo/index.html`](apps/web-demo/index.html)
is a complete vanilla-JS UI you can open in a browser.

---

## Android gateway setup

The Android app captures incoming SMS on a phone you own (a dedicated
receiver phone with a local SIM, e.g. Syriatel or MTN), and forwards
them HMAC-signed to your SYROTP server.

#### Prerequisites

- A spare Android device (Android 7.0 / API 24+).
- A SIM card on the operator you want to receive on.
- Android Studio Hedgehog or newer.
- The **Receiver ID** and **Signing key** printed by the bootstrap step.

#### Build & install

```bash
cd apps/android-gateway
./gradlew :app:assembleDebug
adb install app/build/outputs/apk/debug/app-debug.apk
```

#### Pair the device

1. Open **SYROTP Gateway** on the phone.
2. Enter:
   - **Server URL** — `https://otp.example.com` (no trailing slash)
   - **Receiver ID** — `rcv_...`
   - **Signing key** — the long hex value (paste once; it's stored
     encrypted via Android Keystore and never shown again).
3. Tap **Save & pair**. Grant SMS permissions when prompted.
4. The status should switch to **Paired** and the queue depth should be `0`.

#### Verify it works

From another device, send `VERIFY ABCDEF` to the gateway's SIM number.
The queue depth briefly ticks up, then returns to 0 as the gateway
uploads the SMS. The server marks any matching verification as
verified.

#### Operating notes

- **Battery optimization** — disable battery optimization for the
  gateway app (Settings → Apps → SYROTP Gateway → Battery → Unrestricted).
- **Multi-SIM** — the manifest declares support; the SIM slot is
  reported per inbound when available.
- **Cleartext** — the network security config blocks plaintext HTTP.
  For local development against `http://10.0.2.2:3000` (emulator), edit
  [`network_security_config.xml`](apps/android-gateway/app/src/main/res/xml/network_security_config.xml).

#### iOS?

iOS does **not** allow programmatic SMS reading. iOS apps can be
SYROTP **clients** via the SDK; they cannot be receivers. Use Android
or a USB GSM modem instead.

---

## USB GSM modem gateway (Linux)

If you'd rather use a Linux box + USB GSM modem (SIM800/SIM900,
Quectel/Huawei sticks) than a phone, use the Python gateway in
[`apps/gsm-gateway/`](apps/gsm-gateway/). Same wire protocol as the
Android gateway, same HMAC scheme, runs as a `systemd` service.

```bash
sudo useradd --system --home /opt/syrotp-gateway --shell /usr/sbin/nologin syrotp-gateway
sudo usermod -a -G dialout syrotp-gateway
sudo python3 -m venv /opt/syrotp-gateway/venv
sudo /opt/syrotp-gateway/venv/bin/pip install ./apps/gsm-gateway

sudo install -d -m 750 -o syrotp-gateway -g syrotp-gateway /etc/syrotp-gateway
sudo install -m 600 -o syrotp-gateway -g syrotp-gateway \
  apps/gsm-gateway/config.example.toml /etc/syrotp-gateway/config.toml
sudoedit /etc/syrotp-gateway/config.toml

sudo install -m 644 apps/gsm-gateway/systemd/syrotp-gateway.service \
  /etc/systemd/system/syrotp-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now syrotp-gateway
journalctl -u syrotp-gateway -f
```

Full operator guide: [`docs/gsm-gateway.md`](docs/gsm-gateway.md).

---

## Production checklist

Before pointing real users at your SYROTP instance:

#### Secrets

- [ ] `MASTER_ENCRYPTION_KEY` and `COOKIE_SECRET` are unique 64-hex
      values, **not** the `.env.example` placeholders.
- [ ] Bootstrap-issued API keys (`pk_live_*`, `sk_live_*`) and gateway
      signing keys are stored in a real secret manager.
- [ ] Postgres + Redis are behind a private network — not exposed.

#### Infrastructure

- [ ] TLS termination is configured (Nginx, Caddy, or cloud LB).
- [ ] Postgres backups configured and tested.
- [ ] Rate limiting (Cloudflare or in-app) is active.
- [ ] Server logs go to a centralized store, not just the local disk.

#### Receiver

- [ ] Android gateway phone is plugged in (not just on battery).
- [ ] Battery optimization disabled for the gateway app.
- [ ] SIM card has enough balance for inbound SMS reception.
- [ ] Heartbeat is live (`pnpm syrotp receiver list` shows green).

---

## Status

| Component | Status |
|-----------|--------|
| Protocol v1.0 | Frozen |
| Server | Production-ready |
| JS SDK | Stable |
| Python SDK | Stable |
| PHP SDK + Laravel | Stable |
| Swift SDK | Beta |
| Kotlin SDK | Beta |
| Android UI | Beta |
| Flutter | Beta |
| SwiftUI | Alpha |
| Android gateway | Stable |
| GSM gateway | Stable |

See [`ROADMAP.md`](ROADMAP.md) for v1.1+ work.

---

## License

**MIT** — see [`LICENSE`](LICENSE).

SYROTP is released openly for anyone, anywhere, for any purpose, without
restriction. We only ask that you use it for good. See [`DEDICATION.md`](DEDICATION.md)
for the spirit behind this release.

---

## Security

For security disclosures, see [`SECURITY.md`](SECURITY.md). Report
vulnerabilities via a [private security advisory on GitHub](https://github.com/SYR-ROOT/syrotp/security/advisories/new)
or by email to <info@mhd-shekho.com> — do not file public issues for security matters.

---

## Maintainer

**Muhammed Shekho — SYR-ROOT**

Website: <https://mhd-shekho.com>
