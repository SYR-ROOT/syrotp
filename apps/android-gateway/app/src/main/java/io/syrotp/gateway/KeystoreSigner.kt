package io.syrotp.gateway

import android.content.Context
import android.os.Build
import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import android.util.Log
import java.security.KeyStore
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Owns the per-receiver HMAC signing key as an AndroidKeyStore-resident
 * `SecretKey`. Once imported, the key bytes never leave the keystore —
 * `Mac.init(keystoreKey)` uses the keystore-resident key directly, so
 * a rooted device or in-process attacker can't read the raw bytes from
 * heap. On hardware that exposes a TEE / StrongBox, the key is hardware-
 * bound; on devices without one, AndroidKeyStore still confines it to
 * the system_server's keystore daemon.
 *
 * Why this on top of EncryptedSharedPreferences:
 *
 *   - EncryptedSharedPreferences encrypts at rest, but every read
 *     materializes the raw key as a `String` in app memory before
 *     `Mac.init(SecretKeySpec(key))` consumes it. A debugger / memory
 *     dump on a rooted device extracts it.
 *   - With AndroidKeyStore, the key is referenced by alias, not value.
 *     `Mac` cooperates with the keystore daemon to do the HMAC in a
 *     privileged process. The app never sees the bytes after import.
 *
 * Lifecycle:
 *
 *   - `importKey(rawKey)` — runs once during pairing (or one-shot
 *     migration from a legacy `EncryptedSharedPreferences` install).
 *     The caller is responsible for clearing the in-memory `String`
 *     after the call returns.
 *   - `sign(payload)` — the only hot-path method.
 *   - `hasKey()` — cheap existence check.
 *   - `delete()` — used by Unpair and by the manual compromise-recovery
 *     procedure. After delete the gateway is unable to sign, so all
 *     pending queued items will hit auth failures and surface to ops.
 */
class KeystoreSigner private constructor() {

    fun hasKey(): Boolean {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        return ks.containsAlias(ALIAS)
    }

    /**
     * Imports `rawKey` (UTF-8 bytes — same encoding the legacy
     * `Crypto.hmacSha256Hex(key: String, ...)` used) as a non-extractable
     * HMAC-SHA256 key under [ALIAS]. Idempotent: replaces an existing
     * entry under the same alias.
     *
     * Best-effort StrongBox: requested on devices that advertise it
     * (API 28+, hardware-dependent). Falls back to TEE-only on import
     * failure rather than blowing up — the security floor is still
     * "keystore-resident, not heap-resident".
     */
    fun importKey(rawKey: String) {
        val keyBytes = rawKey.toByteArray(Charsets.UTF_8)
        val secret = SecretKeySpec(keyBytes, KeyProperties.KEY_ALGORITHM_HMAC_SHA256)
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }

        val baseProtection = KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
            .setDigests(KeyProperties.DIGEST_SHA256)

        // Try StrongBox first; if the device doesn't expose one the import
        // fails with StrongBoxUnavailableException and we re-import without
        // the flag. Both branches still produce an AndroidKeyStore-resident
        // key — just one with a stronger root of trust.
        val protection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            baseProtection.setIsStrongBoxBacked(true).build()
        } else {
            baseProtection.build()
        }

        try {
            ks.setEntry(ALIAS, KeyStore.SecretKeyEntry(secret), protection)
        } catch (e: Exception) {
            // StrongBoxUnavailableException is a child of ProviderException
            // on most platforms but not on all — catch broadly and retry
            // without StrongBox. Other failures (lock-screen-bound import on
            // some OEMs, etc.) also funnel through here.
            Log.w(TAG, "Keystore import with StrongBox failed; retrying without", e)
            ks.setEntry(
                ALIAS,
                KeyStore.SecretKeyEntry(secret),
                baseProtection.build(),
            )
        }
    }

    /**
     * HMAC-SHA256 the payload using the keystore-resident key. Returns
     * raw 32 bytes — caller hex-encodes for the `X-SYROTP-Signature`
     * header.
     */
    fun sign(payload: ByteArray): ByteArray {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        val keyEntry = ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry
            ?: throw IllegalStateException("signing key not present in keystore (alias=$ALIAS)")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(keyEntry.secretKey)
        return mac.doFinal(payload)
    }

    fun delete() {
        val ks = KeyStore.getInstance(PROVIDER).apply { load(null) }
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    }

    companion object {
        private const val TAG = "KeystoreSigner"
        private const val PROVIDER = "AndroidKeyStore"
        private const val ALIAS = "syrotp_gateway_signing_v1"

        @Suppress("UNUSED_PARAMETER")
        fun get(ctx: Context): KeystoreSigner = INSTANCE

        private val INSTANCE = KeystoreSigner()
    }
}
