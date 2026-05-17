/**
 * Shared subprocess helper for `syrotp smoke` / `syrotp loadtest` wrappers.
 *
 * Two responsibilities:
 *   1. Resolve Windows .cmd shims for `pnpm`/`npm` style binaries
 *      (execFile/spawn won't follow them without `shell: true`).
 *   2. Provide a `Spawner` interface that the real implementation honors
 *      and tests can stub. Tests do NOT spawn child processes — they
 *      inject a stub Spawner and assert on what was requested.
 */
import { spawn as childSpawn } from "node:child_process";

export interface SpawnRequest {
  cmd: string;
  args: ReadonlyArray<string>;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Extra env to merge over process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface Spawner {
  /**
   * Run a child process to completion. Stdout/stderr is forwarded to
   * the CLI's process so the user sees real-time output. Returns the
   * child's exit code (or 1 if it failed to start).
   */
  run(req: SpawnRequest): Promise<number>;
}

const isPnpm = (cmd: string): boolean => cmd === "pnpm" || cmd.endsWith("/pnpm") || cmd.endsWith("\\pnpm");

export const realSpawner: Spawner = {
  async run(req) {
    return new Promise<number>((resolve) => {
      // INIT_CWD is what pnpm/npm sets to the directory the user
      // invoked the script from, before workspace-filter chdir. With
      // `pnpm --filter @syrotp/cli start ...`, process.cwd() ends up
      // inside packages/cli/ — but `scripts/smoke.mjs` and pnpm scripts
      // like `loadtest:quick` live at the repo root. Default to
      // INIT_CWD so spawn'd children resolve repo-relative paths.
      const cwd = req.cwd ?? process.env.INIT_CWD ?? process.cwd();
      const child = childSpawn(req.cmd, [...req.args], {
        cwd,
        // Inherit so the user sees output exactly as if they ran the
        // underlying script directly. The CLI's own pretty messages
        // were already flushed before we got here.
        stdio: "inherit",
        env: { ...process.env, ...(req.env ?? {}) },
        // pnpm on Windows is a .cmd shim — must go through the shell.
        shell: process.platform === "win32" && isPnpm(req.cmd),
        windowsHide: true,
      });
      child.on("error", () => resolve(1));
      child.on("exit", (code, signal) => {
        if (typeof code === "number") resolve(code);
        else if (signal) resolve(1); // killed / aborted
        else resolve(1);
      });
    });
  },
};
