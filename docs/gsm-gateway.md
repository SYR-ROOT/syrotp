# GSM Modem Gateway — Operator Guide

This is the runbook for deploying the **Python GSM modem gateway**
(`apps/gsm-gateway/`). It targets a Linux host with a USB GSM modem
attached. The Android gateway in `apps/android-gateway/` is the
mobile-phone-as-receiver alternative — same wire protocol, same
HMAC scheme, different hardware.

## What this gateway does

- Reads inbound SMS off the modem (`AT+CMGL`, text mode).
- Signs each one with HMAC-SHA256 over `"<ts>.<nonce>.<sha256(body)>"`.
- POSTs to `/v1/inbound/sms` on your SYROTP server.
- Heartbeats the receiver's liveness on a timer.
- Persists pending uploads in a local SQLite queue so a server outage
  or modem flap never drops an SMS.

## What it deliberately does NOT do

- No outbound SMS, no admin endpoints, no dashboard write actions.
- No PDU mode (text mode only — fine for SYROTP's verb+code bodies).
- No SIM PIN unlock — unlock manually before starting the service.

## Hardware

- Tested mental model: SIM800/SIM900 boards over USB-TTL, Quectel/Huawei
  USB sticks switched into modem mode.
- The serial device must speak AT commands, not the carrier's HTTP CDC
  interface. `mmcli -L` (from ModemManager) lists candidates; the
  `ttyUSB*` showing `+CMGF` support is the right one.

## Provisioning a receiver

On the SYROTP server host:

```bash
node apps/server/dist/scripts/bootstrap.js \
  --app-name "kitchen-sim-gateway" \
  --msisdn  "+963991234567"
```

That prints (once, never again):

- `Receiver ID:        rcv_...`
- `Receiver MSISDN:    +963991234567`
- `Gateway signing key: <hex>`

Paste those into `/etc/syrotp-gateway/config.toml` (see below). The
signing key is enough to forge signed inbound SMS, so treat it the
way you'd treat an API key.

## Install (production)

```bash
# 1. System user (no shell, no home dir login).
sudo useradd --system --home /opt/syrotp-gateway --shell /usr/sbin/nologin syrotp-gateway
sudo usermod -a -G dialout syrotp-gateway

# 2. App tree owned by the system user.
sudo install -d -o syrotp-gateway -g syrotp-gateway /opt/syrotp-gateway

# 3. Virtualenv + the package (editable install if you check this repo
#    out on the host; otherwise `pip install syrotp-gsm-gateway`).
sudo python3 -m venv /opt/syrotp-gateway/venv
sudo /opt/syrotp-gateway/venv/bin/pip install /path/to/repo/apps/gsm-gateway

# 4. Config (mode 0600 — contains the signing key).
sudo install -d -m 750 -o syrotp-gateway -g syrotp-gateway /etc/syrotp-gateway
sudo install -m 600 -o syrotp-gateway -g syrotp-gateway \
  apps/gsm-gateway/config.example.toml /etc/syrotp-gateway/config.toml
sudoedit /etc/syrotp-gateway/config.toml

# 5. systemd unit.
sudo install -m 644 apps/gsm-gateway/systemd/syrotp-gateway.service \
  /etc/systemd/system/syrotp-gateway.service
sudo systemctl daemon-reload
sudo systemctl enable --now syrotp-gateway

# 6. Watch.
journalctl -u syrotp-gateway -f
```

## Configuration

See [`apps/gsm-gateway/config.example.toml`](../apps/gsm-gateway/config.example.toml).

| Section / key                      | Required | Default                                |
| ---------------------------------- | -------- | -------------------------------------- |
| `server.url`                       | yes      | —                                      |
| `receiver.id`                      | yes      | —                                      |
| `receiver.msisdn` (E.164)          | yes      | —                                      |
| `receiver.signing_key`             | yes      | —                                      |
| `modem.port`                       | yes      | —                                      |
| `modem.baudrate`                   | no       | `115200`                               |
| `modem.sim_slot`                   | no       | unset                                  |
| `runtime.queue_db_path`            | no       | `/var/lib/syrotp-gateway/queue.db`      |
| `runtime.poll_seconds`             | no       | `5.0`                                  |
| `runtime.heartbeat_seconds`        | no       | `60`                                   |
| `runtime.log_level`                | no       | `INFO`                                 |

## Verifying it works

After `systemctl start`, you should see in `journalctl -u syrotp-gateway -f`:

```
... INFO syrotp_gateway.modem: opening modem at /dev/ttyUSB0 @ 115200 baud
... INFO syrotp_gateway.modem: modem initialized
... INFO syrotp_gateway.service: reader: poll every 5.0s
... INFO syrotp_gateway.service: worker: started
... INFO syrotp_gateway.service: heartbeat: every 60s
... INFO syrotp_gateway.service: heartbeat ok depth=0 signal=-77
```

Then send an SMS from any phone to your receiver number. Within
`poll_seconds` you'll see:

```
... INFO syrotp_gateway.service: reader: 1 SMS on modem
... INFO syrotp_gateway.service: reader: queued idx=1 added=True
... INFO syrotp_gateway.service: upload ok item=N status=202
```

In the SYROTP admin dashboard at `/admin/inbound-sms`, the SMS appears
as a length-only entry (the body itself is never rendered server-side).

## Troubleshooting

### `upload 401 — signing key likely wrong; pausing worker`

The signing key in `config.toml` doesn't match what the server has
stored for this receiver. Re-bootstrap the receiver and update the
config; once you `systemctl restart syrotp-gateway`, the queue drains.

### Repeated `CMGL failed: timeout waiting for 'OK'`

Wrong serial port (you've selected the carrier-management interface
instead of the AT one). Try a different `/dev/ttyUSB*`. `mmcli -L`
helps; so does `picocom -b 115200 /dev/ttyUSB0` followed by typing
`AT` + Enter — the right port replies `OK`.

### SMS arrives on the modem but never reaches the queue

Check the journal for `+CME ERROR` lines. Common causes:

- SIM is PIN-locked (`+CME ERROR: SIM PIN required`) — unlock manually.
- Storage is full (`+CME ERROR: 322`) — clear via `AT+CMGD=1,4` over a
  serial console, then make sure the gateway can keep up with traffic.

### Replay rejects (`x-syrotp-signature` accepted but no_match)

Sometimes the modem reports the same SMS twice before our `AT+CMGD`
takes effect. The SYROTP server's nonce + idempotency-key checks dedupe
these — you'll see `409` in the log and the queue item is removed.
This is expected behavior, not a bug.

## Operational caveats

- **Time sync.** The server enforces a `INBOUND_TIMESTAMP_SKEW_SECONDS`
  window (default 300s). Run NTP on the gateway host or signed requests
  will be rejected after a few hours of clock drift.
- **Rotating the signing key.** Re-running `bootstrap` issues a fresh
  receiver. There is no in-place key rotation in v0.3 — the operator
  workflow is: provision a new receiver, switch the config, reload, then
  disable the old one in the admin UI.
- **Backups.** The SQLite queue is the only state worth backing up
  (anything that's not yet acked by the server). It's at
  `/var/lib/syrotp-gateway/queue.db` by default.
