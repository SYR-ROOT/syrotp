package io.syrotp.sdk.internal

import io.syrotp.sdk.SyrotpAuthError
import io.syrotp.sdk.SyrotpError
import io.syrotp.sdk.SyrotpNetworkError
import io.syrotp.sdk.SyrotpRateLimitError
import io.syrotp.sdk.SyrotpServerError
import io.syrotp.sdk.SyrotpTimeoutError
import io.syrotp.sdk.SyrotpValidationError
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import kotlin.math.max

/**
 * Centralizes the retry policy and the HTTP-status-to-exception mapping.
 *
 * Tests can replace [sleeper] to avoid actually sleeping during retries.
 *
 * Retries happen on:
 *  - [SyrotpNetworkError]  (DNS / TLS / connection failures)
 *  - [SyrotpServerError]   (HTTP 5xx)
 *  - [SyrotpRateLimitError] (HTTP 429, honoring `Retry-After`)
 *
 * Never retries on:
 *  - [SyrotpAuthError]
 *  - [SyrotpValidationError]
 *  - [SyrotpTimeoutError]
 *  - any other non-retriable [SyrotpError]
 */
internal class HttpExecutor(
    private val maxRetries: Int,
    private val sleeper: Sleeper = Sleeper { Thread.sleep(it) },
) {

    init {
        require(maxRetries >= 0) { "maxRetries must be >= 0" }
    }

    internal fun interface Sleeper {
        fun sleep(millis: Long)
    }

    internal fun <T> execute(
        transport: () -> Response,
        parse: (Response) -> T,
    ): T {
        var attempt = 0
        while (true) {
            val response: Response = try {
                transport()
            } catch (e: SocketTimeoutException) {
                // Per the contract, timeouts are NOT auto-retried.
                throw SyrotpTimeoutError(message = e.message ?: "request timed out", cause = e)
            } catch (e: IOException) {
                val err = SyrotpNetworkError(
                    message = e.message ?: "network error",
                    cause = e,
                )
                if (attempt < maxRetries) {
                    sleeper.sleep(secondsToMillis(Backoff.seconds(attempt + 1)))
                    attempt++
                    continue
                }
                throw err
            }

            // We never call `parse` on a non-2xx response; map first,
            // throw the typed error, and let the catch decide retry.
            try {
                if (response.isSuccessful) {
                    response.use { return parse(it) }
                }
                response.use { throw errorFromResponse(it) }
            } catch (e: SyrotpError) {
                if (attempt < maxRetries && isRetriable(e)) {
                    val sleepMs = if (e is SyrotpRateLimitError && e.retryAfterSeconds != null) {
                        // Sleep at least Retry-After; jitter MAY add to it.
                        max(
                            secondsToMillis(Backoff.seconds(attempt + 1)),
                            (e.retryAfterSeconds!! * 1000L),
                        )
                    } else {
                        secondsToMillis(Backoff.seconds(attempt + 1))
                    }
                    sleeper.sleep(sleepMs)
                    attempt++
                    continue
                }
                throw e
            }
        }
    }

    private fun isRetriable(e: SyrotpError): Boolean = when (e) {
        is SyrotpNetworkError, is SyrotpServerError, is SyrotpRateLimitError -> true
        else -> false
    }

    private fun secondsToMillis(seconds: Double): Long =
        (seconds * 1000.0).toLong()

    private fun errorFromResponse(response: Response): SyrotpError {
        val status = response.code
        val text = response.body?.string().orEmpty()
        var code = "http_$status"
        var message = "request failed with status $status"
        var requestId: String? = null

        if (text.isNotEmpty()) {
            try {
                val parsed = JSON.parseToJsonElement(text)
                val errObj = (parsed as? JsonObject)?.get("error") as? JsonObject
                if (errObj != null) {
                    (errObj["code"] as? JsonPrimitive)?.contentOrNull?.let { code = it }
                    (errObj["message"] as? JsonPrimitive)?.contentOrNull?.let { message = it }
                    (errObj["request_id"] as? JsonPrimitive)?.contentOrNull?.let { requestId = it }
                }
            } catch (_: Throwable) {
                code = "bad_response"
                message = "non-JSON response (status $status)"
            }
        }

        return when (status) {
            401, 403 -> SyrotpAuthError(code, message, status, requestId)
            400 -> SyrotpValidationError(code, message, status, requestId)
            429 -> SyrotpRateLimitError(
                code = code,
                message = message,
                httpStatus = 429,
                requestId = requestId,
                retryAfterSeconds = parseRetryAfter(response.header("Retry-After")),
            )
            in 500..599 -> SyrotpServerError(code, message, status, requestId)
            else -> SyrotpError(code, message, status, requestId)
        }
    }

    private fun parseRetryAfter(value: String?): Int? {
        if (value.isNullOrBlank()) return null
        val n = value.trim().toIntOrNull() ?: return null
        return if (n < 0) 0 else n
    }

    private companion object {
        private val JSON = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}
