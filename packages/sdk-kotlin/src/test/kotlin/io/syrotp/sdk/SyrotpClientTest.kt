package io.syrotp.sdk

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

class SyrotpClientTest {

    private lateinit var server: MockWebServer

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    // ----- constructor validation ------------------------------------------

    @Test
    fun `constructor rejects missing base_url`() {
        val e = assertThrows(SyrotpConfigError::class.java) {
            SyrotpClient(baseUrl = "", apiKey = "sk_live_x")
        }
        assertTrue(e.message!!.contains("base_url"))
    }

    @Test
    fun `constructor rejects non-http base_url`() {
        assertThrows(SyrotpConfigError::class.java) {
            SyrotpClient(baseUrl = "ftp://x", apiKey = "sk_live_x")
        }
    }

    @Test
    fun `constructor rejects empty api_key`() {
        assertThrows(SyrotpConfigError::class.java) {
            SyrotpClient(baseUrl = "http://syrotp.test", apiKey = "")
        }
    }

    @Test
    fun `constructor rejects zero timeout`() {
        assertThrows(SyrotpConfigError::class.java) {
            SyrotpClient(baseUrl = "http://syrotp.test", apiKey = "sk_live_x", timeoutMs = 0)
        }
    }

    @Test
    fun `constructor rejects negative retries`() {
        assertThrows(SyrotpConfigError::class.java) {
            SyrotpClient(baseUrl = "http://syrotp.test", apiKey = "sk_live_x", retries = -1)
        }
    }

    @Test
    fun `user-agent includes sdk version`() {
        val client = TestServer.clientFor(server, userAgent = "my-app/1.0")
        assertTrue(client.resolvedUserAgent.startsWith("syrotp-sdk-kotlin/"))
        assertTrue(client.resolvedUserAgent.contains("my-app/1.0"))
    }

    @Test
    fun `user-agent strips control chars from suffix`() {
        val client = TestServer.clientFor(server, userAgent = "evil\r\nX-Injected: yes")
        assertTrue(!client.resolvedUserAgent.contains("\r"))
        assertTrue(!client.resolvedUserAgent.contains("\n"))
    }

    // ----- startVerification ------------------------------------------------

    @Test
    fun `startVerification posts to v1 verifications`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody(TestServer.verificationJson()))

        val client = TestServer.clientFor(server)
        val v = client.startVerification(phone = "+963991234567", purpose = "login")

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/verifications", req.path)
        assertEquals("Bearer sk_live_TESTKEY", req.getHeader("Authorization"))

        val body = Json.parseToJsonElement(req.body.readUtf8()) as JsonObject
        assertEquals("+963991234567", (body["phone"] as JsonPrimitive).contentOrNull)
        assertEquals("login", (body["purpose"] as JsonPrimitive).contentOrNull)
        assertNull(body["client_ref"])
        assertNull(body["locale"])

        assertEquals(VerificationStatus.PENDING, v.status)
        assertEquals("+963998887777", v.sendTo)
        assertEquals("VERIFY ABC123", v.message)
    }

    @Test
    fun `startVerification includes optional fields when provided`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody(TestServer.verificationJson()))

        TestServer.clientFor(server).startVerification(
            phone = "+1",
            purpose = "signup",
            clientRef = "user-42",
            locale = "en-US",
        )

        val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()) as JsonObject
        assertEquals("user-42", (body["client_ref"] as JsonPrimitive).contentOrNull)
        assertEquals("en-US", (body["locale"] as JsonPrimitive).contentOrNull)
    }

    @Test
    fun `startVerification rejects empty phone`() {
        // No response queued — client should fail before hitting the wire.
        assertThrows(SyrotpValidationError::class.java) {
            TestServer.clientFor(server).startVerification(phone = "", purpose = "login")
        }
    }

    // ----- getVerification --------------------------------------------------

    @Test
    fun `getVerification fetches by id`() {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                TestServer.verificationJson(status = "verified", verifiedAt = "2026-05-02T17:01:00.000Z"),
            ),
        )

        val v = TestServer.clientFor(server).getVerification("vrf_01HX")
        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/v1/verifications/vrf_01HX", req.path)
        assertEquals(VerificationStatus.VERIFIED, v.status)
        assertEquals("2026-05-02T17:01:00.000Z", v.verifiedAt)
    }

    @Test
    fun `getVerification rejects bad id`() {
        assertThrows(SyrotpValidationError::class.java) {
            TestServer.clientFor(server).getVerification("not-a-vrf-id")
        }
    }

    // ----- cancelVerification -----------------------------------------------

    @Test
    fun `cancelVerification posts to cancel path`() {
        server.enqueue(MockResponse().setResponseCode(200).setBody(TestServer.verificationJson(status = "cancelled")))

        val v = TestServer.clientFor(server).cancelVerification("vrf_01HX")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/v1/verifications/vrf_01HX/cancel", req.path)
        assertEquals(VerificationStatus.CANCELLED, v.status)
    }

    // ----- error mapping ----------------------------------------------------

    @Test
    fun `401 raises SyrotpAuthError`() {
        server.enqueue(
            MockResponse().setResponseCode(401)
                .setBody(TestServer.errorJson("unauthorized", "missing creds", "req_xyz")),
        )

        val e = assertThrows(SyrotpAuthError::class.java) {
            TestServer.clientFor(server).startVerification(phone = "+1", purpose = "x")
        }
        assertEquals("unauthorized", e.code)
        assertEquals(401, e.httpStatus)
        assertEquals("req_xyz", e.requestId)
    }

    @Test
    fun `400 raises SyrotpValidationError`() {
        server.enqueue(
            MockResponse().setResponseCode(400)
                .setBody(TestServer.errorJson("validation_error", "bad phone")),
        )
        assertThrows(SyrotpValidationError::class.java) {
            TestServer.clientFor(server).startVerification(phone = "+1", purpose = "x")
        }
    }

    @Test
    fun `500 raises SyrotpServerError`() {
        server.enqueue(
            MockResponse().setResponseCode(500)
                .setBody(TestServer.errorJson("internal_error", "boom")),
        )
        assertThrows(SyrotpServerError::class.java) {
            TestServer.clientFor(server).startVerification(phone = "+1", purpose = "x")
        }
    }

    // ----- forward-compat ---------------------------------------------------

    @Test
    fun `unknown status maps to UNKNOWN`() {
        server.enqueue(MockResponse().setResponseCode(201).setBody(TestServer.verificationJson(status = "quantum_uncertain")))
        val v = TestServer.clientFor(server).startVerification(phone = "+1", purpose = "x")
        assertEquals(VerificationStatus.UNKNOWN, v.status)
    }

    @Test
    fun `unknown response fields preserved in extras`() {
        server.enqueue(
            MockResponse().setResponseCode(201)
                .setBody(TestServer.verificationJson(extraFields = mapOf("future_field" to "42"))),
        )
        val v = TestServer.clientFor(server).startVerification(phone = "+1", purpose = "x")
        assertNotNull(v.extras["future_field"])
    }
}
