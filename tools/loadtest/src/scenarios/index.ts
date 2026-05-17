import { Client } from "../client.js";
import type { Fixtures } from "../env.js";
import { RunMetrics } from "../metrics.js";
import { runPool } from "../workers.js";
import { phoneFromIndex } from "../phone.js";
import {
  getVerification,
  pickReceiver,
  postInbound,
  record,
  startVerification,
} from "./common.js";

export interface ScenarioContext {
  scenario: string;
  total: number;
  workers: number;
  client: Client;
  fixtures: Fixtures;
  metrics: RunMetrics;
  /**
   * For scenario H — a hook the runner sets to a function that flips a
   * receiver to disabled mid-flight. No-op in other scenarios.
   */
  onMidpoint?: () => Promise<void>;
}

/** A => 1 receiver / 1000 verifications full-flow. */
export async function startOnly(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  await runPool(total, workers, async (i) => {
    const out = await startVerification(client, fixtures, phoneFromIndex(i));
    record(metrics.start, out);
  });
}

/** Full happy-path: start → inbound → status. */
export async function fullFlow(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers, onMidpoint } = ctx;
  let midpointFired = false;
  await runPool(total, workers, async (i) => {
    if (!midpointFired && onMidpoint && i >= Math.floor(total / 2)) {
      midpointFired = true;
      await onMidpoint().catch((e) => console.error("[onMidpoint]", e));
    }

    const phone = phoneFromIndex(i);
    const startOut = await startVerification(client, fixtures, phone);
    record(metrics.start, startOut);
    if (startOut.kind !== "ok") return;

    const startBody = startOut.body as { id: string; message: string; send_to: string };
    let receiver;
    try {
      receiver = pickReceiver(fixtures, startBody.send_to);
    } catch (err) {
      metrics.unhandled_exceptions++;
      console.error(err);
      return;
    }

    const inb = await postInbound(client, receiver, {
      from: phone,
      body: startBody.message,
      idempotencyKey: `lt_full_${i}`,
    });
    record(metrics.inbound, inb);
    if (inb.kind === "ok") {
      const body = inb.body as { matched?: boolean; reason?: string };
      if (body.matched) metrics.inbound.bumpExtra("matched");
      else metrics.inbound.bumpExtra(`no_match_${body.reason ?? "unknown"}`);
    }

    const stat = await getVerification(client, fixtures, startBody.id);
    record(metrics.status, stat);
    if (stat.kind === "ok") {
      const body = stat.body as { status: string };
      metrics.status.bumpExtra(`status_${body.status}`);
    }
  });
}

/** Inbound storm against pre-existing pending verifications. */
export async function inboundOnly(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  // We need pending verifications first. Pre-create one per inbound we're
  // about to send. Errors during pre-creation surface in metrics.start.
  const pending: { id: string; message: string; send_to: string; phone: string }[] = [];
  await runPool(total, Math.min(workers, 50), async (i) => {
    const phone = phoneFromIndex(i);
    const out = await startVerification(client, fixtures, phone);
    record(metrics.start, out);
    if (out.kind === "ok") {
      const body = out.body as { id: string; message: string; send_to: string };
      pending.push({ ...body, phone });
    }
  });

  await runPool(pending.length, workers, async (i) => {
    const v = pending[i]!;
    const receiver = pickReceiver(fixtures, v.send_to);
    const inb = await postInbound(client, receiver, {
      from: v.phone,
      body: v.message,
      idempotencyKey: `lt_inbound_${i}`,
    });
    record(metrics.inbound, inb);
    if (inb.kind === "ok") {
      const body = inb.body as { matched?: boolean };
      if (body.matched) metrics.inbound.bumpExtra("matched");
      else metrics.inbound.bumpExtra("no_match");
    }
  });
}

/** Status-polling storm. */
export async function statusPolling(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  // Create a small pool of verifications, then hammer status reads.
  const seedCount = 20;
  const seedIds: string[] = [];
  for (let i = 0; i < seedCount; i++) {
    const out = await startVerification(client, fixtures, phoneFromIndex(i));
    record(metrics.start, out);
    if (out.kind === "ok") seedIds.push((out.body as { id: string }).id);
  }
  if (seedIds.length === 0) {
    console.error("[scenario:statusPolling] failed to seed any verifications");
    return;
  }

  await runPool(total, workers, async (i) => {
    const id = seedIds[i % seedIds.length]!;
    const out = await getVerification(client, fixtures, id);
    // 429 is expected under storm — classify as expected so it doesn't
    // tank success rate. The TEST ASSERTION is that the system stays
    // responsive (no 5xx), not that every request returned 200.
    if (out.kind === "unexpected_4xx" && out.status === 429) {
      record(metrics.status, { ...out, kind: "expected_4xx" });
      metrics.status.bumpExtra("rate_limited");
    } else {
      record(metrics.status, out);
    }
  });
}

