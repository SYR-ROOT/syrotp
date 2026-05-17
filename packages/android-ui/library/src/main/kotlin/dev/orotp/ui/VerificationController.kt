package dev.syrotp.ui

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Snapshot of the verification + countdown shown to the user on
 * each tick. Held by the controller's [StateFlow]; the Compose
 * layer collects this as state.
 */
data class VerificationState(
    val verification: Verification,
    val secondsLeft: Long,
)

/**
 * Framework-agnostic state machine driving the SYROTP verification
 * lifecycle on Android. Polls `${baseUrl}/v/:id/status` (the
 * public, IP-rate-limited endpoint shipped in SYROTP server v0.5.0),
 * runs a 1Hz countdown, and emits a fresh [VerificationState] on
 * every visible change.
 *
 * Designed to live independent of Compose so unit tests can run on
 * the JVM without Robolectric or instrumented tests. The contract
 * is intentionally identical to `useSyrotpVerification` in
 * `@syrotp/react` and `VerificationController` in
 * `@syrotp/web-component`: same URL shape, same merge rules, same
 * local TTL fallback.
 *
 * Lifecycle:
 *   - [start] launches polling + countdown coroutines as children
 *     of the supplied parent scope. Calling start a second time is
 *     a no-op.
 *   - [stop] cancels the scope. Safe to call from
 *     `DisposableEffect.onDispose`.
 *
 * The constructor takes a `nowMs` clock for testability — pass a
 * fake clock to drive the local TTL fallback path deterministically
 * in unit tests.
 */
class VerificationController(
    private val baseUrl: String,
    initial: Verification,
    private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
    private val httpClient: OkHttpClient = defaultHttpClient(),
    private val onVerified: (Verification) -> Unit = {},
    private val onExpired: (Verification) -> Unit = {},
    private val onCancelled: (Verification) -> Unit = {},
    private val onError: (Throwable) -> Unit = {},
    private val nowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val _state = MutableStateFlow(
        VerificationState(
            verification = initial,
            secondsLeft = secondsLeftFrom(initial.expiresAt, nowMs()),
        ),
    )
    val state: StateFlow<VerificationState> = _state.asStateFlow()

    private var scope: CoroutineScope? = null

    fun start(parent: CoroutineScope) {
        if (scope != null) return
        val s = CoroutineScope(parent.coroutineContext + SupervisorJob())
        scope = s
        if (_state.value.verification.status.isTerminal) return
        s.launch { runCountdown() }
        s.launch { runPolling() }
    }

    fun stop() {
        scope?.cancel()
        scope = null
    }

    private suspend fun runCountdown() {
        while (scopeActive()) {
            val v = _state.value.verification
            if (v.status.isTerminal) return
            val secs = secondsLeftFrom(v.expiresAt, nowMs())
            if (secs <= 0L) {
                transition(
                    v.copy(
                        status = VerificationStatus.Expired,
                        sendTo = null,
                        message = null,
                    ),
                )
                return
            }
            if (secs != _state.value.secondsLeft) {
                _state.value = _state.value.copy(secondsLeft = secs)
            }
            delay(COUNTDOWN_TICK_MS)
        }
    }

    private suspend fun runPolling() {
        // Fire one immediate poll so a fast-completing verification
        // surfaces without waiting a full interval.
        pollOnce()
        while (scopeActive()) {
            delay(pollIntervalMs)
            if (_state.value.verification.status.isTerminal) return
            pollOnce()
        }
    }

    private suspend fun pollOnce() {
        val v = _state.value.verification
        if (v.status.isTerminal) return
        val url = "${baseUrl.trimEnd('/')}/v/${v.id}/status"
        val req = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .get()
            .build()
        try {
            val raw = withContext(Dispatchers.IO) {
                httpClient.newCall(req).execute().use { res ->
                    if (!res.isSuccessful) {
                        throw IOException("status poll failed: HTTP ${res.code}")
                    }
                    res.body?.string() ?: throw IOException("empty body")
                }
            }
            val parsed = jsonCodec.decodeFromString<StatusResponse>(raw)
            val current = _state.value.verification
            if (parsed.status == current.status) {
                if (parsed.expiresAt != current.expiresAt) {
                    val updated = current.copy(expiresAt = parsed.expiresAt)
                    _state.value = VerificationState(
                        verification = updated,
                        secondsLeft = secondsLeftFrom(updated.expiresAt, nowMs()),
                    )
                }
                return
            }
            transition(
                current.copy(
                    status = parsed.status,
                    expiresAt = parsed.expiresAt,
                    verifiedAt = parsed.verifiedAt,
                    sendTo = if (parsed.status == VerificationStatus.Pending) current.sendTo else null,
                    message = if (parsed.status == VerificationStatus.Pending) current.message else null,
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            onError(e)
        }
    }

    private fun transition(next: Verification) {
        val prev = _state.value.verification.status
        _state.value = VerificationState(
            verification = next,
            secondsLeft = secondsLeftFrom(next.expiresAt, nowMs()),
        )
        if (prev != next.status && prev == VerificationStatus.Pending) {
            when (next.status) {
                VerificationStatus.Verified -> onVerified(next)
                VerificationStatus.Expired -> onExpired(next)
                VerificationStatus.Cancelled -> onCancelled(next)
                else -> Unit
            }
        }
    }

    private fun scopeActive(): Boolean = scope?.isActive == true

    @Serializable
    private data class StatusResponse(
        val status: VerificationStatus,
        @SerialName("expires_at") val expiresAt: String,
        @SerialName("verified_at") val verifiedAt: String? = null,
    )

    companion object {
        const val DEFAULT_POLL_INTERVAL_MS: Long = 2500L
        private const val COUNTDOWN_TICK_MS: Long = 1000L

        private val jsonCodec = Json { ignoreUnknownKeys = true }

        private fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build()

        internal fun secondsLeftFrom(expiresAt: String, nowMs: Long): Long {
            val expiresMs = try {
                Instant.parse(expiresAt).toEpochMilli()
            } catch (_: Throwable) {
                return 0L
            }
            return ((expiresMs - nowMs) / 1000L).coerceAtLeast(0L)
        }
    }
}
