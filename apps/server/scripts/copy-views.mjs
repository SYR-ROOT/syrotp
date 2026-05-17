#!/usr/bin/env node
/**
 * Postbuild step: tsc only compiles .ts. Eta templates (admin
 * dashboard) live alongside the source and need to be copied into
 * dist/ so production deploys (which ship only dist/) can find them.
 *
 * Cross-platform — uses fs.cp recursive (Node 16.7+).
 */
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const pairs = [
  // admin dashboard templates
  [join(root, "src", "admin", "views"), join(root, "dist", "admin", "views")],
  // hosted verification page templates (v0.5)
  [join(root, "src", "hosted", "views"), join(root, "dist", "hosted", "views")],
];

for (const [src, dst] of pairs) {
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`[postbuild] copied ${src} → ${dst}`);
}
