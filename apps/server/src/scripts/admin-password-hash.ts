/**
 * Helper for generating ADMIN_PASSWORD_HASH from a plaintext password.
 * Run once at provisioning time; paste the output into your secret
 * manager. The plaintext is never written anywhere.
 *
 * Usage:
 *   pnpm --filter @syrotp/server tsx src/scripts/admin-password-hash.ts
 *   (then type the password at the prompt — input is hidden)
 *
 * Or via the syrotp CLI (planned for v0.3 PR 4):
 *   syrotp admin password-hash
 */
import { createInterface } from "node:readline";
import { hashAdminPassword } from "../admin/web/passwords.js";

async function readPasswordHidden(prompt: string): Promise<string> {
  // Hide echo: muted Writable wrapping process.stdout. The standard
  // approach for terminal password prompts in Node CLIs.
  const stdout = process.stdout;
  const rl = createInterface({
    input: process.stdin,
    output: stdout,
    terminal: true,
  });
  // The MutableReadlineInterface trick: temporarily set _writeToOutput
  // so keystrokes don't echo. This is documented (if a bit tribal).
  const origWrite = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
  let printedPrompt = false;
  (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = (str: string) => {
    if (!printedPrompt) {
      stdout.write(str);
      printedPrompt = true;
    } else if (str.includes("\n") || str.includes("\r")) {
      stdout.write("\n");
    }
    // Otherwise: swallow each typed character.
  };
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    if (origWrite) {
      (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = origWrite;
    }
    rl.close();
  }
}

async function main(): Promise<void> {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const password = tty
    ? await readPasswordHidden("Admin password: ")
    : (await readNonTty()).trim();

  if (password.length < 12) {
    console.error("error: password must be at least 12 characters");
    process.exit(2);
  }
  const hash = hashAdminPassword(password);
  process.stdout.write(`\nADMIN_PASSWORD_HASH=${hash}\n\n`);
  process.stdout.write(
    `Add this and ADMIN_USER to your .env (or secret manager).\n` +
      `The plaintext password is NOT stored anywhere — keep it in your password manager.\n`,
  );
  process.exit(0);
}

async function readNonTty(): Promise<string> {
  // Allow piping: `echo -n 'mypwd' | tsx admin-password-hash.ts`
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
