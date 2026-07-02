package io.syrotp.sdk.examples

import io.syrotp.sdk.SyrotpClient
import io.syrotp.sdk.SyrotpError
import io.syrotp.sdk.VerificationStatus
import kotlin.system.exitProcess

/**
 * Quickstart for the SYROTP Kotlin/JVM SDK.
 *
 * Reads SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) from
 * the environment — same convention as scripts/smoke.mjs and the
 * `syrotp` CLI.
 *
 * Run against a running SYROTP server:
 *
 *     export SYROTP_BASE_URL=http://localhost:3000
 *     export SYROTP_SECRET_KEY=sk_live_...
 *     ./gradlew run --args="+963991234567 login"
 */
fun main(args: Array<String>) {
    if (args.size < 2) {
        System.err.println("usage: Quickstart <phone> <purpose>")
        exitProcess(2)
    }

    val baseUrl = System.getenv("SYROTP_BASE_URL")
        ?: error("SYROTP_BASE_URL must be set")
    val apiKey = System.getenv("SYROTP_SECRET_KEY") ?: System.getenv("SYROTP_PUBLIC_KEY")
        ?: error("SYROTP_SECRET_KEY or SYROTP_PUBLIC_KEY must be set")

    val (phone, purpose) = args[0] to args[1]

    SyrotpClient(baseUrl = baseUrl, apiKey = apiKey).use { client ->
        try {
            val v = client.startVerification(phone = phone, purpose = purpose)
            check(v.status == VerificationStatus.PENDING) {
                "unexpected status from start: ${v.status.wire}"
            }
            println("verification id: ${v.id}")
            println("  send: \"${v.message}\"")
            println("  to:   ${v.sendTo}")
            println("  for phone ${v.phoneMasked}")

            // Demo only: cancel right away. A real app would poll
            // waitForVerification while the user sends the SMS.
            val cancelled = client.cancelVerification(v.id)
            println("final status after cancel: ${cancelled.status.wire}")
        } catch (e: SyrotpError) {
            System.err.println("syrotp error: $e")
            exitProcess(1)
        }
    }
}
