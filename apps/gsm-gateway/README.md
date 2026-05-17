# SYROTP GSM Modem Gateway

A small Python service that turns a USB GSM modem (SIM800, SIM900, USB
sticks like Huawei E303 in modem mode, etc.) into an SYROTP receiver.

It does three things, on a loop, forever:

1. **Reads** inbound SMS off the modem via `AT+CMGL`, then deletes them
   from the modem so storage doesn't fill up.
2. **Signs** each one with `HMAC-SHA256` over `"<ts>.<nonce>.<sha256(body)>"`
   — the same scheme the SYROTP server's TypeScript verifier expects — and
   `POST`s to `/v1/inbound/sms`.
3. **Heartbeats** to `/v1/receivers/<id>/heartbeat` so the dashboard
   knows the receiver is alive.

A SQLite queue persists items across crashes and reboots; the worker
retries with exponential backoff on transient failures and drops items
after a few hard `4xx` responses. A `401` pauses uploads (don't DoS the
server with a wrong key) but keeps queueing so a fix + restart drains
the backlog.

## Requirements

- Linux (tested on Debian/Ubuntu/Raspbian)
- Python 3.11+
- A USB GSM modem exposed at `/dev/ttyUSB*` or `/dev/ttyACM*`
- A receiver provisioned on your SYROTP server (`syrotp receivers add ...`)

## Install (development)

```bash
cd apps/gsm-gateway
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## Install (production, systemd)

```bash
sudo useradd --system --home /opt/syrotp-gateway --shell /usr/sbin/nologin syrotp-gateway
sudo usermod -a -G dialout syrotp-gateway          # access to /dev/ttyUSB*
sudo install -d -o syrotp-gateway -g syrotp-gateway /opt/syrotp-gateway

sudo python3 -m venv /opt/syrotp-gateway/venv
sudo /opt/syrotp-gateway/venv/bin/pip install ./apps/gsm-gateway

sudo install -d -m 750 -o syrotp-gateway -g syrotp-gateway /etc/syrotp-gateway
sudo install -m 600 -o syrotp-gateway -g syrotp-gateway \
  apps/gsm-gateway/config.example.toml /etc/syrotp-gateway/config.toml
sudoedit /etc/syrotp-gateway/config.toml           # paste real receiver values

sudo install -m 644 apps/gsm-gateway/systemd/syrotp-gateway.service \
  /etc/systemd/system/syrotp-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now syrotp-gateway
journalctl -u syrotp-gateway -f
```

See [config.example.toml](config.example.toml) for the full configuration
surface and [docs/operations.md](../../docs/operations.md) for the
operator runbook.

## Protocol guarantees

The gateway and the server agree on:

- **Signature scheme.** `HMAC-SHA256(signing_key, "<unix-seconds>.<nonce>.<sha256(rawBody)>")`,
  bytes-exact. `tests/test_crypto.py` and `tests/test_client.py` pin
  this — drift would mean every inbound SMS gets a `401` in production.
- **Headers.** `X-SYROTP-Receiver`, `X-SYROTP-Timestamp`, `X-SYROTP-Nonce`,
  `X-SYROTP-Signature`.
- **Body shape.** `{from, to, body, received_at, idempotency_key, sim_slot?}`
  with `received_at` as ISO 8601 UTC (`...Z`).
- **Replay defense.** A new random nonce per request; the server enforces
  one-time use within the skew window.

The gateway never holds SYROTP API keys, encryption material, or
verification codes — only the per-receiver signing key, which is enough
to sign inbound SMS and nothing more.

## What it deliberately does NOT do

- No outbound SMS, no dashboard write actions, no admin endpoints.
- No PDU-mode parsing — text mode only. Multi-part SMS will arrive as
  separate items; the SYROTP code-matching is verb-prefixed and
  short-body, so this is fine in practice.
- No automatic SIM unlocking. If your SIM has a PIN, unlock it manually
  before the gateway starts (or via your modem's own `AT+CPIN=...`).
