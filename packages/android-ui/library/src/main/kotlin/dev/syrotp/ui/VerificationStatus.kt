package dev.syrotp.ui

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * The five lifecycle states a verification can be in. The wire
 * format spells them in lowercase; `@SerialName` keeps the Kotlin
 * idiom (PascalCase enum constants) without changing the JSON
 * shape your backend hands you.
 */
@Serializable
enum class VerificationStatus {
    @SerialName("pending") Pending,
    @SerialName("verified") Verified,
    @SerialName("expired") Expired,
    @SerialName("cancelled") Cancelled,
    @SerialName("failed") Failed;

    val isTerminal: Boolean get() = this != Pending
}
