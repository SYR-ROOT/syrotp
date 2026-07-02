package io.syrotp.sdk

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.util.logging.Level
import java.util.logging.Logger
import java.util.logging.SimpleFormatter
import java.util.logging.StreamHandler

/**
 * Canary tests for `docs/sdk-generation.md` §5.
 *
 * If the api_key or the user's phone ever leak into a log line or an
 * error rendering, these will fail.
 */
class SecurityTest {

    private lateinit var server: MockWebServer

    @BeforeEach fun setUp() { server = MockWebServer().also { it.start() } }
    @AfterEach fun tearDown() { server.shutdown() }

    @Test
    fun `api_key never appears in error toString`() {
        val rendered = SyrotpAuthError("unauthorized", "missing creds", 401).toString()
        assertFalse(rendered.contains(CANARY_API_KEY))
    }

    @Test
    fun `phone never appears in any syrotp logger output`() {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                TestServer.verificationJson(
                    sendTo = "+1",
                    message = "VERIFY ABC",
                ),
            ),
        )

        val captured = captureSyrotpLogs {
            val client = SyrotpClient(
                baseUrl = server.url("/").toString().trimEnd('/'),
                apiKey = CANARY_API_KEY,
                timeoutMs = 5_000,
            )
            client.startVerification(phone = CANARY_PHONE, purpose = "login")
        }
        assertFalse(captured.contains(CANARY_PHONE), "phone leaked into syrotp logger: $captured")
        assertFalse(captured.contains(CANARY_API_KEY), "api_key leaked into syrotp logger: $captured")
    }

    @Test
    fun `cleartext base_url to public host logs warning`() {
        val captured = captureSyrotpLogs {
            // Just construct — no requests needed for the warning.
            SyrotpClient(baseUrl = "http://otp.example.com", apiKey = "sk_live_x")
        }
        assertTrue(captured.contains("plain HTTP"), "expected cleartext warning, got: $captured")
    }

    @Test
    fun `cleartext to localhost or RFC1918 does not warn`() {
        val captured = captureSyrotpLogs {
            SyrotpClient(baseUrl = "http://localhost:3000", apiKey = "sk_live_x")
            SyrotpClient(baseUrl = "http://127.0.0.1:3000", apiKey = "sk_live_x")
            SyrotpClient(baseUrl = "http://10.0.0.1", apiKey = "sk_live_x")
            SyrotpClient(baseUrl = "http://192.168.1.1", apiKey = "sk_live_x")
            SyrotpClient(baseUrl = "http://172.16.0.1", apiKey = "sk_live_x")
        }
        assertFalse(captured.contains("plain HTTP"), "should not warn for private hosts: $captured")
    }

    private fun captureSyrotpLogs(block: () -> Unit): String {
        val logger = Logger.getLogger("syrotp")
        val buf = ByteArrayOutputStream()
        val handler = StreamHandler(buf, SimpleFormatter()).apply { level = Level.ALL }
        val originalLevel = logger.level
        val originalUseParents = logger.useParentHandlers
        logger.addHandler(handler)
        logger.useParentHandlers = false
        logger.level = Level.ALL
        try {
            block()
        } finally {
            handler.flush()
            logger.removeHandler(handler)
            logger.useParentHandlers = originalUseParents
            logger.level = originalLevel
        }
        return buf.toString(Charsets.UTF_8)
    }

    private companion object {
        // Sentinels chosen so they're unmistakable if they leak.
        private const val CANARY_API_KEY = "sk_live_TESTSENTINEL_DO_NOT_LOG_THIS"
        private const val CANARY_PHONE = "+99999999999999"
    }
}
