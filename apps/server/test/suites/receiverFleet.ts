/**
 * Suite: receiver fleet operations (v0.9 PR #44).
 *
 * The `enabled` flag on a receiver row is a fleet-management lever:
 * operators flip it to `false` for maintenance, then back to `true`
 * when the gateway is healthy again. PR #44 ships the symmetric
 * `enableReceiver` admin function alongside the existing
 * `disableReceiver`. These tests pin the two contracts that matter:
 *
 *   RF1   inbound from a disabled receiver is rejected at HMAC
 *         verify (status 401 / code "unauthorized" — the route
 *         deliberately surfaces a single uniform code regardless of
 *         WHY HMAC verify failed, so a probing attacker can't
 *         distinguish "wrong sig" from "row disabled" from "row
 *         missing"). The gateway can't slip an SMS through while
 *         flagged for maintenance.
 *   RF2   disable → enable round-trip: a disabled receiver leaves
 *         the selection pool (matching MR3's pre-existing assertion)
 *         and re-enabling it puts it back without any other manual
 *         step.
 *
 * Why a separate suite from `multiReceiver.ts`: that suite covers
 * routing semantics; this one covers the lifecycle-management
 * surface the operator uses (admin module + CLI). Different concern,
 * different file.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { addReceiver, createTestApp, seedVerifiedBinding } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";
import { disableReceiver, enableReceiver } from "../../src/admin/receivers.js";

describe("receiver fleet operations (v0.9 PR #44)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  // ----- RF1: disabled receiver inbound is rejected at HMAC verify ------

  it("RF1: inbound from a disabled receiver is rejected", async () => {
    // Bootstrap a primary so the app has at least one healthy receiver
    // (otherwise some other path could 503 first). Then add a SECOND
    // receiver, disable it, and try to push an inbound from it.
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const second = await addReceiver(fx.appId, { msisdn: "+963990001234" });

    // Sanity: while still enabled, a signed inbound is accepted (202).
    const app = await getTestApp();
    const enabledBody = inboundBody({
      from: "+963991234567",
      to: second.msisdn,
      body: "VERIFY ABC123",
      idempotencyKey: `rf1_warmup_${Date.now()}`,
    });
    const enabledHeaders = signGateway(second.receiverId, second.signingKey, enabledBody);
    const enabledResp = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers: enabledHeaders,
      payload: enabledBody,
    });
    assert.equal(enabledResp.statusCode, 202, "enabled receiver baseline must be 202");

    // Disable the receiver via the admin function — same code path the
    // CLI's `syrotp receiver disable` uses.
    const disabled = await disableReceiver(second.receiverId);
    assert.equal(disabled.wasEnabled, true, "first disable should report wasEnabled=true");

    // Same signed inbound shape, fresh idempotency key. The HMAC verify
    // path resolves the receiver row and returns "unknown_receiver" on
    // any row where enabled=false (services/hmac.ts:66) → the route
    // surfaces as 401 invalid_signature, NOT 202.
    const disabledBody = inboundBody({
      from: "+963991234567",
      to: second.msisdn,
      body: "VERIFY DEF456",
      idempotencyKey: `rf1_after_disable_${Date.now()}`,
    });
    const disabledHeaders = signGateway(second.receiverId, second.signingKey, disabledBody);
    const disabledResp = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers: disabledHeaders,
      payload: disabledBody,
    });
    assert.equal(
      disabledResp.statusCode,
      401,
      `disabled receiver inbound must be 401, got ${disabledResp.statusCode}`,
    );
    // The route returns the uniform "unauthorized" code regardless of
    // whether HMAC verify failed because of a bad signature, a missing
    // receiver row, or a disabled receiver — operators get the precise
    // reason from logs / metrics, not from the wire.
    assert.equal(disabledResp.json().error?.code, "unauthorized");
  });

  // ----- RF2: disable → enable round-trip restores selection -----------

  it("RF2: disabling then enabling a receiver restores it to the selection pool", async () => {
    // Two receivers: a primary that should be picked while the second
    // is disabled, and the second that should come back into the pool
    // after re-enabling.
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const second = await addReceiver(fx.appId, { msisdn: "+963990005555" });
    const app = await getTestApp();

    // Phase 1: both enabled — round-robin'ish, but at least pin that
    // when we ASK for a fresh start, ONE of the two is picked. (We
    // don't pin which one — that's a routing concern covered by MR1.)
    await seedVerifiedBinding({
      appId: fx.appId,
      receiverId: fx.receiverId,
      phoneE164: "+963999900001",
    });
    const phase1 = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "+963999900001", purpose: "login" },
    });
    assert.equal(phase1.statusCode, 201);
    assert.ok(
      phase1.json().send_to === "+963998887777" || phase1.json().send_to === "+963990005555",
      "phase 1 should pick one of the two enabled receivers",
    );

    // Phase 2: disable second — every pick must land on primary.
    await disableReceiver(second.receiverId);
    for (let i = 0; i < 5; i++) {
      const phone = `+963999900${100 + i}`;
      await seedVerifiedBinding({ appId: fx.appId, receiverId: fx.receiverId, phoneE164: phone });
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      assert.equal(r.statusCode, 201);
      assert.equal(
        r.json().send_to,
        "+963998887777",
        `phase 2 pick #${i} should NEVER land on the disabled receiver`,
      );
    }

    // Phase 3: re-enable — and prove the round-trip's wasDisabled flag.
    const enabled = await enableReceiver(second.receiverId);
    assert.equal(enabled.wasDisabled, true, "first enable should report wasDisabled=true");
    assert.equal(enabled.id, second.receiverId);
    assert.equal(enabled.msisdn, "+963990005555");

    // A second enable on the same receiver must be idempotent (no-op).
    const enabledAgain = await enableReceiver(second.receiverId);
    assert.equal(enabledAgain.wasDisabled, false, "second enable must be a no-op");

    // Phase 4: with both enabled again, prove the previously-disabled
    // receiver IS reachable for selection — over N picks, at least one
    // should land on it. (Selection is load-balanced by pending count
    // first; a fresh receiver with 0 pending tends to win, so a few
    // picks is enough to demonstrate the receiver is back in the pool.)
    let landedOnSecond = false;
    for (let i = 0; i < 20; i++) {
      const phone = `+963999900${200 + i}`;
      await seedVerifiedBinding({ appId: fx.appId, receiverId: fx.receiverId, phoneE164: phone });
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      if (r.json().send_to === "+963990005555") {
        landedOnSecond = true;
        break;
      }
    }
    assert.equal(
      landedOnSecond,
      true,
      "after re-enable, at least one pick out of 20 should land on the previously-disabled receiver",
    );
  });
});
