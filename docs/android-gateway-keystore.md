# Android Gateway — Keystore-Backed Signing Key

**Applies to**: `apps/android-gateway/` from v0.8.0 onward.

The Android gateway signs every request to SYROTP with HMAC-SHA256
over `"<unix-seconds>.<nonce>.<sha256(body)>"`. From v0.8 the HMAC
key lives in **AndroidKeyStore**, not in app-readable storage. The
raw bytes never sit on the data partition or in the JVM heap during
signing — `Mac.init(keystoreSecretKey)` cooperates with the keystore
daemon to produce the signature.

This document covers the threat model, the pairing flow, the
post-upgrade migration, key rotation, and compromise recovery.

## Threat model

What this protects against:

- A rooted device, compromised companion app, or runtime debugger
  reading the signing key from the gateway's process memory.
- A backup-extraction attack against the device's data partition
  (e.g. `adb backup` chains, `/data/data/io.syrotp.gateway/...`).
- An OEM-level filesystem snapshot landing the key alongside other
  app data in an incident response.

What it does NOT protect against:

- An attacker who has both physical access AND the device's screen
  lock unlock (they can use the gateway app and produce signatures
  via its UI).
- A malicious build of the gateway itself signed with the same
  package id (Keystore aliases are app-scoped — the malicious app
  starts with no entry).
- A compromised SYROTP server, which can always change which
  receiver is authoritative for a phone (server-side abuse signals
  in `docs/monitoring.md` are the watchdog there).

## How storage looks

| Field | Storage | Why |
| --- | --- | --- |
| `serverUrl` | EncryptedSharedPreferences | Sensitive (reveals tenant), low compromise impact. |
| `receiverId` | EncryptedSharedPreferences | As above. |
| Signing key | `AndroidKeyStore`, alias `syrotp_gateway_signing_v1` | Hardware-bound where TEE/StrongBox is available; otherwise keystore-daemon-resident. Not extractable. |

The legacy `signing_key` slot inside the EncryptedSharedPreferences
file is consumed exactly once on first boot after the v0.8 upgrade,
imported into the keystore by `SignerMigration.run`, then erased.

## Pairing (first-time setup)

1. On the SYROTP server host, mint the receiver:

   ```bash
   node apps/server/dist/scripts/bootstrap.js \
     --app-name "android-gateway" \
     --msisdn  "+963991234567"
   ```

   That prints, **once**:

   - `Receiver ID:        rcv_...`
   - `Receiver MSISDN:    +963991234567`
   - `Gateway signing key: <hex>`

2. On the Android phone, install and open `SYROTP Gateway`. The
   pairing screen has three fields: server URL, receiver id,
   signing key. Paste the values from step 1.

3. Tap **Save**. Behind the scenes:

   - Server URL + receiver id → EncryptedSharedPreferences.
   - Signing key → `KeystoreSigner.importKey(...)`. The
     EditText is cleared immediately; the legacy plaintext slot
     is also cleared as a defensive measure.

4. Grant the SMS + notification permissions when prompted.

5. The Save button writes a small Toast on success. The signing
   key field stays blank from this point on — the app cannot
   display it back, by design.

## Migration from pre-v0.8 installs

Running the v0.8 build for the first time on an existing pairing
will:

1. Open `MainActivity`, `UploadWorker`, or `HeartbeatWorker`
   (whichever fires first after the upgrade).
2. Each entry point calls `SignerMigration.run(ctx)` early.
3. The migration reads the legacy `signing_key` from
   EncryptedSharedPreferences and imports it into the keystore.
4. On success, `clearLegacySigningKey()` removes it from prefs.
5. Subsequent calls are no-ops because `KeystoreSigner.hasKey()`
   short-circuits.

If keystore import fails (a hostile OEM, a wedged keystore daemon,
etc.), the legacy key is left in place so the next run can retry —
**we do not fall back to heap-resident HMAC**. The worker returns
`Result.retry()` and WorkManager backs off; the gateway will not
sign requests in this state.

## Rotation

There is intentionally **no in-place key-rotation flow** in v0.8 —
neither in the server admin tool nor in the gateway app. Rotation
is "mint a new receiver and re-pair":

