# Monitoring

SYROTP exposes a Prometheus exposition-format endpoint at **`GET /metrics`**.
This page documents what's there, how to scrape it, and the alerts every
operator should turn on before going live.

## Endpoint

| | |
|---|---|
| Path        | `/metrics` |
| Format      | Prometheus exposition (`text/plain; version=0.0.4`) |
| Auth        | none — restrict access at your reverse proxy |
| Public?     | no, by convention. Don't expose `/metrics` to the internet. |

We do not bake auth into `/metrics` itself. Operators terminate it at
nginx / Caddy / a private network — same way Prometheus itself, etcd,
and most other production servers do.

```nginx
location /metrics {
    allow 10.0.0.0/8;     # internal Prometheus
    deny all;
    proxy_pass http://syrotp-server:3000/metrics;
}
```

## Scrape config

Drop into your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: syrotp-server
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout: 10s
    static_configs:
      - targets: ["syrotp-server:3000"]
        labels:
          env: production         # add your own labels here
```

The exporter labels every metric with `service="syrotp-server"` already.

## Metrics

### Counters — verification lifecycle

| Metric | Labels | Bumped on |
|---|---|---|
| `syrotp_verifications_started_total` | `app_id` | every successful `POST /v1/verifications` |
| `syrotp_verifications_terminal_total` | `app_id`, `status` | when a verification reaches `verified` / `cancelled` (and, indirectly, the lazy-expire path) |

`status` enum: `verified`, `cancelled`, `expired`, `failed`.

`expired` is currently emitted only via the lazy-expire path inside
`getVerification`; a future PR can add a periodic sweep so the counter
moves on its own clock.

### Counters — inbound SMS

| Metric | Labels | Notes |
|---|---|---|
| `syrotp_inbound_received_total` | `receiver_id`, `matched`, `reason` | post-HMAC, post-replay |

`matched`: `"true"` / `"false"`.

`reason`:
- `matched` — `matched=true`
- `no_match` — sender didn't equal the verification's phone, or code was wrong, or no pending verification existed
- `duplicate` — `idempotency_key` already seen for this receiver
- `expired` — pending row past TTL (defensive; usually no_match)

### Counters — auth & rate limit

| Metric | Labels | Bumped on |
|---|---|---|
| `syrotp_hmac_rejected_total` | `reason` | every HMAC failure on `/v1/inbound/sms` and `/v1/receivers/*/heartbeat` |
| `syrotp_api_key_rejected_total` | `reason` | every bearer-token rejection on developer endpoints |
| `syrotp_rate_limited_total` | `bucket` | every 429 |

`hmac_rejected.reason` enum (matches `verifyGatewayHmac`'s return codes):
`bad_receiver_id`, `bad_nonce`, `bad_signature_format`, `bad_timestamp`,
`timestamp_skew`, `unknown_receiver`, `key_unavailable`, `bad_signature`,
`replay`.

`api_key_rejected.reason`: `missing`, `unknown`, `wrong_kind`. The CLI
deliberately collapses `unknown / revoked / app_disabled` into one
label to avoid leaking shape via timing.

`rate_limited.bucket`: `start`, `status`, `inbound`.

### Histograms — latency

| Metric | Buckets (s) | Labels |
|---|---|---|
| `syrotp_verification_start_duration_seconds` | 0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2 | `status` (`2xx`/`4xx`/`5xx`/`other`) |
| `syrotp_inbound_match_duration_seconds`      | same | `matched` (`true`/`false`) |

Rendered alongside `_count` and `_sum` series so both `histogram_quantile()`
and a plain mean (`_sum / _count`) work.

### Gauges — receivers

| Metric | Labels | Notes |
|---|---|---|
| `syrotp_receivers_total`             | `enabled` (`true`/`false`) | refreshed every 30s |
| `syrotp_receivers_healthy_total`     | —                          | enabled AND heartbeat within `RECEIVER_HEARTBEAT_TIMEOUT_SECONDS` |
| `syrotp_receiver_heartbeat_age_seconds` | `receiver_id`           | seconds since last heartbeat per receiver. A never-paired receiver reports a sentinel `~31536000` (one year). |

Receiver IDs are server-minted, low cardinality (1–10 per app, dozens
per fleet), so labeling by `receiver_id` is safe.

### Gauges — abuse signals (v0.8 PR #39)

Project-wide rollups, computed from a 1-hour sliding window every
60s. Per-app / per-receiver detail intentionally lives behind the
basic-auth-gated `/admin/abuse-signals` JSON endpoint to keep
metric cardinality bounded.

| Metric | Labels | Notes |
|---|---|---|
| `syrotp_abuse_failed_verification_rate`  | — | fraction of verifications in last hour that ended in `failed`. `[0, 1]`. |
| `syrotp_abuse_unmatched_inbound_rate`    | — | fraction of inbound SMS in last hour that didn't match a pending verification. `[0, 1]`. |
| `syrotp_abuse_binding_failure_rate`      | — | fraction of `phone_bindings` rows created in last hour that expired in `pending`. `[0, 1]`. |
| `syrotp_abuse_min_app_health_score`      | — | lowest per-app health score across all apps. `[0, 100]`, higher is healthier. |

Recommended alerts:

- `syrotp_abuse_unmatched_inbound_rate > 0.20` for 10m → "investigate
  abuse / mismatched gateway"
- `syrotp_abuse_min_app_health_score < 70` for 30m → "look at the
  per-app dashboard"
- `syrotp_abuse_binding_failure_rate > 0.30` for 30m → "developer
  setup is failing — check `/admin/abuse-signals`"

Per-app detail: `GET /admin/abuse-signals` (basic-auth) returns
JSON shaped as:

```json
{
  "generated_at": "...",
  "window": "1 hour",
  "apps": [
    { "app_id": "app_...", "total_verifications": 42,
      "failed_rate": 0.05, "unmatched_rate": 0.10,
      "binding_failure_rate": 0.0, "health_score": 87, ... }
  ],
  "receivers": [
    { "receiver_id": "rcv_...", "app_id": "app_...",
      "total_inbounds": 41, "unmatched_inbounds": 4,
      "unmatched_rate": 0.097 }
  ]
}
```

The endpoint is **read-only** — there is no auto-ban, no account
suspension, and no policy action triggered by the score in v0.8 PR
#39. The data infrastructure has to land first; PR #40 (Android
Keystore) and any future abuse-policy work will decide what to DO
with the signals.

### Default Node.js metrics

`prom-client`'s `collectDefaultMetrics` is on. You also get heap, gc,
event-loop lag, etc. under the standard `process_*` and `nodejs_*`
namespaces.

## Recommended dashboards

Three panels are enough to spot every regression we've seen so far:

**1. Verification flow**

```promql
sum(rate(syrotp_verifications_started_total[5m]))
sum(rate(syrotp_verifications_terminal_total{status="verified"}[5m]))
sum(rate(syrotp_verifications_terminal_total{status="expired"}[5m]))
```

**2. Latency**

```promql
histogram_quantile(0.95, sum(rate(syrotp_verification_start_duration_seconds_bucket[5m])) by (le))
histogram_quantile(0.95, sum(rate(syrotp_inbound_match_duration_seconds_bucket[5m])) by (le))
```

**3. Receiver health**

```promql
syrotp_receivers_healthy_total
max by (receiver_id) (syrotp_receiver_heartbeat_age_seconds)
```

## Alerts (the three you should not ship without)

```yaml
groups:
- name: syrotp
  rules:
  - alert: SyrotpReceiverStaleHeartbeat
    expr: syrotp_receiver_heartbeat_age_seconds > 300
    for: 2m
    annotations:
      summary: "Receiver {{ $labels.receiver_id }} hasn't heartbeat in 5+ minutes"
      runbook: "Check the gateway device and `pnpm syrotp receiver list`"

  - alert: SyrotpInboundMatchRateDrop
    expr: |
      (
        sum(rate(syrotp_inbound_received_total{matched="true"}[5m]))
        /
        sum(rate(syrotp_inbound_received_total[5m]))
      ) < 0.5
    for: 10m
    annotations:
      summary: "Less than 50% of inbound SMS are matching pending verifications"
      runbook: "Likely a code-prefix / clock-skew / receiver-routing change"

  - alert: SyrotpHmacRejectsSpike
    expr: sum(rate(syrotp_hmac_rejected_total[5m])) > 1
    for: 5m
    annotations:
      summary: "HMAC rejects > 1/s — gateway misconfiguration or attack"
      runbook: "Group by reason: `sum by (reason) (rate(syrotp_hmac_rejected_total[5m]))`"
```

A clean SYROTP deployment sees zero `hmac_rejected_total` activity in
steady state — every spike means either a gateway is misconfigured or
an attacker is probing the inbound endpoint.

Each of these alerts has a dedicated runbook (triage steps, common
causes, fixes) in [`operations.md`](operations.md). When the alert
fires, point on-call at that page first.

## Operational notes

- **Cardinality discipline**: we never label by phone number,
  verification id, IP, or anything user-controlled. The full label set
  per metric is enumerated above; a PR adding a new label runs through
  this doc as part of review.
- **Reset semantics**: `syrotp_receiver_heartbeat_age_seconds` resets
  the gauge family on every refresh, so a deleted receiver's series
  doesn't linger forever.
- **Scrape interval**: 15s is fine. The receiver gauge refresh runs
  every 30s; histograms and counters update on every request.
- **Storage**: at expected fleet size and 15s scrape, this exposition
  is < 5KB per scrape. No cardinality concerns.
