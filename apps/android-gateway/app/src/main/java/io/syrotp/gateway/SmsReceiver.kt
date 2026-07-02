package io.syrotp.gateway

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SubscriptionManager
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

/**
 * Captures incoming SMS broadcasts, persists them to the local queue, and
 * kicks off the upload worker. We do the absolute minimum here — the
 * onReceive call is on the main thread and on a tight time budget.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val cfg = GatewayConfig.get(context)
        if (!cfg.isPaired(context)) return // unpaired gateways drop SMS silently

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // Multi-part SMS arrives split. Concatenate by originating address.
        val byFrom = LinkedHashMap<String, StringBuilder>()
        var receivedAt = 0L
        for (m in messages) {
            val from = m.originatingAddress ?: continue
            val body = m.messageBody ?: continue
            byFrom.getOrPut(from) { StringBuilder() }.append(body)
            if (receivedAt == 0L) receivedAt = m.timestampMillis
        }
        if (byFrom.isEmpty()) return
        if (receivedAt == 0L) receivedAt = System.currentTimeMillis()

        val simSlot = runCatching {
            val subId = intent.getIntExtra("subscription", -1)
            if (subId == -1) null
            else {
                val sm = context.getSystemService(SubscriptionManager::class.java)
                sm?.getActiveSubscriptionInfo(subId)?.simSlotIndex
            }
        }.getOrNull()

        val to = "self" // we don't have the receiving SIM's MSISDN reliably; server uses receiverId
        val queue = InboundQueue(context)
        for ((from, body) in byFrom) {
            queue.enqueue(from, to, body.toString(), receivedAt, simSlot)
        }

        val req = OneTimeWorkRequestBuilder<UploadWorker>().build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            "syrotp-upload",
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            req,
        )
    }
}
