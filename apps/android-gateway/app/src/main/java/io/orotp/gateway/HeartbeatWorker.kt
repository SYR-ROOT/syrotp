package io.syrotp.gateway

import android.content.Context
import android.os.BatteryManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class HeartbeatWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {

    override suspend fun doWork(): Result {
        SignerMigration.run(applicationContext)

        val cfg = GatewayConfig.get(applicationContext)
        if (!cfg.isPaired(applicationContext)) return Result.failure()
        val signer = KeystoreSigner.get(applicationContext)
        if (!signer.hasKey()) return Result.retry()

        val client = SyrotpClient(
            baseUrl = cfg.serverUrl!!,
            receiverId = cfg.receiverId!!,
            signer = signer,
        )
        val queue = InboundQueue(applicationContext)

        val battery = applicationContext.getSystemService(BatteryManager::class.java)
            ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

        val res = runCatching {
            client.heartbeat(queue.depth(), battery, null)
        }.getOrNull()

        return when {
            res == null -> Result.retry()
            res.status in 200..299 -> Result.success()
            res.status == 401 -> Result.failure()
            else -> Result.retry()
        }
    }
}