1. On the server host, run `bootstrap.ts` again to mint a fresh
   receiver row for the same MSISDN:

   ```bash
   node apps/server/dist/scripts/bootstrap.js \
     --app-name "android-gateway" \
     --msisdn  "+963991234567"
   ```

   That prints a new `receiver_id` and a new `signing_key`. Save
   them; they're shown once.

2. On the phone, open the gateway app and tap **Unpair**. This
   calls `KeystoreSigner.delete()` and wipes both the keystore
   alias and the prefs file. The gateway is now unsigned and
   `SmsReceiver` will silently drop incoming SMS until
   re-pairing.

3. Re-enter the server URL, the **new** receiver id, and the
   new signing key. Tap **Save**.

4. (Optional) On the server host, delete the old `receivers`
   row in SQL so the previous key can no longer authenticate.
   Until you do, the old key is still valid against the old
   `receiver_id` — that's a deliberate trade-off so a botched
   re-pair doesn't strand a paired phone.

The cost of a fully fresh re-pair is one minute; the cost of a
mistakenly-kept old key is one tenant's worth of forgeable
inbound SMS until the operator deletes the row. Re-pair-with-new-
receiver is the one supported path in v0.8. A future PR can add a
proper rotation endpoint that updates the existing row in place.

## Compromise recovery

If you suspect a signing key has leaked (e.g. the device was
seized, a forensic image was taken, a backup ended up in the
wrong cloud bucket):

1. **Server first**: delete the compromised `receivers` row in
   SQL.

   ```sql
   DELETE FROM receivers WHERE id = 'rcv_...';
   ```

   From this point on, every inbound POST signed with the old
   key is rejected `401` (no row, no resolved `app_id`, HMAC
   verify fails). The unmatched-rate gauge in the abuse signals
   (see `docs/monitoring.md`) will spike if the attacker was
   actively forging — that's the operator's confirmation that
   the delete landed.

2. **Phone second**: tap **Unpair** in the gateway app. Even if
   you can't reach the phone, step 1 already neutralized the
   key — Unpair is hygiene, not the security fence.

3. Re-pair against a freshly-bootstrapped receiver via the
   steps in **Rotation** above. The new key has a new keystore
   entry; an attacker who held the previous one gains nothing
   from holding it.

4. Audit the abuse-signals dashboard for the affected app's
   `unmatched_rate` and `failed_rate` over the suspect window.
   The numbers tell you whether the leak was actively exploited
   before the delete landed.

## Manual smoke verification

There are no automated tests for this path in this PR — the
gateway has no JVM test source set yet. To smoke-verify on a
real device after building:

1. Install the v0.8 build on a paired (pre-v0.8) device.
2. Open the app. The status row should still read "Paired".
3. Inspect the prefs file via `adb`:

   ```bash
   adb shell run-as io.syrotp.gateway cat \
     /data/data/io.syrotp.gateway/shared_prefs/syrotp_gateway_v1.xml
   ```

   The XML should contain encrypted blobs for `server_url` and
   `receiver_id` only. The `signing_key` slot must be **absent**
   (post-migration).

4. Trigger a heartbeat by toggling airplane mode off/on, or
   wait up to 15 minutes for `HeartbeatWorker`. The server's
   `/v1/receivers/<id>/heartbeat` log should accept the signed
   request — confirming the keystore-bound signature verifies
   identically to the legacy heap-bound one (same key bytes,
   same HMAC).

5. Send a test SMS to the gateway phone. `UploadWorker` should
   POST it; the server should match it; the `unmatched_rate`
   gauge stays at its baseline.

A failed migration shows up as: status row reads "Unpaired"
even though the legacy prefs entry is intact, and Logcat has a
`SignerMigration: keystore migration failed` line. The recovery
is to Unpair + re-pair manually.

## Related

- `apps/android-gateway/app/src/main/java/io/syrotp/gateway/KeystoreSigner.kt`
  — the keystore wrapper.
- `apps/android-gateway/app/src/main/java/io/syrotp/gateway/SignerMigration.kt`
  — the one-shot legacy-key migration.
- `docs/gsm-gateway.md` — the Linux/Python gateway equivalent
  (which is process-isolated by systemd + filesystem permissions
  rather than by keystore — different threat model, same wire
  protocol).
- `docs/monitoring.md` — abuse signals to watch after a suspected
  key compromise.
