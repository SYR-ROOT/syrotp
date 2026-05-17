package io.syrotp.gateway

import android.content.Context
import android.util.Log

/**
 * One-shot migration of the legacy plaintext signing key from
 * [GatewayConfig] into the AndroidKeyStore via [KeystoreSigner].
 *
 * Pre-v0.8 builds stored the per-receiver HMAC key as a string inside
 * EncryptedSharedPreferences. v0.8 keeps the key inside AndroidKeyStore
 * so the raw bytes never live in the app's heap or data partition. This
 * helper bridges existing installs into the new world without forcing
 * users through the pairing UI again.
 *
 * Called from every entry point that needs a signer:
 *
 *   - [MainActivity.onCreate] — so opening the app upgrades the install.
 *   - [UploadWorker.doWork] / [HeartbeatWorker.doWork] — so a paired
 *     gateway that's auto-restarted after the upgrade migrates without
 *     waiting for the user to launch the UI.
 *
 * Idempotent: skips work if the keystore already has the key, or if no
 * legacy key is present.
 */
object SignerMigration {

    private const val TAG = "SignerMigration"

    fun run(ctx: Context) {
        val signer = KeystoreSigner.get(ctx)
        if (signer.hasKey()) return

        val cfg = GatewayConfig.get(ctx)
        val legacy = cfg.legacySigningKey ?: return

        try {
            signer.importKey(legacy)
            cfg.clearLegacySigningKey()
            Log.i(TAG, "migrated legacy signing key into AndroidKeyStore")
        } catch (e: Exception) {
            // If keystore import fails on a wedged device, leave the
            // legacy key in place so the next run can retry the migration
            // (or so a manual re-pair can wipe it). We do NOT fall back
            // to heap-resident HMAC — the whole point of this PR is that
            // raw key bytes don't live in app memory. The worker will see
            // a "no signing key" exception and surface as Result.retry().
            Log.e(TAG, "keystore migration failed; leaving legacy key in prefs", e)
        }
    }
}
