package io.syrotp.sdk

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ErrorsTest {

    @Test
    fun `all seven typed errors inherit from SyrotpError`() {
        val errors: List<SyrotpError> = listOf(
            SyrotpConfigError("x"),
            SyrotpAuthError("unauthorized", "x", 401),
            SyrotpValidationError("validation_error", "x"),
            SyrotpRateLimitError("rate_limited", "x"),
            SyrotpNetworkError(message = "x"),
            SyrotpServerError("internal_error", "x", 500),
            SyrotpTimeoutError(),
        )
        // Compile-time check: they all assign to SyrotpError. Runtime
        // check too just to be safe.
        for (e in errors) assertTrue(e is SyrotpError)
    }

    @Test
    fun `each error has the four core attributes`() {
        val e = SyrotpAuthError("unauthorized", "missing creds", 401, "req_xyz")
        assertEquals("unauthorized", e.code)
        assertEquals("missing creds", e.message)
        assertEquals(401, e.httpStatus)
        assertEquals("req_xyz", e.requestId)
    }

    @Test
    fun `rate limit error carries retryAfterSeconds`() {
        val e = SyrotpRateLimitError("rate_limited", "slow", retryAfterSeconds = 42)
        assertEquals(42, e.retryAfterSeconds)
        assertEquals(429, e.httpStatus)
    }

    @Test
    fun `toString includes class, code, message, httpStatus, requestId`() {
        val rendered = SyrotpAuthError("unauthorized", "missing creds", 401, "req_xyz").toString()
        assertTrue(rendered.contains("SyrotpAuthError"))
        assertTrue(rendered.contains("unauthorized"))
        assertTrue(rendered.contains("missing creds"))
        assertTrue(rendered.contains("401"))
        assertTrue(rendered.contains("req_xyz"))
    }

    @Test
    fun `toString does not echo arbitrary attributes`() {
        val rendered = SyrotpAuthError("unauthorized", "missing creds", 401, "req_xyz").toString()
        // Standard attributes show; nothing about request body, headers, or api_key.
        assertFalse(rendered.lowercase().contains("api_key"))
        assertFalse(rendered.lowercase().contains("authorization"))
    }

    @Test
    fun `network error preserves cause`() {
        val cause = RuntimeException("connection refused")
        val e = SyrotpNetworkError(message = "transport failed", cause = cause)
        assertEquals(cause, e.cause)
    }

    @Test
    fun `timeout error has stable code`() {
        val e = SyrotpTimeoutError()
        assertEquals("timeout", e.code)
        assertNotNull(e.message)
    }
}
