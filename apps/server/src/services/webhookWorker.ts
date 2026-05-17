/**
 * Webhook delivery worker (PR #20B). Same-process, periodic timer.
 *
 * Lifecycle:
 *   - `start()` schedules the next tick via `setTimeout` (NOT
 *     `setInterval` — `setInterval` can stack overlapping ticks if
 *     a tick runs longer than the interval). The timer is `unref()`ed
 *     so it never blocks process shutdown.
 *   - `stop()` clears the timer and waits for the in-flight tick
 *     to finish. Tests rely on this for clean teardown.
 *   - `runOnce()` runs a single tick synchronously; tests use it to
 *     trigger deliveries without waiting on the periodic schedule.
 *
 * Per-tick:
 *   1. Pick up to N due deliveries (`status='pending'` AND
 *      `next_attempt_at <= now()`) using `FOR UPDATE SKIP LOCKED`,
 *      so a future multi-process deployment doesn't double-deliver.
 *   2. For each: stamp the row with a soft "in-flight" lease (push
 *      `next_attempt_at` ~60s into the future) so a worker crash
 *      doesn't strand the row forever, then commit.
 *   3. Outside any DB transaction, perform the HTTP delivery.
 *   4. Apply the final result (delivered / failed / abandoned, or
 *      next_attempt_at scheduled per the retry table).
 *
 * The HTTP call is intentionally NOT inside a DB transaction. Holding
 * a Postgres session across a 5s outbound HTTP would tie up a pool
 * connection for every concurrent delivery; the lease-then-update
 * pattern below keeps each tx short.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { unwrap } from "../lib/aead.js";
import { metrics } from "./metrics.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  nextRetryDelaySeconds,
  signDeliveryBody,
} from "./webhooks.js";

/**
 * Minimal structural logger interface — covers exactly what the
 * worker uses. Both Fastify's `FastifyBaseLogger` and a plain
 * pino logger satisfy this, so the same `WebhookWorker` class
 * runs both in-process (with `app.log`) and in the standalone
 * `workers/webhook.ts` entrypoint (with a plain pino instance) —
 * no Fastify dependency leaks into the worker process. v0.9 PR #41.
 */
export interface WebhookWorkerLogger {
  info(msg: string): void;
  info(obj: object, msg?: string): void;
  warn(msg: string): void;
  warn(obj: object, msg?: string): void;
  error(msg: string): void;
  error(obj: object, msg?: string): void;
}

/** How far into the future to push `next_attempt_at` while a delivery
 * is in flight, so a worker crash recovers within bounded time. */
const IN_FLIGHT_LEASE_SECONDS = 60;

/** Up to this many deliveries per tick. Keeps a slow tick from
 * tying up the pool behind a long backlog. */
const BATCH_SIZE = 25;

/** Per-attempt outbound HTTP timeout, per the spec. */
const HTTP_TIMEOUT_MS = 5_000;

interface DueRow extends Record<string, unknown> {
  delivery_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  attempt_count: number;
  url: string;
  enabled: boolean;
  secret_ciphertext: string;
  payload_json: string;
}

type DeliveryOutcome =
  | { kind: "delivered"; statusCode: number }
  | { kind: "retry"; reason: FailReason; statusCode: number | null; message: string }
  | { kind: "permanent"; reason: FailReason; statusCode: number; message: string }
  | { kind: "endpoint_disabled" };

type FailReason =
  | "network_error"
  | "timeout"
  | "client_4xx"
  | "server_5xx"
  | "rate_limited"
  | "bad_response";

