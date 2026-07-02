package io.syrotp.sdk

import io.syrotp.sdk.internal.HttpExecutor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.Closeable
import java.util.concurrent.TimeUnit
import java.util.logging.Logger

/**
 * Synchronous SYROTP client for JVM.
 *
 * Conforms to `docs/sdk-contract.md`. Use as an [AutoCloseable] /
 * [Closeable] so the underlying connection pool is released
 * deterministically:
 *
 * ```
 * SyrotpClient(baseUrl = "...", apiKey = "...").use { client ->
 *     val v = client.startVerification(phone = "+963991234567", purpose = "login")
 * }
 * ```
 */
public class SyrotpClient internal constructor(
    baseUrl: String,
    private val apiKey: String,
    /** Per-request deadline. NEVER infinite. */
    public val timeoutMs: Long,
    /** Max retries on retriable failures (network / 5xx / 429). */
    public val retries: Int,
    userAgent: String?,
    okHttpClient: OkHttpClient?,
    sleeper: HttpExecutor.Sleeper,
) : Closeable {

    /**
     * Public constructor with sane defaults. The internal primary
     * constructor takes a [HttpExecutor.Sleeper] for test injection;
     * application code uses this overload and gets `Thread::sleep`.
     */
    @JvmOverloads
    public constructor(
        baseUrl: String,
        apiKey: String,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
        retries: Int = DEFAULT_RETRIES,
        userAgent: String? = null,
        okHttpClient: OkHttpClient? = null,
    ) : this(
        baseUrl = baseUrl,
        apiKey = apiKey,
        timeoutMs = timeoutMs,
        retries = retries,
        userAgent = userAgent,
        okHttpClient = okHttpClient,
        sleeper = HttpExecutor.Sleeper { Thread.sleep(it) },
    )

    private val log: Logger = Logger.getLogger("syrotp")
    private val json: Json = Json { ignoreUnknownKeys = true; isLenient = true }

    private val baseUrl: String

    /** Visible for tests. */
    internal val resolvedUserAgent: String

    private val http: OkHttpClient
    private val ownsHttp: Boolean
    private val executor: HttpExecutor

    init {
        if (baseUrl.isBlank()) throw SyrotpConfigError("base_url is required")
        if (!HTTP_URL_RE.matches(baseUrl)) throw SyrotpConfigError("base_url must be an http(s) URL")
        if (apiKey.isBlank()) throw SyrotpConfigError("api_key is required")
        if (timeoutMs <= 0) throw SyrotpConfigError("timeout_ms must be a positive int")
        if (retries < 0) throw SyrotpConfigError("retries must be a non-negative int")

        this.baseUrl = baseUrl.trimEnd('/')
        this.resolvedUserAgent = buildUserAgent(userAgent)

        if (baseUrl.lowercase().startsWith("http://") && !isLoopbackOrPrivate(baseUrl)) {
            log.warning(
                "syrotp-sdk: base_url is plain HTTP to a non-private host (${hostOnly(baseUrl)}); " +
                    "use https:// in production",
            )
        }

        if (okHttpClient != null) {
            this.http = okHttpClient.newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()
            this.ownsHttp = false
        } else {
            this.http = OkHttpClient.Builder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .connectTimeout(minOf(15_000L, timeoutMs), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()
            this.ownsHttp = true
        }
        this.executor = HttpExecutor(maxRetries = retries, sleeper = sleeper)
    }

    public override fun close() {
        if (ownsHttp) {
            http.dispatcher.executorService.shutdown()
            http.connectionPool.evictAll()
        }
    }

    // ----- public API -------------------------------------------------------

    public fun startVerification(
        phone: String,
        purpose: String,
        clientRef: String? = null,
        locale: String? = null,
    ): Verification {
        if (phone.isBlank()) throw SyrotpValidationError("validation_error", "phone is required")
        if (purpose.isBlank()) throw SyrotpValidationError("validation_error", "purpose is required")

        val body = buildJsonObject {
            put("phone", phone)
            put("purpose", purpose)
            if (clientRef != null) put("client_ref", clientRef)
            if (locale != null) put("locale", locale)
        }
        val obj = post("/v1/verifications", body)
        return Verification.fromJson(obj)
    }

    public fun getVerification(verificationId: String): Verification {
        validateVerificationId(verificationId)
        val obj = get("/v1/verifications/$verificationId")
        return Verification.fromJson(obj)
    }

    /**
     * The server is naturally idempotent here, but a runaway retry loop
     * is still observable in audit logs — so this method's retry budget
     * is capped at 1 regardless of the client's [retries] setting
     * (see `docs/sdk-generation.md` §7).
     */
    public fun cancelVerification(verificationId: String): Verification {
        validateVerificationId(verificationId)
        val capped = HttpExecutor(maxRetries = minOf(retries, 1))
        val obj = doRequest("POST", "/v1/verifications/$verificationId/cancel", body = null, executor = capped)
        return Verification.fromJson(obj)
    }

    public fun waitForVerification(
        verificationId: String,
        intervalMs: Long = DEFAULT_WAIT_INTERVAL_MS,
        timeoutMs: Long = DEFAULT_WAIT_TIMEOUT_MS,
    ): Verification {
        if (timeoutMs <= 0) throw SyrotpConfigError("wait timeout_ms must be positive")
        // Floor the interval at 2 s — the server enforces a per-IP read
        // rate limit, so polling faster only means more 429s.
        val effectiveInterval = maxOf(MIN_WAIT_INTERVAL_MS, intervalMs)
        val deadlineNs = System.nanoTime() + timeoutMs * 1_000_000

        while (true) {
            val v = getVerification(verificationId)
            if (v.status != VerificationStatus.PENDING) return v
            val nowNs = System.nanoTime()
            if (nowNs >= deadlineNs) {
                throw SyrotpTimeoutError("waitForVerification deadline expired")
            }
            val remainingMs = (deadlineNs - nowNs) / 1_000_000
            Thread.sleep(minOf(effectiveInterval, remainingMs.coerceAtLeast(0)))
        }
    }

    // ----- internals --------------------------------------------------------

    private fun get(path: String): JsonObject =
        doRequest("GET", path, body = null, executor = executor)

    private fun post(path: String, body: JsonObject): JsonObject =
        doRequest("POST", path, body = body, executor = executor)

    private fun doRequest(
        method: String,
        path: String,
        body: JsonObject?,
        executor: HttpExecutor,
    ): JsonObject {
        val url = baseUrl + path
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $apiKey")
            .header("User-Agent", resolvedUserAgent)
            .header("Accept", "application/json")
            .apply {
                when (method) {
                    "GET" -> get()
                    "POST" -> {
                        val payload = (body?.toString() ?: EMPTY_JSON).toByteArray(Charsets.UTF_8)
                        post(payload.toRequestBody(JSON_MEDIA_TYPE))
                    }
                    else -> throw SyrotpError("invalid_method", "unsupported HTTP method $method")
                }
            }
            .build()

        return executor.execute(
            transport = { http.newCall(request).execute() },
            parse = { response ->
                val text = response.body?.string().orEmpty()
                if (text.isEmpty()) {
                    throw SyrotpError(
                        code = "bad_response",
                        message = "empty response body (status ${response.code})",
                        httpStatus = response.code,
                    )
                }
                val parsed = try {
                    json.parseToJsonElement(text)
                } catch (e: Throwable) {
                    throw SyrotpError(
                        code = "bad_response",
                        message = "non-JSON response (status ${response.code})",
                        httpStatus = response.code,
                        cause = e,
                    )
                }
                parsed as? JsonObject ?: throw SyrotpError(
                    code = "bad_response",
                    message = "unexpected JSON shape (status ${response.code})",
                    httpStatus = response.code,
                )
            },
        )
    }

    private fun buildUserAgent(suffix: String?): String {
        val base = "syrotp-sdk-kotlin/$VERSION"
        if (suffix.isNullOrBlank()) return base
        // Strip CR/LF/NUL so a caller-supplied suffix can't inject a
        // second header line.
        val clean = suffix.replace(Regex("[\\r\\n\\u0000]"), "").trim()
        return if (clean.isEmpty()) base else "$base $clean"
    }

    private fun validateVerificationId(id: String) {
        if (!VERIFICATION_ID_RE.matches(id)) {
            throw SyrotpValidationError(
                code = "validation_error",
                message = "verification_id must match ^vrf_[A-Za-z0-9]+\$",
            )
        }
    }

    public companion object {
        public const val VERSION: String = "0.1.0"
        public const val DEFAULT_TIMEOUT_MS: Long = 15_000L
        public const val DEFAULT_RETRIES: Int = 2
        public const val DEFAULT_WAIT_INTERVAL_MS: Long = 2_500L
        public const val DEFAULT_WAIT_TIMEOUT_MS: Long = 5L * 60_000L
        public const val MIN_WAIT_INTERVAL_MS: Long = 2_000L

        private val HTTP_URL_RE = Regex("^https?://.+", RegexOption.IGNORE_CASE)
        private val VERIFICATION_ID_RE = Regex("^vrf_[A-Za-z0-9]+$")
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
        private const val EMPTY_JSON = "{}"

        private fun isLoopbackOrPrivate(url: String): Boolean {
            val host = hostOnly(url)
            if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true
            if (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("169.254.")) return true
            if (host.startsWith("172.")) {
                val second = host.split('.', limit = 3).getOrNull(1)?.toIntOrNull() ?: return false
                if (second in 16..31) return true
            }
            return false
        }

        private fun hostOnly(url: String): String {
            val rest = url.substringAfter("://")
            return rest.substringBefore('/').substringBefore(':').lowercase()
        }
    }
}
