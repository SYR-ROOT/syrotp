package io.syrotp.gateway

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Thin HTTP client that signs every request with HMAC-SHA256 over
 *   "<unix-seconds>.<nonce>.<sha256(body)>"
 * The signing key lives in AndroidKeyStore via [KeystoreSigner] —
 * the raw bytes never materialize in the app's heap during signing.
 */
class SyrotpClient(
    private val baseUrl: String,
    private val receiverId: String,
    private val signer: KeystoreSigner,
) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    data class Result(val ok: Boolean, val status: Int, val body: String)

    fun postSigned(path: String, jsonBody: String): Result {
        val body = jsonBody.toByteArray(Charsets.UTF_8)
        val ts = (System.currentTimeMillis() / 1000L).toString()
        val nonce = Crypto.randomNonceHex(16)
        val bodyHash = Crypto.sha256Hex(body)
        val sigBytes = signer.sign("$ts.$nonce.$bodyHash".toByteArray(Charsets.UTF_8))
        val sig = Crypto.hexEncode(sigBytes)

        val req = Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .post(body.toRequestBody("application/json".toMediaType()))
            .header("X-SYROTP-Receiver", receiverId)
            .header("X-SYROTP-Timestamp", ts)
            .header("X-SYROTP-Nonce", nonce)
            .header("X-SYROTP-Signature", sig)
            .header("User-Agent", "syrotp-android-gateway/0.1.0")
            .build()

        return http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            Result(res.isSuccessful, res.code, text)
        }
    }

    fun postInbound(
        from: String,
        to: String,
        body: String,
        receivedAtMillis: Long,
        idempotencyKey: String,
        simSlot: Int? = null,
    ): Result {
        val payload = buildJsonObject {
            put("from", from)
            put("to", to)
            put("body", body)
            put("received_at", iso8601(receivedAtMillis))
            put("idempotency_key", idempotencyKey)
            if (simSlot != null) put("sim_slot", simSlot)
        }.toString()
        return postSigned("/v1/inbound/sms", payload)
    }

    fun heartbeat(queueDepth: Int, batteryPercent: Int?, signalDbm: Int?): Result {
        val payload = buildJsonObject {
            put("received_at", iso8601(System.currentTimeMillis()))
            put("queue_depth", queueDepth)
            if (batteryPercent != null) put("battery_percent", batteryPercent)
            if (signalDbm != null) put("sim_signal_dbm", signalDbm)
            put("app_version", "0.1.0")
        }.toString()
        return postSigned("/v1/receivers/$receiverId/heartbeat", payload)
    }

    private fun iso8601(millis: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        fmt.timeZone = TimeZone.getTimeZone("UTC")
        return fmt.format(Date(millis))
    }
}
