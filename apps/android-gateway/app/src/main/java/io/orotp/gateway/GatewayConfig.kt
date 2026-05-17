package io.syrotp.gateway

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Persists the gateway's pairing details with the SYROTP server.
 *
 * Storage: non-sensitive fields (server URL, receiver id) live in
 * EncryptedSharedPreferences for defense-in-depth; the signing key is
 * NOT stored here in v0.8 — it lives in AndroidKeyStore via
 * [KeystoreSigner] so the raw bytes never sit in the app's data
 * partition or heap.
 *
 * The legacy `signing_key` slot is read-only here and is consumed
 * exactly once at boot by [SignerMigration.run] to import the value
 * into AndroidKeyStore, after which [clearLegacySigningKey] erases it.
 *
 * If you change the schema here, bump the file name to force re-pairing.
 */
class GatewayConfig private constructor(private val prefs: android.content.SharedPreferences) {

    /**
     * "Paired" means: we have a server URL + receiver id, AND a signing
     * key reachable somewhere — either freshly imported into the
     * keystore, or still in the legacy prefs slot waiting to be
     * migrated. Callers who need the signer should go through
     * [KeystoreSigner.get] after running [SignerMigration.run].
     */
    fun isPaired(ctx: android.content.Context): Boolean =
        serverUrl != null &&
            receiverId != null &&
            (KeystoreSigner.get(ctx).hasKey() || legacySigningKey != null)

    var serverUrl: String?
        get() = prefs.getString(KEY_URL, null)
        set(v) = prefs.edit().putString(KEY_URL, v).apply()

    var receiverId: String?
        get() = prefs.getString(KEY_RECEIVER, null)
        set(v) = prefs.edit().putString(KEY_RECEIVER, v).apply()

    /** Legacy plaintext signing key from pre-v0.8 installs. Read-only. */
    val legacySigningKey: String?
        get() = prefs.getString(KEY_SIGNING, null)

    fun clearLegacySigningKey() {
        prefs.edit().remove(KEY_SIGNING).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val FILE = "syrotp_gateway_v1"
        private const val KEY_URL = "server_url"
        private const val KEY_RECEIVER = "receiver_id"
        private const val KEY_SIGNING = "signing_key"

        fun get(ctx: Context): GatewayConfig {
            val masterKey = MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            val prefs = EncryptedSharedPreferences.create(
                ctx,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
            return GatewayConfig(prefs)
        }
    }
}
