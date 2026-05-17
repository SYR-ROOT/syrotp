#!/usr/bin/env node
/**
 * `syrotp` — top-level dispatcher.
 *
 * The switch on `parsed.command` is intentionally exhaustive on the union
 * type so adding a new command requires updating `parseTopLevel` AND this
 * switch — TypeScript catches drift.
 */
import { parseFlags, parseTopLevel } from "./argv.js";
import { CliError, usage } from "./errors.js";
import { EXIT } from "./exit.js";
import { helpText } from "./help.js";
import { reportError, reportUnexpected } from "./render.js";
import { readVersion } from "./version.js";
import { runDoctor } from "./commands/doctor.js";
import { runBootstrap } from "./commands/bootstrap.js";
import { runReceiver } from "./commands/receiver.js";
import { runSmoke } from "./commands/smoke.js";
import { runLoadtest } from "./commands/loadtest.js";

export interface MainOptions {
  /** Where stdout-style output goes. Default: process.stdout. */
  out?: NodeJS.WritableStream;
}

export async function main(
  argv: ReadonlyArray<string>,
  opts: MainOptions = {},
): Promise<number> {
  const out = opts.out ?? process.stdout;
  const parsed = parseTopLevel(argv);

  switch (parsed.command) {
    case "help":
      out.write(helpText(parsed.helpTopic));
      return EXIT.OK;

    case "version": {
      const v = await readVersion();
      out.write(`syrotp ${v}\n`);
      return EXIT.OK;
    }

    case "doctor": {
      const flags = parseFlags(parsed.rest, {
        flags: {
          "env-file": { value: true },
          "timeout": { value: true },
          help: { value: false, alias: "h" },
        },
      });
      if (flags.unknown) {
        throw usage(`unknown flag: ${flags.unknown}`, "run `syrotp help doctor` for usage");
      }
      if (flags.values.help) {
        out.write(helpText("doctor"));
        return EXIT.OK;
      }
      const timeoutRaw = flags.values["timeout"];
      const timeoutMs =
        typeof timeoutRaw === "string" ? Number.parseInt(timeoutRaw, 10) : undefined;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        throw usage(`--timeout must be a positive integer (got: ${timeoutRaw})`);
      }
      const envFile =
        typeof flags.values["env-file"] === "string" ? flags.values["env-file"] : undefined;
      return runDoctor({ envFile, timeoutMs, out });
    }

    case "bootstrap":
      return runBootstrap({ args: parsed.rest, out });

    case "receiver":
      return runReceiver({ args: parsed.rest, out });

    case "smoke":
      return runSmoke({ args: parsed.rest, out });

    case "loadtest":
      return runLoadtest({ args: parsed.rest, out });

    case "unknown":
      throw usage(
        `unknown command: ${parsed.unknownToken}`,
        "run `syrotp --help` to see available commands",
      );
  }
}

// -- entry point --------------------------------------------------------
//
// Auto-invoke main() only when this module IS the entry — i.e. the path
// the runtime started from. When tests `import { main }` from this file,
// argv[1] is the test file path, so the URL comparison fails and main()
// does NOT run on import.
import { fileURLToPath } from "node:url";

const isEntry =
  typeof process.argv[1] === "string" &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      if (err instanceof CliError) {
        reportError(err);
        process.exit(err.code);
      }
      reportUnexpected(err);
      process.exit(EXIT.RUNTIME);
    });
}
