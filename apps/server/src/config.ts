import { z } from "zod";

const HEX64 = /^[0-9a-fA-F]{64}$/;

// --- Proxy allowlist parsing -----------------------------------------------
// We accept a comma-separated list of either:
//   - a single IPv4 / IPv6 host  ("127.0.0.1", "::1")
//   - a CIDR block               ("10.0.0.0/8", "fd00::/8")
// Fastify's `trustProxy` accepts an array of these strings and validates IPs
// per-request via proxy-addr; we only need to weed out malformed entries up
// front so an operator typo doesn't silently degrade to "trust nobody".
// (No new dependency — the regex pair below is intentionally narrow.)

const IPV4_OCTET = "(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)";
const IPV4_RE = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`);
// Permissive but bounded IPv6 matcher — accepts compressed form (::), full
// form, and IPv4-mapped tail. Real validation happens inside proxy-addr;
// this just rejects obvious garbage like "hello".
const IPV6_RE = /^[0-9a-fA-F:]+(?:\.[0-9]{1,3}){0,3}$/;

function isValidProxyEntry(raw: string): boolean {
  const [host, maskStr, ...rest] = raw.split("/");
  if (rest.length > 0) return false; // more than one "/" — malformed
  if (!host) return false;

  if (IPV4_RE.test(host)) {
    if (maskStr === undefined) return true;
    const m = Number(maskStr);
    return Number.isInteger(m) && m >= 0 && m <= 32;
  }
  if (IPV6_RE.test(host) && host.includes(":")) {
    if (maskStr === undefined) return true;
    const m = Number(maskStr);
    return Number.isInteger(m) && m >= 0 && m <= 128;
  }
  return false;
}

function parseTrustedProxies(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  MASTER_ENCRYPTION_KEY: z.string().regex(HEX64, "must be 64 hex chars (32 bytes)"),
  COOKIE_SECRET: z.string().regex(HEX64, "must be 64 hex chars (32 bytes)"),

  VERIFICATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
  VERIFICATION_CODE_LENGTH: z.coerce.number().int().min(4).max(12).default(6),
  MAX_PENDING_PER_PHONE: z.coerce.number().int().min(1).max(20).default(3),
  MAX_PENDING_PER_IP: z.coerce.number().int().min(1).max(100).default(10),

  RATE_LIMIT_START_PER_IP_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_STATUS_PER_IP_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_INBOUND_PER_RECEIVER_PER_MIN: z.coerce.number().int().min(1).default(120),

  // v1.0.1 — coarse pre-HMAC per-source-IP shedding on the inbound +
  // heartbeat endpoints. The receiverId on those routes comes from an
  // attacker-controllable header / path param, so we MUST NOT key a
  // rate-limit bucket by it before HMAC verification (otherwise an
  // attacker can flood Redis with bogus rcv_* keys, DoS specific
  // receivers, or rotate ids to bypass a per-receiver bucket). The
  // per-IP guard is cheap garbage-traffic shedding that runs BEFORE
  // the HMAC math; the per-receiver + per-app buckets only run on
  // traffic that already cleared HMAC.
  RATE_LIMIT_INBOUND_PER_IP_PER_MIN: z.coerce.number().int().min(1).default(600),
  // Heartbeats are once-per-60s by design (next_heartbeat_seconds =
  // RECEIVER_HEARTBEAT_TIMEOUT_SECONDS / 2). 6/min per verified
  // receiver gives ~10x headroom for clock skew / retries while still
  // capping a misbehaving client.
  RATE_LIMIT_HEARTBEAT_PER_RECEIVER_PER_MIN: z.coerce.number().int().min(1).default(6),

  // v0.8 PR #38 — per-app rate limits stack on top of the
  // per-IP / per-receiver buckets above. Both must pass; the
  // per-IP / per-receiver guard runs first (cheap, narrow), the
  // per-app bucket second. Defaults are generous for legit
  // multi-IP traffic but tight enough that a runaway app gets
  // clamped before it drowns the rest of the tenants.
  RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(500),
  RATE_LIMIT_INBOUND_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(1000),
  RATE_LIMIT_BINDINGS_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(60),

  // v1.0.1 — per-app rate limits on the remaining `sk_live_*`-gated
  // surface. A leaked secret key with no ceiling here would let an
  // attacker amplify destructive actions (mass cancel, webhook churn,
  // binding revoke storms, WebAuthn ceremony enumeration) at unlimited
  // rates against a single tenant. Each endpoint family gets its own
  // bucket so a spike on one surface doesn't starve the others.
  //
  // `SK_LIVE_PER_APP_PER_MIN` is the generic fallback default for any
  // future `sk_live_*` route that doesn't carry its own specific
  // config. Specific endpoints below pick tighter ceilings tuned to
  // their blast radius — destructive writes get 30/min, pollable
  // reads get 60/min.
  RATE_LIMIT_SK_LIVE_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_CANCEL_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WEBHOOK_CRUD_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_BINDING_READ_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_BINDING_REVOKE_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_WEBAUTHN_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(30),

  RECEIVER_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(120),
  INBOUND_TIMESTAMP_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

  CORS_ORIGINS: z.string().default(""),
  // Legacy boolean. Kept for backward compatibility with existing
  // deployments. When `true` the server will honour X-Forwarded-* for
  // req.ip — but ONLY from the proxies listed in `TRUSTED_PROXIES`.
  // In production, setting this `true` without `TRUSTED_PROXIES`
  // refuses to boot (see post-parse check below). In dev it boots
  // with a warning.
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Comma-separated list of IPs / CIDR blocks the reverse proxy(ies)
  // sit on. Any X-Forwarded-* header arriving from outside this set
  // is ignored, so an attacker on the public Internet cannot spoof
  // req.ip to bypass per-IP rate limits on /v1/verifications or
  // /v/:id/status. Examples:
  //   127.0.0.1
  //   10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
  //   ::1,fd00::/8
  TRUSTED_PROXIES: z
    .string()
    .default("")
    .superRefine((raw, ctx) => {
      const entries = parseTrustedProxies(raw);
      for (const e of entries) {
        if (!isValidProxyEntry(e)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `invalid IP/CIDR entry: ${JSON.stringify(e)}`,
          });
        }
      }
    }),

  DEFAULT_PHONE_REGION: z.string().default("SY"),

  // Admin dashboard. BOTH must be set for /admin/* to be exposed at all;
  // an unset hash means the entire admin surface stays unmounted (404).
  // The hash format is `scrypt$<saltHex>$<derivedKeyHex>` — see
  // src/admin/web/passwords.ts and the syrotp:admin-password-hash helper.
  ADMIN_USER: z.string().min(1).optional(),
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt\$[0-9a-fA-F]{16,128}\$[0-9a-fA-F]{32,256}$/, "must be `scrypt$<saltHex>$<hashHex>`")
    .optional(),

  // Per-IP throttle on /admin/* that runs BEFORE Basic Auth. Each
  // scrypt verification costs ~50ms of CPU; without this cap a
  // modest attack rate (~10-20 req/s) would starve the event loop
  // even after we made scrypt async (the work still consumes a
  // thread-pool slot). 10 attempts per IP per 5 minutes is generous
  // for legitimate operator logins (browsers retry once on 401, ops
  // scripts hit /admin/abuse-signals a handful of times per shift)
  // but stops automated brute-forcers before they ever reach the
  // password compare.
  RATE_LIMIT_ADMIN_PER_IP_PER_5MIN: z.coerce.number().int().min(1).default(10),

  // Hosted verification page (`/v/:id` + `/v/:id/status`). Public —
  // no auth required, anyone with the verification id can view.
  // Default ON; set to "false" to refuse the routes (every probe 404s).
  // The page never shows the user's full phone, the api_key, or any
  // server-internal detail. The polling JSON is even leaner —
  // status + timestamps only.
  HOSTED_PAGE_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // Webhook delivery worker. Runs in-process behind a periodic timer;
  // disable by setting "false" if you operate a dedicated worker
  // process or aren't using webhooks at all (the CRUD endpoints stay
  // up either way — events still queue, just don't get delivered).
  WEBHOOK_WORKER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

  // SSRF guard escape hatch. The integration suite spins up an
  // `http.createServer` on 127.0.0.1 and points webhooks at it — the
  // production guard would refuse those URLs by design. This flag is
  // honoured ONLY when NODE_ENV=test (see post-parse check below);
  // a production deployment cannot bypass the SSRF guard even by
  // setting it explicitly.
  WEBHOOK_ALLOW_PRIVATE_FOR_TESTS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

  // WebAuthn fallback (DISABLED BY DEFAULT). When off, all
  // /v1/webauthn/* routes 404 — there's no auth surface to attack.
  // When on, the four register/login endpoints become available
  // behind sk_live_* keys; the service uses @simplewebauthn/server
  // for attestation/assertion verification.
  WEBAUTHN_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  // Relying Party id — the eTLD+1 the credential is bound to. MUST
  // match (or be a parent of) the page origin that initiates the
  // ceremony, per the WebAuthn spec. Required when WEBAUTHN_ENABLED.
  WEBAUTHN_RP_ID: z.string().min(1).max(253).optional(),
  // Relying Party display name — shown in some browser UIs. Falls
  // back to RP_ID when unset.
  WEBAUTHN_RP_NAME: z.string().min(1).max(64).optional(),
  // Comma-separated origin allowlist. Every assertion / attestation
  // response carries the origin it was created on; we reject any
  // origin not in this list.
  WEBAUTHN_ORIGINS: z.string().default(""),
  WEBAUTHN_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
  // Optional URL the hosted verification page links to as
  // "use a passkey instead". When unset, no link appears. The page
  // does NOT inline the WebAuthn flow itself in v0.5 — that's the
  // host app's responsibility.
  WEBAUTHN_FALLBACK_URL: z.string().url().optional(),

  // Phone-binding ceremony (v0.8 PR #36). The TTL controls how long
  // a `pending` binding row stays valid before the developer has to
  // restart the ceremony. 5 min is enough for the user to switch
  // tabs, copy the SMS body, and send it; longer windows just widen
  // the nonce-reuse risk surface.
  PHONE_BINDING_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Surface every problem at once so ops can fix one .env, not five.
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`[syrotp] invalid configuration:\n${issues}`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

// Pre-computed list of trusted proxy IPs / CIDRs. Empty when none are
// configured. Consumed by `buildApp()` to derive Fastify's `trustProxy`
// option — array form ensures Fastify only honours X-Forwarded-* from
// these hops, never from arbitrary upstream clients.
export const trustedProxies: readonly string[] = Object.freeze(
  parseTrustedProxies(config.TRUSTED_PROXIES),
);

// Refuse to boot in production with placeholder secrets.
if (config.NODE_ENV === "production") {
  const placeholders = [
    "replace_me_with_64_hex_chars_dev_only_do_not_use_in_production00",
  ];
  if (
    placeholders.includes(config.MASTER_ENCRYPTION_KEY) ||
    placeholders.includes(config.COOKIE_SECRET)
  ) {
    console.error("[syrotp] refusing to start in production with default secrets");
    process.exit(1);
  }

  // Refuse to boot in production with the SSRF escape hatch armed.
  // The flag exists strictly for the integration suite (which targets
  // 127.0.0.1 receivers); turning it on in prod would let any webhook
  // CRUD caller point an endpoint at the cloud metadata service or an
  // internal admin URL.
  if (config.WEBHOOK_ALLOW_PRIVATE_FOR_TESTS) {
    console.error(
      "[syrotp] refusing to start: WEBHOOK_ALLOW_PRIVATE_FOR_TESTS must " +
        "not be set in production. The flag exists only for the test " +
        "suite and disables the webhook SSRF guard entirely.",
    );
    process.exit(1);
  }

  // Refuse to boot in production with a wide-open proxy trust. Without an
  // allowlist Fastify would honour X-Forwarded-For from ANY upstream peer,
  // letting an attacker spoof req.ip and bypass every per-IP rate limit
  // (verification start, status polling, inbound). Operators MUST pin the
  // proxy hop(s) explicitly. See docs/operations.md for examples.
  if (config.TRUST_PROXY && trustedProxies.length === 0) {
    console.error(
      "[syrotp] refusing to start: TRUST_PROXY=true requires TRUSTED_PROXIES " +
        "to be set to the IP(s) / CIDR(s) of the reverse proxy in front of " +
        "the server (e.g. TRUSTED_PROXIES=10.0.0.0/8). Without it, " +
        "X-Forwarded-For is honoured from any peer and per-IP rate limits " +
        "can be bypassed.",
    );
    process.exit(1);
  }
}
