package io.syrotp.gateway

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Drains the on-disk queue. Per item:
 *   - POST to /v1/inbound/sms with HMAC signature
 *   - on 2xx OR 409 (duplicate) — remove from queue
 *   - on 4xx (other) — bump attempts, drop after MAX_ATTEMPTS
 *   - on 5xx / network — bump attempts, return Result.retry()
 *
 * WorkManager handles backoff and survives reboots.
 */
class UploadWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        SignerMigration.run(applicationContext)

        val cfg = GatewayConfig.get(applicationContext)
        if (!cfg.isPaired(applicationContext)) return Result.failure()
        val signer = KeystoreSigner.get(applicationContext)
        if (!signer.hasKey()) {
            // Legacy key still in prefs but the migration didn't take.
            // Bail and retry on the next WorkManager backoff window.
            return Result.retry()
        }

        val client = SyrotpClient(
            baseUrl = cfg.serverUrl!!,
            receiverId = cfg.receiverId!!,
            signer = signer,
        )
        val queue = InboundQueue(applicationContext)
        val items = queue.snapshot()
        if (items.isEmpty()) return Result.success()

        var transient = false
        for (item in items) {
            val res = runCatching {
                client.postInbound(
                    from = item.from,
                    to = item.to,
                    body = item.body,
                    receivedAtMillis = item.receivedAtMillis,
                    idempotencyKey = item.idempotencyKey,
                    simSlot = item.simSlot,
                )
            }.getOrNull()

            when {
                res == null -> {
                    transient = true
                    queue.bumpAttempts(item.id)
                }
                res.status in 200..299 || res.status == 409 -> {
                    // Success or already-seen — both are terminal for this item.
                    queue.remove(item.id)
                }
                res.status == 401 -> {
                    // Auth broken — DO NOT keep retrying or we'll DoS the server.
                    // Surface to the user via a notification (TODO) and stop.
                    return Result.failure()
                }
                res.status in 400..499 -> {
                    // Permanent client error for this item; drop after a few tries.
                    queue.bumpAttempts(item.id)
                    if (item.attempts + 1 >= MAX_ATTEMPTS) queue.remove(item.id)
                }
                else -> {
                    transient = true
                    queue.bumpAttempts(item.id)
                }
            }
        }

        return if (transient) Result.retry() else Result.success()
    }

    companion object {
        private const val MAX_ATTEMPTS = 8
    }
}
