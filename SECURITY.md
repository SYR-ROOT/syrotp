# Security

## Reporting a vulnerability

Please **do not** open public GitHub issues for security problems. Instead, open a private security advisory at <https://github.com/SYR-ROOT/syrotp/security/advisories/new> or email <info@mhd-shekho.com> (or use the operator address listed in your self-hosted deployment's `SECURITY.md`). We aim to respond within 72 hours.

Coordinated disclosure: we ask for 90 days before public details are posted, or sooner once a fix is shipped.

## Threat model

SYROTP is designed to be safe against the following adversaries:

| # | Attacker | Capability | Mitigated by |
|---|---|---|---|
| 1 | Network observer | Sees TLS-encrypted traffic | TLS 1.2+, no auth tokens in URLs, HSTS recommended at the proxy. |
| 2 | Replay attacker on inbound endpoint | Captures a valid signed request | Per-request `X-SYROTP-Nonce` is single-use (`SET NX EX` in Redis). Timestamps must be within `INBOUND_TIMESTAMP_SKEW_SECONDS`. |
| 3 | Forger of inbound SMS | Tries to verify a number they don't own | Inbound is signed with the gateway's signing key (HMAC-SHA256 over `ts.nonce.sha256(body)`). The server requires the sender phone in the matched DB row to equal the verification's target phone, so a stranger's SMS cannot be repurposed. |
| 4 | DB-only breach | Reads PostgreSQL contents | API keys are stored as HMAC(`MASTER_ENCRYPTION_KEY`, "api_key:" + raw); `MASTER_ENCRYPTION_KEY` is in env, not DB. Without it, the hashes are not invertible into raw keys. |
| 5 | Brute-force on verification code | Tries codes against a known phone | 6-char codes from a 31-char unambiguous alphabet (~887M space). 10-minute TTL. Rate limits per IP and concurrent-pending caps per phone. Even with optimal guessing, the expected hit rate is below 1 in 100k per pending window. Increase `VERIFICATION_CODE_LENGTH` for higher assurance. |
| 6 | Public-key abuse from browsers | Reads a `pk_live_*` from a website | Public keys can only start verifications and read masked status — they cannot cancel, list, or read internal fields. Tighten further by adding origin/referrer checks at the proxy. |
| 7 | Phone number enumeration | Probes whether a phone is registered | We never confirm/deny phone existence — `startVerification` always returns a fresh pending row regardless of any user state in the developer's app. |
| 8 | Side-channel timing on key compare | Distinguishes match from miss | All key/signature comparisons use `crypto.timingSafeEqual`. |

## Out of scope (by design)

- **Compromise of the user's phone or SIM**: If an attacker has your physical SIM, they can verify as you. This is the same property as traditional OTP and is unavoidable.
- **Compromise of the master key + DB simultaneously**: Yields full access. Store `MASTER_ENCRYPTION_KEY` in a real secret manager (AWS Secrets Manager, HashiCorp Vault, sealed-secrets, etc.) when running production.
- **Compromise of a gateway device**: The signing key on a paired Android gateway can post arbitrary inbound SMS to the API. Mitigation: revoke the receiver in the admin DB and rotate the signing key. Future work: per-message signing chains anchored to the device's hardware-backed keystore.

## Cryptographic primitives

| Use | Primitive |
|---|---|
| API key hashing | HMAC-SHA256 with `MASTER_ENCRYPTION_KEY` (deterministic so the column is indexable). |
| Gateway request auth | HMAC-SHA256 over `ts.nonce.sha256(body)`. |
| Verification codes | `crypto.randomInt` over a 31-char alphabet. |
| API key generation | 32 random bytes mapped into a 36-char alphabet (~187 effective bits). |
| Nonces | 16 bytes from `crypto.randomBytes`. |
| Constant-time compare | `crypto.timingSafeEqual`. |

We do not use bcrypt/argon2 for API keys because the keys themselves are uniformly random — they are not human-chosen secrets and cannot be guessed offline.

## Operator checklist (production)

- [ ] `MASTER_ENCRYPTION_KEY` and `COOKIE_SECRET` are 64-hex random and **not** the placeholder values.
- [ ] `NODE_ENV=production` (server refuses to boot with placeholder secrets in this mode).
- [ ] PostgreSQL is reachable only from the server (private network or `127.0.0.1` bind).
- [ ] Redis is reachable only from the server.
- [ ] TLS terminates at a reverse proxy (nginx, Caddy, Cloudflare). Set `TRUSTED_PROXIES` to the CIDR of the proxy (e.g. `10.0.0.0/8`) so `req.ip` reflects the real client. Production refuses to boot if `TRUST_PROXY=true` is set without a non-empty `TRUSTED_PROXIES` allowlist.
- [ ] HSTS, `X-Content-Type-Options: nosniff`, and a strict CSP for any HTML are set at the proxy.
- [ ] `CORS_ORIGINS` is an explicit allowlist, not `*`.
- [ ] Database backups are encrypted at rest, and `audit_log` retention is at least 90 days.
- [ ] `MASTER_ENCRYPTION_KEY` is in a secret manager, not on disk.
- [ ] You have a documented procedure for rotating `MASTER_ENCRYPTION_KEY` (currently: re-issue all API keys + receiver signing keys).
