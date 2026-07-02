package dev.syrotp.ui

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The shape returned by `startVerification()` in any SYROTP server
 * SDK and required as input for [SyrotpVerificationScreen].
 *
 * The developer's backend calls the secret-keyed SDK to create the
 * verification, then forwards this object to the mobile client (do
 * NOT hold a secret key in the app — the secret stays server-side).
 *
 * `sendTo` and `message` are server-emitted only while the row is
 * pending; they go null on terminal states. The screen mirrors that
 * contract so a stale verify code never lingers in the UI after a
 * verified / expired / cancelled transition.
 *
 * Field names use the wire format (`send_to`, `phone_masked`, ...)
 * via `@SerialName`, so JSON from the SYROTP API decodes directly:
 *
 * ```kotlin
 * val v: Verification = Json.decodeFromString(jsonString)
 * ```
 */
@Serializable
data class Verification(
    val id: String,
    val status: VerificationStatus,
    @SerialName("send_to") val sendTo: String?,
    val message: String?,
    @SerialName("phone_masked") val phoneMasked: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("verified_at") val verifiedAt: String? = null,
)
