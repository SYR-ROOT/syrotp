import { z } from "zod";

const HEX64 = /^[0-9a-fA-F]{64}$/;

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

  // v0.8 PR #38 — per-app rate limits stack on top of the
  // per-IP / per-receiver buckets above. Both must pass; the
  // per-IP / per-receiver guard runs first (cheap, narrow), the
  // per-app bucket second. Defaults are generous for legit
  // multi-IP traffic but tight enough that a runaway app gets
  // clamped before it drowns the rest of the tenants.
  RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(500),
  RATE_LIMIT_INBOUND_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(1000),
  RATE_LIMIT_BINDINGS_PER_APP_PER_MIN: z.coerce.number().int().min(1).default(60),

  RECEIVER_HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().int().min(30).default(120),
  INBOUND_TIMESTAMP_SKEW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

  CORS_ORIGINS: z.string().default(""),
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),

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
}
