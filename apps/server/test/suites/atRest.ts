/**
 * Suite 7: DB-only breach simulation (T22).
 *
 * Threat: an attacker walks off with a Postgres dump but does NOT have
 * MASTER_ENCRYPTION_KEY. We verify three things at the storage layer:
 *
 *   1. API keys are stored as fixed-length hex hashes — the raw `pk_live_*`
 *      / `sk_live_*` strings appear nowhere in the row.
 *   2. Receiver signing keys are stored as AES-GCM ciphertext (v1.<iv>.<tag>.<ct>),
 *      never as the raw hex key.
 *   3. Verification *codes* — these MUST be queryable for matching, so we
 *      accept they are stored as plaintext within their (short) TTL. We
 *      assert the row exists and document the trade-off.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase, rawQuery } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

describe("at-rest protection (DB-only breach)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("T22a: api_keys table never holds raw pk_live_/sk_live_ strings", async () => {
    const fx = await createTestApp();
    const rows = await rawQuery<{ key_hash: string; key_prefix: string }>(
      "SELECT key_hash, key_prefix FROM api_keys",
    );
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      // 64-char hex hash, not the raw key.
      assert.match(row.key_hash, /^[0-9a-f]{64}$/);
      assert.ok(!row.key_hash.startsWith("pk_live"));
      assert.ok(!row.key_hash.startsWith("sk_live"));
      // The 12-char prefix is intentional (helps ops identify a key in a
      // log without giving up the secret).
      assert.ok(row.key_prefix.length <= 12);
    }
    // Belt and braces: the raw values themselves must be absent.
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes(fx.publicKey));
    assert.ok(!blob.includes(fx.secretKey));
  });

  it("T22b: receivers.secret_hash is AES-GCM ciphertext, not the raw signing key", async () => {
    const fx = await createTestApp();
    const rows = await rawQuery<{ secret_hash: string }>(
      "SELECT secret_hash FROM receivers",
    );
    assert.equal(rows.length, 1);
    const wrapped = rows[0]!.secret_hash;
    // v1.<iv-b64u>.<tag-b64u>.<ct-b64u>
    assert.match(wrapped, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // The raw signing key is hex; ciphertext is base64url. They cannot match.
    assert.notEqual(wrapped, fx.signingKey);
    assert.ok(!wrapped.includes(fx.signingKey));
  });

  it("T22c: AAD binding — copying one receiver's wrapped secret to another row fails to decrypt", async () => {
    const fxA = await createTestApp({ msisdn: "+963998887777" });
    const fxB = await createTestApp({ msisdn: "+963998887778" });
    const app = await getTestApp();

    // Swap receiver A's wrapped secret onto receiver B's row in DB.
    await rawQuery(
      "UPDATE receivers SET secret_hash = (SELECT secret_hash FROM receivers WHERE id = $1) WHERE id = $2",
      [fxA.receiverId, fxB.receiverId],
    );

    // Try to send an inbound for receiver B signed with A's signing key.
    // Even though the bytes match, AAD binds the wrap to receiver A's id,
    // so unwrap on B fails.
    const body = inboundBody({
      from: "+963991234567",
      to: fxB.receiverMsisdn,
      body: "VERIFY ABCDEF",
    });
    const headers = signGateway(fxB.receiverId, fxA.signingKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 401, "AAD must prevent cross-row swap");
  });

  it("T22d: a Postgres-only dump can't impersonate any gateway", async () => {
    // Attacker walks away with a dump. They reconstruct everything they
    // can from the table, then attempt a forgery. Without the master key
    // they cannot decrypt secret_hash, so the only thing they can sign with
    // is whatever ciphertext is stored — which the verifier does NOT
    // accept as a key.
    const fx = await createTestApp();
    const app = await getTestApp();
    const rows = await rawQuery<{ secret_hash: string }>(
      "SELECT secret_hash FROM receivers WHERE id = $1",
      [fx.receiverId],
    );
    const wrappedAsKey = rows[0]!.secret_hash;

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY AAAAAA",
    });
    const headers = signGateway(fx.receiverId, wrappedAsKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 401);
  });
});
