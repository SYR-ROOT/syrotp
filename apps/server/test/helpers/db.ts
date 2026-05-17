import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "..", "migrations");

/**
 * Creates the test database (idempotent), then applies all migrations.
 * Safe to call multiple times — the migrations runner skips applied files.
 */
export async function initTestDatabase(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  if (!dbName) throw new Error("DATABASE_URL has no database name");

  // Connect to the default 'postgres' DB to issue CREATE DATABASE if needed.
  const adminUrl = new URL(process.env.DATABASE_URL!);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (rows.length === 0) {
      // pg client refuses parameterized DDL — db name is validated above.
      await admin.unsafe(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Apply migrations on the test DB.
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS "_syrotp_migrations" (
        "name" text PRIMARY KEY,
        "applied_at" timestamptz NOT NULL DEFAULT now(),
        "checksum" text NOT NULL
      );
    `);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const applied = await sql`SELECT name FROM _syrotp_migrations WHERE name = ${file}`;
      if (applied.length > 0) continue;
      const body = await readFile(join(migrationsDir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO _syrotp_migrations (name, checksum) VALUES (${file}, 'test')`;
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Truncate every protocol table between tests. We deliberately keep the
 * `_syrotp_migrations` row so we don't re-run migrations on every reset.
 */
export async function resetDatabase(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql.unsafe(`
      TRUNCATE TABLE
        "audit_log",
        "phone_bindings",
        "webauthn_challenges",
        "webauthn_credentials",
        "webhook_deliveries",
        "webhook_events",
        "webhook_endpoints",
        "inbound_sms",
        "verifications",
        "api_keys",
        "receivers",
        "apps"
      RESTART IDENTITY CASCADE;
    `);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Read a single column / row from the test DB. Used by tests that need
 * to assert on stored shape (e.g. "code is wrapped, not plaintext").
 */
export async function rawQuery<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const rows = await sql.unsafe<T[]>(text, params as never);
    return rows;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
