/**
 * Read the CLI's own version from its package.json. We can't `import`
 * package.json directly without `resolveJsonModule` and a different
 * runtime path; reading from disk is robust across tsx / node / npm
 * global install.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export async function readVersion(): Promise<string> {
  // Look at ../../package.json from this file (src or dist), and once more
  // up if needed — covers both running from source via tsx and from dist
  // after build. We never want this to throw.
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    try {
      const raw = await readFile(candidate, "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "@syrotp/cli" && typeof pkg.version === "string") {
        return pkg.version;
      }
    } catch {
      /* try next */
    }
  }
  return "0.0.0-unknown";
}
