package io.syrotp.gateway

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Pull any pre-v0.8 plaintext signing key into the keystore
        // before we read pairing state.
        SignerMigration.run(this)

        val cfg = GatewayConfig.get(this)
        val signer = KeystoreSigner.get(this)
        val urlInput = findViewById<EditText>(R.id.urlInput)
        val receiverInput = findViewById<EditText>(R.id.receiverInput)
        val keyInput = findViewById<EditText>(R.id.keyInput)
        val saveBtn = findViewById<Button>(R.id.saveBtn)
        val unpairBtn = findViewById<Button>(R.id.unpairBtn)
        val statusView = findViewById<TextView>(R.id.statusView)
        val depthView = findViewById<TextView>(R.id.depthView)

        urlInput.setText(cfg.serverUrl ?: "")
        receiverInput.setText(cfg.receiverId ?: "")
        // We never display the signing key once stored — leave the field blank.

        fun refresh() {
            val paired = cfg.isPaired(this)
            statusView.text = if (paired) getString(R.string.status_paired) else getString(R.string.status_unpaired)
            depthView.text = getString(R.string.queue_depth_fmt, InboundQueue(this).depth())
            unpairBtn.visibility = if (paired) View.VISIBLE else View.GONE
        }

        saveBtn.setOnClickListener {
            val url = urlInput.text.toString().trim()
            val rcv = receiverInput.text.toString().trim()
            val key = keyInput.text.toString().trim()
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                Toast.makeText(this, R.string.bad_url, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            if (!rcv.startsWith("rcv_")) {
                Toast.makeText(this, R.string.bad_receiver, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            if (key.length < 32) {
                Toast.makeText(this, R.string.bad_key, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            cfg.serverUrl = url
            cfg.receiverId = rcv
            try {
                signer.importKey(key)
            } catch (e: Exception) {
                Toast.makeText(this, R.string.bad_key, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            // Clear the input field and the EditText buffer so the raw key
            // doesn't linger in the view hierarchy.
            keyInput.setText("")
            // Defensive: pre-v0.8 installs that re-pair through this UI
            // would otherwise keep their legacy plaintext copy around.
            cfg.clearLegacySigningKey()
            BootReceiver.scheduleHeartbeat(this)
            ensureSmsPermissions()
            refresh()
            Toast.makeText(this, R.string.paired_ok, Toast.LENGTH_SHORT).show()
        }

        unpairBtn.setOnClickListener {
            signer.delete()
            cfg.clear()
            refresh()
        }

        ensureSmsPermissions()
        refresh()
    }

    private fun ensureSmsPermissions() {
        val perms = mutableListOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
        if (Build.VERSION.SDK_INT >= 33) perms.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 1)
        }
    }
}