export class WebhookWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  // Test seam: replace with a stub fetch that returns canned
  // responses without touching the network. Defaults to global
  // fetch (Node 18+).
  public fetchImpl: typeof fetch = (...args) => fetch(...args);

  constructor(private readonly log: WebhookWorkerLogger) {}

  start(): void {
    if (!config.WEBHOOK_WORKER_ENABLED) {
      this.log.info("webhook delivery worker disabled (WEBHOOK_WORKER_ENABLED=false)");
      return;
    }
    this.stopped = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Wait for an in-flight tick to finish so DB connections are
    // released cleanly before app.close() proceeds.
    while (this.running) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Run a single tick synchronously. Tests use this to trigger
   * delivery without waiting for the periodic schedule. Production
   * callers should use `start()`.
   */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (err) {
      this.log.error({ err }, "webhook worker tick failed");
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.runOnce().finally(() => {
        if (!this.stopped) this.scheduleNext();
      });
    }, config.WEBHOOK_WORKER_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    const claimed = await this.claimBatch();
    for (const row of claimed) {
      await this.processOne(row);
    }
  }

  /**
   * Atomically lock up to BATCH_SIZE due deliveries with `FOR UPDATE
   * SKIP LOCKED` and bump their `next_attempt_at` to act as a soft
   * in-flight lease. Returns the joined endpoint + event data each
   * delivery needs.
   */
  private async claimBatch(): Promise<DueRow[]> {
    return await db.transaction(async (tx) => {
      const rows = await tx.execute<DueRow>(sql`
        SELECT
          d.id              AS delivery_id,
          d.endpoint_id     AS endpoint_id,
          d.event_id        AS event_id,
          d.event_type      AS event_type,
          d.attempt_count   AS attempt_count,
          e.url             AS url,
          e.enabled         AS enabled,
          e.secret_ciphertext AS secret_ciphertext,
          ev.payload_json   AS payload_json
        FROM webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
        JOIN webhook_events ev ON ev.id = d.event_id
        WHERE d.status = 'pending'
          AND d.next_attempt_at <= now()
        ORDER BY d.next_attempt_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE OF d SKIP LOCKED
      `);
      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.delivery_id);
      // Push next_attempt_at forward as a soft lease so a worker
      // crash won't strand these rows. The final update in
      // `processOne` rewrites it to either a real retry time, a
      // sentinel (terminal), or simply "stays as +60s" if we never
      // get there.
      const lease = new Date(Date.now() + IN_FLIGHT_LEASE_SECONDS * 1_000);
      await tx
        .update(schema.webhookDeliveries)
        .set({ nextAttemptAt: lease, updatedAt: new Date() })
        .where(inArray(schema.webhookDeliveries.id, ids));
      return rows;
    });
  }

  private async processOne(row: DueRow): Promise<void> {
    const attempt = row.attempt_count + 1;
    const outcome = await this.deliver(row, attempt);
    await this.applyOutcome(row, attempt, outcome);
  }

  /**
   * Make exactly ONE outbound HTTP request. Maps the result to a
   * `DeliveryOutcome` the apply step uses to update the row.
   */
  private async deliver(row: DueRow, attempt: number): Promise<DeliveryOutcome> {
    if (!row.enabled) {
      metrics.webhookDeliveryFailure("endpoint_disabled");
      return { kind: "endpoint_disabled" };
    }

    let secret: string;
    try {
      secret = unwrap(config.MASTER_ENCRYPTION_KEY, row.secret_ciphertext, `webhook:${row.endpoint_id}`);
    } catch (err) {
      // Wrapped secret can't decrypt — likely MASTER_ENCRYPTION_KEY
      // rotated without re-wrap. Mark as permanent failure; the
      // operator must rotate webhook secrets after key rotation.
      metrics.webhookDeliveryFailure("bad_response");
      return {
        kind: "permanent",
        reason: "bad_response",
        statusCode: 0,
        message: "secret_unwrap_failed",
      };
    }

    const timestampSec = Math.floor(Date.now() / 1000);
    const body = row.payload_json;
    const signature = signDeliveryBody(secret, timestampSec, body);

    const t0 = performance.now();
    let res: Response;
    try {
      res = await this.fetchImpl(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "syrotp-webhook/1.0",
          "X-SYROTP-Webhook-Id": row.delivery_id,
          "X-SYROTP-Webhook-Timestamp": String(timestampSec),
          "X-SYROTP-Webhook-Signature": signature,
          "X-SYROTP-Webhook-Event": row.event_type,
          "X-SYROTP-Webhook-Attempt": String(attempt),
        },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        // Don't follow redirects — a misconfigured endpoint pointing
        // at a 30x to a third party should NOT receive the signed
        // body silently.
        redirect: "manual",
      });
    } catch (err) {
      const ms = performance.now() - t0;
      const isTimeout =
        err instanceof DOMException ? err.name === "TimeoutError" :
        err instanceof Error ? /timed?\s?out|abort/i.test(err.message) : false;
      const reason: FailReason = isTimeout ? "timeout" : "network_error";
      metrics.webhookDeliveryFailure(reason);
      metrics.webhookDeliveryObserved(ms / 1000, isTimeout ? "timeout" : "network");
      return {
        kind: "retry",
        reason,
        statusCode: null,
        message: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      };
    }

    const ms = performance.now() - t0;
    const status = res.status;

    if (status >= 200 && status < 300) {
      metrics.webhookDeliveryObserved(ms / 1000, "2xx");
      return { kind: "delivered", statusCode: status };
    }

    if (status === 429) {
      metrics.webhookDeliveryFailure("rate_limited");
      metrics.webhookDeliveryObserved(ms / 1000, "4xx");
      return {
        kind: "retry",
        reason: "rate_limited",
        statusCode: status,
        message: `429 from receiver`,
      };
    }
    if (status >= 400 && status < 500) {
      metrics.webhookDeliveryFailure("client_4xx");
      metrics.webhookDeliveryObserved(ms / 1000, "4xx");
      return {
        kind: "permanent",
        reason: "client_4xx",
        statusCode: status,
        message: `${status} from receiver`,
      };
    }
    if (status >= 500 && status < 600) {
      metrics.webhookDeliveryFailure("server_5xx");
      metrics.webhookDeliveryObserved(ms / 1000, "5xx");
      return {
        kind: "retry",
        reason: "server_5xx",
        statusCode: status,
        message: `${status} from receiver`,
      };
    }
    // 1xx / 3xx (we set redirect: manual) — treat as bad response.
    metrics.webhookDeliveryFailure("bad_response");
    metrics.webhookDeliveryObserved(ms / 1000, "4xx");
    return {
      kind: "permanent",
      reason: "bad_response",
      statusCode: status,
      message: `unexpected status ${status}`,
    };
  }

  /**
   * Apply the delivery outcome to the row. Always runs in its own
   * short transaction so an HTTP slowness can't tie up the
   * connection pool while we wait.
   */
  private async applyOutcome(
    row: DueRow,
    attempt: number,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    const now = new Date();

    if (outcome.kind === "delivered") {
      await db
        .update(schema.webhookDeliveries)
        .set({
          status: "delivered",
          attemptCount: attempt,
          lastStatusCode: outcome.statusCode,
          lastError: null,
          updatedAt: now,
        })
        .where(eq(schema.webhookDeliveries.id, row.delivery_id));
      metrics.webhookDeliveryTerminal("delivered");
      return;
    }

    if (outcome.kind === "endpoint_disabled") {
      await db
        .update(schema.webhookDeliveries)
        .set({
          status: "abandoned",
          attemptCount: attempt,
          lastError: "endpoint_disabled",
          updatedAt: now,
        })
        .where(eq(schema.webhookDeliveries.id, row.delivery_id));
      metrics.webhookDeliveryTerminal("abandoned");
      return;
    }

    if (outcome.kind === "permanent") {
      await db
        .update(schema.webhookDeliveries)
        .set({
          status: "failed",
          attemptCount: attempt,
          lastStatusCode: outcome.statusCode,
          lastError: outcome.message.slice(0, 500),
          updatedAt: now,
        })
        .where(eq(schema.webhookDeliveries.id, row.delivery_id));
      metrics.webhookDeliveryTerminal("failed");
      return;
    }

    // Retry path. If we've used the budget, abandon.
    const delay = nextRetryDelaySeconds(attempt);
    if (delay === null || attempt >= MAX_DELIVERY_ATTEMPTS) {
      await db
        .update(schema.webhookDeliveries)
        .set({
          status: "abandoned",
          attemptCount: attempt,
          lastStatusCode: outcome.statusCode,
          lastError: outcome.message.slice(0, 500),
          updatedAt: now,
        })
        .where(eq(schema.webhookDeliveries.id, row.delivery_id));
      metrics.webhookDeliveryTerminal("abandoned");
      return;
    }

    const nextAttemptAt = new Date(Date.now() + delay * 1_000);
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: "pending",
        attemptCount: attempt,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.message.slice(0, 500),
        nextAttemptAt,
        updatedAt: now,
      })
      .where(eq(schema.webhookDeliveries.id, row.delivery_id));
    metrics.webhookDeliveryTerminal("retried");
  }
}
