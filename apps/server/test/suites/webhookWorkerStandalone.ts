/**
 * Suite: standalone webhook delivery worker (v0.9 PR #41).
 *
 * Pins the contract that `apps/server/src/workers/webhook.ts` works
 * end-to-end as its own OS process: spawn it as a child of the test
 * harness, queue exactly one webhook delivery via the same fixture
 * helpers the in-process worker tests use, wait until the test
 * receiver gets the POST, send SIGTERM, assert the child exits 0
 * within a bounded timeout.
 *
 * Why a child process and not just `runOnce()`: the in-process
 * suite (`webhookWorker.ts`) covers the worker class itself. This
 * suite covers the *entrypoint* — that the standalone process
 * actually wires logger + db + worker + signal handlers correctly
 * and handles graceful shutdown.
 *
 *   WS1   spawn → queue 1 delivery → child delivers it → SIGTERM →
 *         child exits 0 within timeout
 *   WS2   refuses to start when WEBHOOK_WORKER_ENABLED=false (exits 2)
 *
 * Bounded timeouts: WS1 caps at 20s (covers tsx cold-start + first
 * tick + delivery + graceful drain), WS2 at 10s. Each test owns the
 * full lifecycle so a hang in one doesn't poison the next suite.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";
import { startTestReceiver, type TestReceiver } from "../helpers/webhookReceiver.js";

const SERVER_DIR = path.resolve(import.meta.dirname, "..", "..");
const WORKER_ENTRY = path.join(SERVER_DIR, "src", "workers", "webhook.ts");
// Spawn `node --import tsx <entry>`. We avoid the `node_modules/.bin/tsx`
// shim because Node 20 refuses to spawn `.cmd`/`.bat` shims without
// `shell: true`, and `shell: true` complicates signal forwarding under
// SIGTERM. `process.execPath` is the same node binary running the test.

interface SpawnedWorker {
  child: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stdoutChunks: string[];
  stderrChunks: string[];
}

function spawnWorker(envOverrides: NodeJS.ProcessEnv = {}): SpawnedWorker {
  // Inherit the test process env (so test DB / redis URLs match), then
  // pin the loop interval so a queued delivery is picked up within
  // seconds rather than the production default of 5s. The
  // standalone worker reads the same `config` schema as the API.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WEBHOOK_WORKER_INTERVAL_MS: "200",
    WEBHOOK_WORKER_ENABLED: "true",
    LOG_LEVEL: "warn",
    ...envOverrides,
  };

  const child = spawn(
    process.execPath,
    ["--import", "tsx", WORKER_ENTRY],
    {
      cwd: SERVER_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Detached: false so the child shares the parent's process group
      // and dies if the test harness is killed.
      shell: false,
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout?.on("data", (b: Buffer) => stdoutChunks.push(b.toString("utf8")));
  child.stderr?.on("data", (b: Buffer) => stderrChunks.push(b.toString("utf8")));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );

  return { child, exited, stdoutChunks, stderrChunks };
}

async function killAndWait(
  worker: SpawnedWorker,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    return await worker.exited;
  }
  worker.child.kill(signal);
  const result = await Promise.race([
    worker.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (result === null) {
    // Hard kill — graceful shutdown didn't happen in time.
    worker.child.kill("SIGKILL");
    await worker.exited;
  }
  return result;
}

async function pollForRequest(
  recv: TestReceiver,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (recv.requests.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function registerEndpoint(secretKey: string, url: string): Promise<void> {
  const app = await getTestApp();
  const r = await app.inject({
    method: "POST",
    url: "/v1/webhooks",
    headers: { authorization: `Bearer ${secretKey}` },
    payload: { url, event_types: ["verification.verified"] },
  });
  assert.equal(r.statusCode, 201, `create webhook failed: ${r.body}`);
}

async function emitVerifiedEvent(
  fxPublicKey: string,
  fxReceiverId: string,
  fxSigningKey: string,
  fxReceiverMsisdn: string,
): Promise<void> {
  const app = await getTestApp();
  const start = await app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${fxPublicKey}` },
    payload: { phone: "0991234567", purpose: "login" },
  });
  const v = start.json();
  const body = inboundBody({
    from: "+963991234567",
    to: fxReceiverMsisdn,
    body: v.message,
  });
  const headers = signGateway(fxReceiverId, fxSigningKey, body);
  const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
  assert.equal(r.statusCode, 202);
}

describe("standalone webhook worker (v0.9 PR #41)", () => {
  let liveWorker: SpawnedWorker | null = null;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  afterEach(async () => {
    // Defensive: if a test bailed without killing the child, kill it now
    // so the next test's beforeEach reset doesn't race a still-running
    // worker that's holding rows under a soft lease.
    if (liveWorker) {
      await killAndWait(liveWorker, "SIGKILL", 5_000);
      liveWorker = null;
    }
  });

  // ----- WS1: end-to-end with a child process ------------------------

  it("WS1: spawned worker delivers a queued webhook end-to-end and exits 0 on SIGTERM", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      // Queue is primed before we spawn — the standalone worker has
      // a row to claim on its very first tick.
      const worker = spawnWorker();
      liveWorker = worker;

      const got = await pollForRequest(recv, 18_000);
      assert.equal(
        got,
        true,
        `standalone worker never delivered the queued webhook (stderr=${worker.stderrChunks.join(
          "",
        )})`,
      );
      assert.equal(recv.requests.length, 1, "exactly one delivery expected");

      const result = await killAndWait(worker, "SIGTERM", 10_000);
      liveWorker = null;
      assert.notEqual(result, null, "worker did not exit within 10s of SIGTERM");
      if (process.platform === "win32") {
        // Node maps child.kill('SIGTERM') to TerminateProcess() on
        // Windows, which is a hard-kill — JS signal handlers never run.
        // The graceful-shutdown contract is only verifiable on POSIX;
        // here we settle for proving the child was terminated by our
        // kill() (and didn't crash earlier).
        assert.ok(
          result!.signal === "SIGTERM" || result!.code === 0,
          `expected SIGTERM-terminated or graceful exit, got code=${result!.code} signal=${result!.signal}`,
        );
      } else {
        assert.equal(
          result!.code,
          0,
          `worker exited non-zero: code=${result!.code} signal=${result!.signal}`,
        );
      }
    } finally {
      await recv.close();
    }
  });

  // ----- WS2: env-flag misuse fails fast ------------------------------

  it("WS2: refuses to start when WEBHOOK_WORKER_ENABLED=false (exit 2)", async () => {
    const worker = spawnWorker({ WEBHOOK_WORKER_ENABLED: "false" });
    liveWorker = worker;

    const result = await Promise.race([
      worker.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
    liveWorker = null;
    assert.notEqual(result, null, "worker did not exit within 8s");
    assert.equal(
      result!.code,
      2,
      `expected exit code 2 (operator misconfig), got code=${result!.code}`,
    );
    assert.match(
      worker.stderrChunks.join("") + worker.stdoutChunks.join(""),
      /WEBHOOK_WORKER_ENABLED=false/,
      "expected error message mentioning the misconfigured flag",
    );
  });
});
