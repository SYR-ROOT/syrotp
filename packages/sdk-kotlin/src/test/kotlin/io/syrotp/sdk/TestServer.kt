package io.syrotp.sdk

import io.syrotp.sdk.internal.HttpExecutor
import okhttp3.mockwebserver.MockWebServer

/**
 * Shared test plumbing.
 *
 * `noopSleeper` lets retry-policy tests skip wall-clock time without
 * spinning real threads.
 *
 * `clientFor` builds an SyrotpClient pointed at a MockWebServer, with
 * `retries=0` by default for deterministic single-shot assertions.
 */
internal object TestServer {

    internal val noopSleeper: HttpExecutor.Sleeper =
        HttpExecutor.Sleeper { /* don't actually sleep */ }

    internal val recordingSleeper: () -> Pair<MutableList<Long>, HttpExecutor.Sleeper> = {
        val captured = mutableListOf<Long>()
        captured to HttpExecutor.Sleeper { captured.add(it) }
    }

    internal fun clientFor(
        server: MockWebServer,
        apiKey: String = "sk_live_TESTKEY",
        retries: Int = 0,
        userAgent: String? = null,
        sleeper: HttpExecutor.Sleeper = noopSleeper,
    ): SyrotpClient = SyrotpClient(
        baseUrl = server.url("/").toString().trimEnd('/'),
        apiKey = apiKey,
        timeoutMs = 5_000,
        retries = retries,
        userAgent = userAgent,
        okHttpClient = null,
        sleeper = sleeper,
    )

    internal fun verificationJson(
        id: String = "vrf_01HX",
        status: String = "pending",
        sendTo: String? = "+963998887777",
        message: String? = "VERIFY ABC123",
        verifiedAt: String? = null,
        extraFields: Map<String, String> = emptyMap(),
    ): String {
        val parts = mutableListOf<String>()
        parts.add("\"id\": \"$id\"")
        parts.add("\"status\": \"$status\"")
        parts.add("\"phone_masked\": \"+96399****567\"")
        if (sendTo != null) parts.add("\"send_to\": \"$sendTo\"")
        if (message != null) parts.add("\"message\": \"$message\"")
        parts.add("\"purpose\": \"login\"")
        if (verifiedAt != null) parts.add("\"verified_at\": \"$verifiedAt\"")
        parts.add("\"expires_at\": \"2026-05-02T18:00:00.000Z\"")
        parts.add("\"created_at\": \"2026-05-02T17:00:00.000Z\"")
        for ((k, v) in extraFields) {
            parts.add("\"$k\": $v")
        }
        return "{ ${parts.joinToString(", ")} }"
    }

    internal fun errorJson(code: String, message: String, requestId: String? = null): String {
        val rid = if (requestId != null) ", \"request_id\": \"$requestId\"" else ""
        return "{ \"error\": { \"code\": \"$code\", \"message\": \"$message\"$rid } }"
    }
}
