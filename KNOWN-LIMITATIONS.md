# Known limitations — v0.1.0

A frank list of what SYROTP doesn't do yet, and what it won't do by design.

## Platform

- **The Android gateway had never been built from a clean checkout.** Four
  things were missing or wrong and each stopped the build or the app: no
  `gradle.properties` (AndroidX not enabled), no launcher icon, no theme (the
  activity is an `AppCompatActivity` and crashed on launch), and an
  unconditional `setIsStrongBoxBacked()` outside its own try/catch that crashed
  pairing on any device whose framework lacks the method. All four are fixed;
  the lesson is that nothing in CI compiles this module, so the next such
  regression will also ship silently.

- **iOS cannot run a receiver gateway.** Apple's sandbox does not permit
  programmatic SMS reading. iOS apps can still be **clients** of SYROTP via
  the SDK; they just can't be receivers.
- **Web cannot run a receiver gateway** for the same reason on a different
  axis — browsers have no SMS API.
- **Multi-SIM Android** is supported by the manifest but not actively
  tested in v0.1. The SIM slot is reported best-effort.

## Operational

- **No admin UI yet.** Provisioning apps, keys, and receivers is done via
  `dist/scripts/bootstrap.js` and `psql`. CLI + dashboard land in v0.2.
- **No metrics endpoint.** Operators rely on logs in v0.1. Prometheus
  scrape lands in v0.2.
- **No automated key rotation.** `MASTER_ENCRYPTION_KEY` rotation is a
  manual procedure: re-wrap every receiver's signing key, then update the
  env. Documented but not automated.
- **No webhook gateway.** Third-party inbound providers (e.g. Twilio
  inbound) are not pre-wired. Planned v0.4.
- **One receiver per inbound match.** Routing across multiple receivers for
  the same app exists in DB shape but isn't load-balanced beyond
  pending-count selection. Production deployments with >1 receiver should
  be tested carefully.

## Security model

- **Compromised gateway = forged inbound.** A device with a valid signing
  key can claim *any* verification by submitting an inbound that purports
  to come from the right phone. Mitigation: rotate signing keys, revoke
  receivers, and (future work) pin signing keys to the device's
  hardware-backed keystore so the key cannot be exfiltrated.
- **Compromised master key + DB = full access.** This is the union of two
  separate breach vectors. Keep `MASTER_ENCRYPTION_KEY` in a secret
  manager, not on disk alongside the DB backup.
- **No abuse signals beyond rate limits.** v0.1 enforces per-IP and
  per-receiver caps, and a per-phone pending cap. There is no velocity
  scoring, ASN reputation, or device fingerprinting. Run SYROTP behind a
  WAF / CDN with bot management for high-risk surfaces.
- **Public-key origin checks are out of scope.** Browser-embedded `pk_live_*`
  keys are accepted from any origin the proxy CORS allowlist permits.
  v0.1 does not bind a key to a Referer/Origin pair. If you need that,
  enforce it at your reverse proxy.

## Protocol

- **Codes are stored as plaintext** in the verifications table during
  their TTL. Matching requires a queryable form, and the row is short-
  lived. A DB-only breach during the TTL window could yield active codes
  paired with phones — but the attacker would still need to send SMS from
  the matching phone to actually verify (the sender check protects this).
  We accept this as a deliberate trade-off for v0.1.
- **No signed audit log chain.** The `audit_log` table is append-only by
  convention but not cryptographically chained. Tamper-evidence is on the
  v1.0 list.
- **No replay protection on the developer-side endpoints.** `pk_live_`
  and `sk_live_` calls rely on TLS + bearer auth. Idempotency keys for
  `POST /v1/verifications` could be added if needed.
- **No protocol-level encryption beyond TLS.** The bearer tokens and JSON
  bodies are protected by the transport. Operators are responsible for
  enforcing TLS 1.2+ at the proxy.

## Performance

- **Untested at scale.** The shape is designed for thousands of
  verifications per minute on a small VM. Large deployments should run
  load tests before promising SLAs.
- **Rate limits use fixed-window counters.** Slightly more permissive at
  bucket boundaries than a sliding window. Acceptable for abuse caps;
  upgrade to a sliding window if you need precise enforcement.
- **Single Redis instance.** No Sentinel / Cluster support is wired in.
  Failure of Redis fails open on rate limits and fails closed on replay
  guards (because nonce SET NX returns nil on a down server, which we
  treat as "could not record" → safer to reject).

## Compliance

- **No GDPR helpers.** Phone numbers are stored E.164. Erasure / export
  is a manual SQL job. v1.0 will include opt-in retention windows.
- **No PCI/SOC2 attestation.** SYROTP is open source — your *deployment*
  may achieve compliance, the codebase itself does not carry an
  attestation.

---

If something here is a blocker for you, open an issue and tell us your
threat model — many items are easy wins once we know they're load-bearing
for a real deployment.
