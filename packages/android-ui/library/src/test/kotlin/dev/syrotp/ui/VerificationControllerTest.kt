package dev.syrotp.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * JVM unit tests for [VerificationController]. The controller is
 * pure Kotlin (no Android, no Compose), so a real MockWebServer
 * + a CoroutineScope on Dispatchers.Default is enough to exercise
 * every contract assertion.
 */
class VerificationControllerTest {

    private lateinit var server: MockWebServer
    private lateinit var scope: CoroutineScope

    @Before
    fun setup() {
        server = MockWebServer()
        server.start()
        scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    }

    @After
    fun teardown() {
        server.shutdown()
        scope.cancel()
    }

    private fun mkVerification(
        id: String = "vrf_abc123",
        status: VerificationStatus = VerificationStatus.Pending,
        expiresAt: String = Instant.now().plusSeconds(600).toString(),
    ): Verification = Verification(
        id = id,
        status = status,
        sendTo = "+963998887777",
        message = "VERIFY 123456",
        phoneMasked = "+963 99* *** *567",
        expiresAt = expiresAt,
        verifiedAt = null,
    )

    private fun pendingResponseBody(expiresAt: String = mkExpiresAt()): String =
        """{"status":"pending","expires_at":"$expiresAt","verified_at":null}"""

    private fun mkExpiresAt(): String = Instant.now().plusSeconds(600).toString()

    @Test
    fun `polls v_id_status against the configured baseUrl with trailing slash trimmed`() = runBlocking {
        server.enqueue(MockResponse().setBody(pendingResponseBody()))
        val baseUrl = server.url("/").toString() // ends with `/`
        val c = VerificationController(
            baseUrl = baseUrl,
            initial = mkVerification(),
            pollIntervalMs = 50L,
        )
        c.start(scope)
        val req: RecordedRequest = server.takeRequest(2, TimeUnit.SECONDS)!!
        assertEquals("/v/vrf_abc123/status", req.path)
        c.stop()
    }

    @Test
    fun `transitions to verified and clears send_to and message on the wire`() = runBlocking {
        val verifiedAt = Instant.now().toString()
        server.enqueue(
            MockResponse().setBody(
                """{"status":"verified","expires_at":"${mkExpiresAt()}","verified_at":"$verifiedAt"}""",
            ),
        )
        val received = AtomicReference<Verification?>(null)
        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(),
            pollIntervalMs = 50L,
            onVerified = { received.set(it) },
        )
        c.start(scope)
        val terminal = withTimeout(3000) {
            c.state.first { it.verification.status == VerificationStatus.Verified }
        }
        c.stop()

        assertEquals(VerificationStatus.Verified, terminal.verification.status)
        assertNull(terminal.verification.sendTo)
        assertNull(terminal.verification.message)
        assertEquals(verifiedAt, terminal.verification.verifiedAt)
        assertNotNull(received.get())
    }

    @Test
    fun `fires onCancelled on the pending to cancelled transition`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"status":"cancelled","expires_at":"${mkExpiresAt()}","verified_at":null}""",
            ),
        )
        val received = AtomicReference<Verification?>(null)
        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(),
            pollIntervalMs = 50L,
            onCancelled = { received.set(it) },
        )
        c.start(scope)
        withTimeout(3000) {
            c.state.first { it.verification.status == VerificationStatus.Cancelled }
        }
        c.stop()
        assertNotNull(received.get())
    }

    @Test
    fun `fires onExpired when the server reports expired`() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"status":"expired","expires_at":"${mkExpiresAt()}","verified_at":null}""",
            ),
        )
        val received = AtomicReference<Verification?>(null)
        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(),
            pollIntervalMs = 50L,
            onExpired = { received.set(it) },
        )
        c.start(scope)
        withTimeout(3000) {
            c.state.first { it.verification.status == VerificationStatus.Expired }
        }
        c.stop()
        assertNotNull(received.get())
    }

    @Test
    fun `calls onError on HTTP failure but keeps state pending`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        // Subsequent polls should not flip the state — enqueue another 500.
        server.enqueue(MockResponse().setResponseCode(500).setBody("{}"))
        val errors = AtomicReference<Throwable?>(null)
        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(),
            pollIntervalMs = 50L,
            onError = { errors.set(it) },
        )
        c.start(scope)
        // Wait until at least one error reached our handler.
        withTimeout(3000) {
            while (errors.get() == null) {
                kotlinx.coroutines.delay(20)
            }
        }
        c.stop()
        assertEquals(VerificationStatus.Pending, c.state.value.verification.status)
        assertNotNull(errors.get())
    }

    @Test
    fun `does not poll when the initial state is already terminal`() = runBlocking {
        server.enqueue(MockResponse().setBody(pendingResponseBody()))
        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(
                status = VerificationStatus.Verified,
            ).copy(sendTo = null, message = null, verifiedAt = Instant.now().toString()),
            pollIntervalMs = 30L,
        )
        c.start(scope)
        // Nothing should hit the server. takeRequest blocks until a real
        // request arrives, so we cap the wait and assert nothing came in.
        val req = server.takeRequest(150, TimeUnit.MILLISECONDS)
        assertNull(req)
        c.stop()
    }

    @Test
    fun `local TTL fallback fires onExpired when expires_at passes`() = runBlocking {
        // No polling responses — hold the connection so polling stalls
        // and the local countdown drives the transition.
        server.enqueue(MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.NO_RESPONSE))

        val now = AtomicReference(0L)
        val received = AtomicReference<Verification?>(null)
        val expiresAt = Instant.ofEpochMilli(2000L).toString()

        val c = VerificationController(
            baseUrl = server.url("/").toString(),
            initial = mkVerification(expiresAt = expiresAt),
            pollIntervalMs = 100_000L,
            onExpired = { received.set(it) },
            nowMs = { now.get() },
        )
        c.start(scope)
        // Walk the fake clock past expires_at — the countdown coroutine
        // ticks every second of real time, so we just step time forward
        // and let it observe the new value on its next tick.
        now.set(3000L)
        withTimeout(4000) {
            c.state.first { it.verification.status == VerificationStatus.Expired }
        }
        c.stop()
        assertNotNull(received.get())
        assertNull(received.get()!!.sendTo)
        assertNull(received.get()!!.message)
    }

    @Test
    fun `secondsLeftFrom never returns negative`() {
        val past = Instant.ofEpochMilli(1000L).toString()
        val secs = VerificationController.secondsLeftFrom(past, 5000L)
        assertTrue("expected non-negative seconds, got $secs", secs >= 0L)
    }
}
