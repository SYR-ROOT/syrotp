package dev.syrotp.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SmsIntentTest {

    @Test
    fun `encodeSmsBody percent-encodes spaces as 20 not plus`() {
        assertEquals("VERIFY%20123456", SmsIntent.encodeSmsBody("VERIFY 123456"))
    }

    @Test
    fun `encodeSmsBody percent-encodes special characters consistently with encodeURIComponent`() {
        // `?` and `&` would break the URI if left raw — they must be percent-encoded.
        assertEquals("a%26b", SmsIntent.encodeSmsBody("a&b"))
        assertEquals("a%3Fb", SmsIntent.encodeSmsBody("a?b"))
        assertEquals("a%23b", SmsIntent.encodeSmsBody("a#b"))
    }

    @Test
    fun `encodeSmsBody keeps ASCII letters and digits as-is`() {
        assertEquals("ABC123abc", SmsIntent.encodeSmsBody("ABC123abc"))
    }
}
