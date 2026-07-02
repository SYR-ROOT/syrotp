package io.syrotp.gateway

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Crypto {
    private val HEX = "0123456789abcdef".toCharArray()

    fun hexEncode(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xff
            out[i * 2] = HEX[v ushr 4]
            out[i * 2 + 1] = HEX[v and 0x0f]
        }
        return String(out)
    }

    fun sha256Hex(input: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        return hexEncode(md.digest(input))
    }

    /**
     * @deprecated Heap-resident HMAC. Retained ONLY for the one-shot
     * legacy-prefs migration path inside [KeystoreSigner.importKey] /
     * [SignerMigration]. Production signing goes through
     * [KeystoreSigner.sign] so the key bytes never leave the keystore.
     */
    @Deprecated(
        message = "Use KeystoreSigner.sign(); this overload only exists for legacy migration.",
        replaceWith = ReplaceWith("KeystoreSigner.get(ctx).sign(payload.toByteArray(Charsets.UTF_8))"),
    )
    fun hmacSha256Hex(key: String, payload: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return hexEncode(mac.doFinal(payload.toByteArray(Charsets.UTF_8)))
    }

    fun randomNonceHex(bytes: Int = 16): String {
        val rng = SecureRandom()
        val buf = ByteArray(bytes)
        rng.nextBytes(buf)
        return hexEncode(buf)
    }
}
