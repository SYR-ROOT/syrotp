package io.syrotp.sdk

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Pins the retry policy from `docs/sdk-generation.md` §7.
 *
 *   Retry on:    network / 5xx / 429 (with Retry-After honored)
 *   Never on:    400 / 401 / 403 / 4xx-other / timeout / config
 */
class RetriesTest {

    private lateinit var server: MockWebServer

    @BeforeEach fun setUp() { server = MockWebServer().also { it.start() } }
    @AfterEach fun tearDown() { server.shutdown() }

    @Test
    fun `5xx is retried until success`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody(TestServer.errorJson("down", "no")))
        server.enqueue(MockResponse().setResponseCode(503).setBody(TestServer.errorJson("down", "no")))
        server.enqueue(MockResponse().setResponseCode(200).setBody(TestServer.verificationJson(status = "verified")))

        val v = TestServer.clientFor(server, retries = 3).getVerification("vrf_01HX")
        assertEquals(VerificationStatus.VERIFIED, v.status)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `5xx eventually raises after retry budget exhausted`() {
        repeat(3) { server.enqueue(MockResponse().setResponseCode(503).setBody(TestServer.errorJson("down", "no"))) }

        assertThrows(SyrotpServerError::class.java) {
            TestServer.clientFor(server, retries = 2).getVerification("vrf_01HX")
        }
        // 1 initial + 2 retries.
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `429 respects Retry-After`() {
        val (sleeps, sleeper) = TestServer.recordingSleeper()
        server.enqueue(
            MockResponse().setResponseCode(429)
                .addHeader("Retry-After", "7")
                .setBody(TestServer.errorJson("rate_limited", "slow")),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody(TestServer.verificationJson()))

        TestServer.clientFor(server, retries = 2, sleeper = sleeper).getVerification("vrf_01HX")
        // The SDK MUST sleep at least 7000 ms before retrying the 429.
        assertTrue(sleeps.any { it >= 7_000L }) { "expected a sleep >= 7000ms, got $sleeps" }
    }

    @Test
    fun `garbage Retry-After does not crash`() {
        server.enqueue(
            MockResponse().setResponseCode(429)
                .addHeader("Retry-After", "not-a-number")
                .setBody(TestServer.errorJson("rate_limited", "slow")),
        )
        server.enqueue(MockResponse().setResponseCode(200).setBody(TestServer.verificationJson()))

        TestServer.clientFor(server, retries = 2).getVerification("vrf_01HX")
        assertEquals(2, server.requestCount)
    }

    @Test
    fun `400 is not retried`() {
        server.enqueue(MockResponse().setResponseCode(400).setBody(TestServer.errorJson("validation_error", "bad")))

        assertThrows(SyrotpValidationError::class.java) {
            TestServer.clientFor(server, retries = 5).getVerification("vrf_01HX")
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `401 is not retried`() {
        server.enqueue(MockResponse().setResponseCode(401).setBody(TestServer.errorJson("unauthorized", "no")))

        assertThrows(SyrotpAuthError::class.java) {
            TestServer.clientFor(server, retries = 5).getVerification("vrf_01HX")
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `zero retries means a single attempt`() {
        server.enqueue(MockResponse().setResponseCode(503).setBody(TestServer.errorJson("down", "no")))

        assertThrows(SyrotpServerError::class.java) {
            TestServer.clientFor(server, retries = 0).getVerification("vrf_01HX")
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `cancelVerification caps retries at one even when client allows more`() {
        // Queue many 503s so we'd retry forever if the cap weren't there.
        repeat(10) { server.enqueue(MockResponse().setResponseCode(503).setBody(TestServer.errorJson("down", "no"))) }

        assertThrows(SyrotpServerError::class.java) {
            TestServer.clientFor(server, retries = 10).cancelVerification("vrf_01HX")
        }
        // 1 initial + 1 retry maximum.
        assertTrue(server.requestCount <= 2) { "expected <=2 requests, got ${server.requestCount}" }
    }
}
