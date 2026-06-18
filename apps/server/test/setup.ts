/**
 * Integration test setup — runs ONCE before any test code is loaded.
 *
 * IMPORTANT: this file MUST be imported before any module that reads
 * `process.env` (config.ts, db, redis, app). The test runner entry point
 * imports it first, and individual suite files import it at the top.
 *
 * Defaults assume `docker compose up -d postgres redis` is running.
 *   - Postgres test DB: syrotp_test on the same instance
 *   - Redis test DB:    redis://.../15  (kept separate from prod-shaped data)
 *
 * Override with env:
 *   DATABASE_URL_TEST, REDIS_URL_TEST, MASTER_ENCRYPTION_KEY_TEST,
 *   COOKIE_SECRET_TEST.
 */
import { randomBytes } from "node:crypto";

if (process.env.NODE_ENV !== "test") process.env.NODE_ENV = "test";

process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ??
  "postgres://syrotp:syrotp_dev_password@localhost:5432/syrotp_test";

process.env.REDIS_URL =
  process.env.REDIS_URL_TEST ?? "redis://localhost:6379/15";

process.env.MASTER_ENCRYPTION_KEY ??=
  process.env.MASTER_ENCRYPTION_KEY_TEST ?? randomBytes(32).toString("hex");
process.env.COOKIE_SECRET ??=
  process.env.COOKIE_SECRET_TEST ?? randomBytes(32).toString("hex");

// Generous limits so tests aren't flaky from rate caps. We have explicit
// rate-limit tests that override these per-test.
process.env.RATE_LIMIT_START_PER_IP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_STATUS_PER_IP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_INBOUND_PER_RECEIVER_PER_MIN ??= "1000";
// v1.0.1 — coarse pre-HMAC per-source-IP bucket on the inbound +
// heartbeat routes. Prod default is 600/min per IP; in tests all
// traffic comes from 127.0.0.1 so we'd trip the bucket across
// suites. Bumped high here; the dedicated FIX-3 regression test
// pre-fills this counter directly to assert 429.
process.env.RATE_LIMIT_INBOUND_PER_IP_PER_MIN ??= "10000";
// Heartbeat per-receiver cap — prod default is 6/min (heartbeats are
// once-per-60s by design). Bump it for tests so any suite that hits
// the heartbeat endpoint multiple times in a window doesn't 429.
process.env.RATE_LIMIT_HEARTBEAT_PER_RECEIVER_PER_MIN ??= "1000";
// v0.8 PR #38 — per-app buckets default high so other suites
// don't trip them. The dedicated RA-canary tests pre-fill the
// counter directly to assert 429.
process.env.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_INBOUND_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_BINDINGS_PER_APP_PER_MIN ??= "1000";
// v1.0.1 — per-app caps on the remaining sk_live_*-gated surface.
// Same rationale: pin high so suites that exercise these routes in
// loops (webhooks WH1-WH15, webauthn WA1-WA11, phone-bindings
// PB1-PB11, verification cancel T20) don't 429 spuriously. The
// dedicated regression tests for this fix pre-fill the counters
// directly to assert 429.
process.env.RATE_LIMIT_SK_LIVE_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_CANCEL_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_WEBHOOK_CRUD_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_BINDING_READ_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_BINDING_REVOKE_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_WEBAUTHN_PER_APP_PER_MIN ??= "1000";
// Admin per-IP throttle — see RATE_LIMIT_ADMIN_PER_IP_PER_5MIN in
// config.ts. Bumped high in the test environment so the suite's
// many /admin/* requests from 127.0.0.1 don't trip the prod-shaped
// 10/5min ceiling. Each test calls resetRedis() in beforeEach, so
// the bucket starts empty per test anyway — this raise is just a
// belt-and-braces for new tests.
process.env.RATE_LIMIT_ADMIN_PER_IP_PER_5MIN ??= "1000";
// 10 is enough headroom for the format-normalization test (T2, 5 variants
// against the same number) while still letting T14 exercise the cap.
process.env.MAX_PENDING_PER_PHONE ??= "10";
process.env.VERIFICATION_TTL_SECONDS ??= "600";
process.env.INBOUND_TIMESTAMP_SKEW_SECONDS ??= "300";
process.env.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS ??= "120";
process.env.LOG_LEVEL ??= "warn";

// Some tests assert on these; fix them so behavior is deterministic.
process.env.DEFAULT_PHONE_REGION = "SY";

// Disable the webhook worker's periodic timer so tests are
// deterministic. The worker is still constructed and decorated on
// the app — tests call `app.webhookWorker.runOnce()` directly when
// they want to exercise a delivery.
process.env.WEBHOOK_WORKER_ENABLED = "false";

// Tests point webhooks at `http://127.0.0.1:<port>` receivers and at
// made-up hostnames (`hooks.example.com` etc) that won't resolve in
// CI. Production rejects both via the SSRF guard; the test escape
// hatch turns the guard into a no-op. config.ts refuses to boot with
// this set when NODE_ENV=production.
process.env.WEBHOOK_ALLOW_PRIVATE_FOR_TESTS = "true";

// Default-on for the test app so the WebAuthn routes are mounted.
// The dedicated "disabled" test rebuilds a fresh app with this
// flipped off. The library's verify functions are stubbed via
// `services/webauthn.__testing.setVerifier(...)` — we don't need
// real authenticator crypto in CI.
process.env.WEBAUTHN_ENABLED ??= "true";
process.env.WEBAUTHN_RP_ID ??= "syrotp.test";
process.env.WEBAUTHN_ORIGINS ??= "http://syrotp.test,http://localhost:3000";
process.env.WEBAUTHN_CHALLENGE_TTL_SECONDS ??= "60";
