package io.syrotp.sdk

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * The five known verification statuses, plus an [UNKNOWN] forward-compat
 * value. The string form matches the wire (`pending`, `verified`, …).
 */
public enum class VerificationStatus(public val wire: String) {
    PENDING("pending"),
    VERIFIED("verified"),
    EXPIRED("expired"),
    CANCELLED("cancelled"),
    FAILED("failed"),

    /**
     * Returned for any wire value this SDK doesn't know about. Lets a
     * server bump introduce a new status without breaking older SDKs —
     * see `docs/sdk-versioning.md` §4.
     */
    UNKNOWN("unknown"),
    ;

    public companion object {
        public fun fromWire(value: String?): VerificationStatus =
            values().firstOrNull { it.wire == value } ?: UNKNOWN
    }
}

/**
 * A verification record from the server.
 *
 * Field names track [openapi.yaml's Verification schema](../openapi.yaml).
 *
 * [extras] captures any field the server returned that this SDK
 * version doesn't know about — important so application code can
 * read newer optional fields without an SDK upgrade
 * (see `docs/sdk-versioning.md` §4).
 */
public data class Verification(
    public val id: String,
    public val status: VerificationStatus,
    public val phoneMasked: String,
    public val expiresAt: String,
    public val createdAt: String,
    public val sendTo: String? = null,
    public val message: String? = null,
    public val clientRef: String? = null,
    public val purpose: String? = null,
    public val verifiedAt: String? = null,
    public val attempts: Int? = null,
    public val extras: Map<String, JsonElement> = emptyMap(),
) {
    public companion object {
        private val KNOWN: Set<String> = setOf(
            "id", "status", "phone_masked", "expires_at", "created_at",
            "send_to", "message", "client_ref", "purpose", "verified_at", "attempts",
        )

        public fun fromJson(obj: JsonObject): Verification {
            fun str(key: String): String? = (obj[key] as? JsonPrimitive)?.contentOrNull
            fun int(key: String): Int? = (obj[key] as? JsonPrimitive)?.intOrNull

            val id = requireString(obj, "id")
            val status = VerificationStatus.fromWire(str("status"))
            val phoneMasked = requireString(obj, "phone_masked")
            val expiresAt = requireString(obj, "expires_at")
            val createdAt = requireString(obj, "created_at")

            val extras = obj.filterKeys { it !in KNOWN }

            return Verification(
                id = id,
                status = status,
                phoneMasked = phoneMasked,
                expiresAt = expiresAt,
                createdAt = createdAt,
                sendTo = str("send_to"),
                message = str("message"),
                clientRef = str("client_ref"),
                purpose = str("purpose"),
                verifiedAt = str("verified_at"),
                attempts = int("attempts"),
                extras = extras,
            )
        }

        private fun requireString(obj: JsonObject, key: String): String {
            val v = obj[key]
            return if (v is JsonPrimitive) v.contentOrNull
                ?: throw SyrotpError("bad_response", "missing '$key' in response", httpStatus = 0)
            else throw SyrotpError("bad_response", "missing '$key' in response", httpStatus = 0)
        }
    }
}