/** Mixed workload: 60% start+inbound full, 30% status, 10% start-only. */
export async function mixed(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  // Seed a handful of pending verifications for the polling slice.
  const seedIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const out = await startVerification(client, fixtures, phoneFromIndex(i + 1_000_000));
    record(metrics.start, out);
    if (out.kind === "ok") seedIds.push((out.body as { id: string }).id);
  }

  await runPool(total, workers, async (i) => {
    const dice = i % 10;
    if (dice < 6) {
      // full flow
      const phone = phoneFromIndex(i);
      const start = await startVerification(client, fixtures, phone);
      record(metrics.start, start);
      if (start.kind !== "ok") return;
      const startBody = start.body as { id: string; message: string; send_to: string };
      const receiver = pickReceiver(fixtures, startBody.send_to);
      const inb = await postInbound(client, receiver, {
        from: phone,
        body: startBody.message,
        idempotencyKey: `lt_mixed_${i}`,
      });
      record(metrics.inbound, inb);
    } else if (dice < 9) {
      // status poll
      if (seedIds.length === 0) return;
      const id = seedIds[i % seedIds.length]!;
      const out = await getVerification(client, fixtures, id);
      record(metrics.status, out);
    } else {
      // start-only
      const out = await startVerification(client, fixtures, phoneFromIndex(i));
      record(metrics.start, out);
    }
  });
}

/** E => Replay storm: same nonce sent many times. */
export async function replayStorm(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  // Seed one pending verification.
  const phone = phoneFromIndex(0);
  const seed = await startVerification(client, fixtures, phone);
  record(metrics.start, seed);
  if (seed.kind !== "ok") return;
  const seedBody = seed.body as { message: string; send_to: string };
  const receiver = pickReceiver(fixtures, seedBody.send_to);

  // First inbound legitimately uses a fresh nonce — should match.
  const fresh = await postInbound(client, receiver, {
    from: phone,
    body: seedBody.message,
    idempotencyKey: "lt_replay_seed",
  });
  record(metrics.inbound, fresh);
  if (fresh.kind === "ok" && (fresh.body as { matched?: boolean }).matched) {
    metrics.inbound.bumpExtra("matched");
  }

  // Now: replay the SAME nonce N times. Expect 401 every time.
  const fixedNonce = "f".repeat(32);
  await runPool(total, workers, async (i) => {
    const out = await postInbound(
      client,
      receiver,
      {
        from: phone,
        body: "VERIFY ZZZZZZ",
        idempotencyKey: `lt_replay_${i}`,
        nonce: fixedNonce,
      },
      [401],
    );
    record(metrics.inbound, out);
    if (out.kind === "expected_4xx") metrics.inbound.bumpExtra("replay_rejected");
  });
}

/** F => Wrong-code storm: signed inbounds that should never match. */
export async function wrongCodeStorm(ctx: ScenarioContext): Promise<void> {
  const { client, fixtures, metrics, total, workers } = ctx;
  // No pending verification needed — the server will respond no_match
  // and the inbound row is stored but matched_verification_id stays null.
  const receiver = fixtures.receivers[0]!;
  await runPool(total, workers, async (i) => {
    const out = await postInbound(client, receiver, {
      from: phoneFromIndex(i),
      body: "VERIFY " + randomCode(),
      idempotencyKey: `lt_wrong_${i}`,
    });
    record(metrics.inbound, out);
    if (out.kind === "ok") {
      const body = out.body as { matched?: boolean; reason?: string };
      if (!body.matched) metrics.inbound.bumpExtra("no_match");
      else metrics.inbound.bumpExtra("matched_unexpectedly");
    }
  });
}

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  }
  return out;
}

/** Build a midpoint hook that disables receiver #1 via direct DB. */
export function disableReceiverMidpoint(receiverId: string) {
  return async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.warn("[mid] DATABASE_URL not set — scenario H can't disable a receiver");
      return;
    }
    const postgres = (await import("postgres")).default;
    const sql = postgres(dbUrl, { max: 1 });
    try {
      await sql`UPDATE receivers SET enabled = false WHERE id = ${receiverId}`;
      console.log(`[mid] disabled receiver ${receiverId}`);
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}
