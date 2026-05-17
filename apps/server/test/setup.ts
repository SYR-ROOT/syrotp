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
// v0.8 PR #38 — per-app buckets default high so other suites
// don't trip them. The dedicated RA-canary tests pre-fill the
// counter directly to assert 429.
process.env.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_INBOUND_PER_APP_PER_MIN ??= "1000";
process.env.RATE_LIMIT_BINDINGS_PER_APP_PER_MIN ??= "1000";
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

// Default-on for the test app so the WebAuthn routes are mounted.
// The dedicated "disabled" test rebuilds a fresh app with this
// flipped off. The library's verify functions are stubbed via
// `services/webauthn.__testing.setVerifier(...)` — we don't need
// real authenticator crypto in CI.
process.env.WEBAUTHN_ENABLED ??= "true";
process.env.WEBAUTHN_RP_ID ??= "syrotp.test";
process.env.WEBAUTHN_ORIGINS ??= "http://syrotp.test,http://localhost:3000";
process.env.WEBAUTHN_CHALLENGE_TTL_SECONDS ??= "60";
