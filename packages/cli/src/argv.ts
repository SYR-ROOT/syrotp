/**
 * Top-level argument parser. Intentionally simple — we don't pull in
 * commander/yargs because the CLI surface is small and we want zero
 * dependencies until something forces them.
 *
 * Supported shapes:
 *   syrotp                                    → help
 *   syrotp --help | -h | help [<topic>]       → help (optionally per-command)
 *   syrotp version | --version | -v
 *   syrotp doctor    [...]
 *   syrotp bootstrap [...]
 *   syrotp receiver  <add|list|disable|test> [...]
 */
export interface ParsedArgs {
  command:
    | "help"
    | "version"
    | "doctor"
    | "bootstrap"
    | "receiver"
    | "smoke"
    | "loadtest"
    | "unknown";
  rest: string[];
  /** When command === "unknown", the user's literal first arg. */
  unknownToken?: string;
  /** When command === "help", the topic the user asked help for, if any. */
  helpTopic?: string;
}

export function parseTopLevel(argv: ReadonlyArray<string>): ParsedArgs {
  if (argv.length === 0) return { command: "help", rest: [] };
  const [first, ...rest] = argv;
  switch (first) {
    case "-h":
    case "--help":
      return { command: "help", rest, helpTopic: rest[0] };
    case "help":
      return { command: "help", rest: rest.slice(1), helpTopic: rest[0] };
    case "-v":
    case "--version":
    case "version":
      return { command: "version", rest };
    case "doctor":
      return { command: "doctor", rest };
    case "bootstrap":
      return { command: "bootstrap", rest };
    case "receiver":
      return { command: "receiver", rest };
    case "smoke":
      return { command: "smoke", rest };
    case "loadtest":
      return { command: "loadtest", rest };
    default:
      return { command: "unknown", rest, unknownToken: first };
  }
}

/**
 * Parse a `--key value` style flag set without pulling util.parseArgs —
 * the latter rejects unknown flags noisily and we want to handle that
 * ourselves with a typed CliError.
 */
export interface FlagParseSpec {
  /** name → optional value? (true = takes a value, false = boolean) */
  flags: Record<string, { value: boolean; alias?: string }>;
}

export interface FlagParseResult {
  values: Record<string, string | true>;
  /** Positional args after flag parsing. */
  positionals: string[];
  /** First unknown token, if any. */
  unknown?: string;
}

export function parseFlags(argv: ReadonlyArray<string>, spec: FlagParseSpec): FlagParseResult {
  const values: Record<string, string | true> = {};
  const positionals: string[] = [];
  const aliasMap: Record<string, string> = {};
  for (const [name, def] of Object.entries(spec.flags)) {
    if (def.alias) aliasMap[def.alias] = name;
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith("--") || tok.startsWith("-")) {
      const isLong = tok.startsWith("--");
      let name = tok.replace(/^-+/, "");
      let inline: string | undefined;
      const eq = name.indexOf("=");
      if (eq >= 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!isLong && aliasMap[name]) name = aliasMap[name]!;
      const def = spec.flags[name];
      if (!def) return { values, positionals, unknown: tok };
      if (def.value) {
        const v = inline ?? argv[++i];
        if (v === undefined) return { values, positionals, unknown: tok };
        values[name] = v;
      } else {
        values[name] = true;
      }
      continue;
    }
    positionals.push(tok);
  }

  return { values, positionals };
}
