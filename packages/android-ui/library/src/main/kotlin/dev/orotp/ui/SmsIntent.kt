package dev.syrotp.ui

import android.content.Intent
import android.net.Uri
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Build an SMS intent that opens the user's default SMS app
 * pre-filled with the verification message addressed to the
 * receiver msisdn.
 *
 * Encoding rules (subtle but matter across iOS/Android variants):
 *   - The recipient lives in the URI path (`sms:<recipient>`).
 *     [Uri.encode] keeps `+` intact and percent-encodes anything
 *     else that would break URI parsing.
 *   - The body is percent-encoded — same output as JavaScript's
 *     `encodeURIComponent` so the cross-stack contract with the
 *     React + Web Component versions stays byte-identical. Java's
 *     [URLEncoder] form-encodes spaces as `+`; we patch that back
 *     to `%20` because `+` confuses some Android SMS apps.
 *   - Some older Android SMS apps prefer `?body=`, others `&body=`;
 *     `?` is the widely-supported form and matches the React
 *     component / Web Component.
 */
object SmsIntent {
    fun buildSmsUri(recipient: String, body: String): Uri =
        Uri.parse("sms:${Uri.encode(recipient)}?body=${encodeSmsBody(body)}")

    fun buildSendIntent(recipient: String, body: String): Intent =
        Intent(Intent.ACTION_VIEW, buildSmsUri(recipient, body))

    /**
     * Pure JVM percent-encoding helper. Exposed as `internal` so
     * unit tests on the JVM can verify the encoding contract
     * without pulling in Robolectric for `android.net.Uri`.
     */
    internal fun encodeSmsBody(body: String): String =
        URLEncoder.encode(body, StandardCharsets.UTF_8.name())
            .replace("+", "%20")
}
