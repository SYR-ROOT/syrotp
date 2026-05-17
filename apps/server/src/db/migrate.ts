/**
 * Minimal forward-only migration runner.
 *
 * Each .sql file in /migrations runs once, in lexicographic order.
 * Successful runs are recorded in `_syrotp_migrations`. We do NOT support
 * down migrations — destructive ops should be a new forward migration
 * instead, so prod recovery is always "go forward."
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "..", "migrations");

async function main() {
  const sql = postgres(config.DATABASE_URL, { max: 1 });

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "_syrotp_migrations" (
      "name" text PRIMARY KEY,
      "applied_at" timestamptz NOT NULL DEFAULT now(),
      "checksum" text NOT NULL
    );
  `);

  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const applied = await sql`SELECT name FROM _syrotp_migrations WHERE name = ${file}`;
    if (applied.length > 0) {
      console.log(`[migrate] skip ${file} (already applied)`);
      continue;
    }

    const body = await readFile(join(migrationsDir, file), "utf8");
    // Wrap in a transaction so a half-applied migration never sticks.
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`
        INSERT INTO _syrotp_migrations (name, checksum)
        VALUES (${file}, ${simpleHash(body)})
      `;
    });
    console.log(`[migrate] applied ${file}`);
  }

  await sql.end({ timeout: 5 });
  console.log("[migrate] done");
}

function simpleHash(s: string): string {
  // FNV-1a 32-bit — fine for change-detection records, not security.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
