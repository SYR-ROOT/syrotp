package io.syrotp.gateway

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Append-only on-disk queue of inbound SMS events.
 *
 * The receiver writes here synchronously when an SMS arrives — we cannot
 * rely on the network in that moment. A WorkManager job drains the queue
 * with retries.
 *
 * Stored as a single JSON file, simple and crash-safe enough at expected
 * volume (a phone receives thousands, not millions, of SMS per day).
 */
class InboundQueue(private val ctx: Context) {

    data class Item(
        val id: String,
        val from: String,
        val to: String,
        val body: String,
        val receivedAtMillis: Long,
        val idempotencyKey: String,
        val simSlot: Int?,
        var attempts: Int,
    )

    @Synchronized
    fun enqueue(
        from: String,
        to: String,
        body: String,
        receivedAtMillis: Long,
        simSlot: Int?,
    ) {
        val id = UUID.randomUUID().toString()
        // Deterministic idempotency key keeps reposts safe even if we crash
        // between "sent to server" and "removed from disk."
        val idem = Crypto.sha256Hex(
            "$from|$to|$receivedAtMillis|$body".toByteArray(Charsets.UTF_8),
        )
        val arr = readArray()
        arr.put(
            JSONObject()
                .put("id", id)
                .put("from", from)
                .put("to", to)
                .put("body", body)
                .put("received_at_ms", receivedAtMillis)
                .put("idem", idem)
                .put("sim_slot", simSlot ?: JSONObject.NULL)
                .put("attempts", 0),
        )
        writeArray(arr)
    }

    @Synchronized
    fun snapshot(): List<Item> {
        val arr = readArray()
        val out = ArrayList<Item>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(
                Item(
                    id = o.getString("id"),
                    from = o.getString("from"),
                    to = o.getString("to"),
                    body = o.getString("body"),
                    receivedAtMillis = o.getLong("received_at_ms"),
                    idempotencyKey = o.getString("idem"),
                    simSlot = if (o.isNull("sim_slot")) null else o.getInt("sim_slot"),
                    attempts = o.optInt("attempts", 0),
                ),
            )
        }
        return out
    }

    @Synchronized
    fun remove(id: String) {
        val arr = readArray()
        val keep = JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("id") != id) keep.put(o)
        }
        writeArray(keep)
    }

    @Synchronized
    fun bumpAttempts(id: String) {
        val arr = readArray()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            if (o.getString("id") == id) {
                o.put("attempts", o.optInt("attempts", 0) + 1)
            }
        }
        writeArray(arr)
    }

    fun depth(): Int = readArray().length()

    private fun readArray(): JSONArray {
        val f = ctx.getFileStreamPath(FILE)
        if (!f.exists()) return JSONArray()
        return try {
            JSONArray(ctx.openFileInput(FILE).bufferedReader().use { it.readText() })
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun writeArray(arr: JSONArray) {
        ctx.openFileOutput(FILE, Context.MODE_PRIVATE).bufferedWriter().use {
            it.write(arr.toString())
        }
    }

    companion object {
        private const val FILE = "syrotp_inbound_queue.json"
    }
}
