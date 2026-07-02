package dev.syrotp.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat

private const val DEFAULT_INSTRUCTION = "Send this SMS to verify your phone."

/**
 * Compose screen rendering the SYROTP verification flow.
 *
 * Same wire contract and lifecycle as `@syrotp/react` and
 * `@syrotp/web-component`: the developer's backend creates the
 * verification (secret-keyed), forwards the result to the mobile
 * app, and hands it to this composable. The composable polls the
 * public `/v/:id/status` endpoint and fires the appropriate
 * callback on each transition out of `pending`.
 *
 * The screen never displays anything besides the verification's
 * own message, send-to msisdn, masked phone, and status text. No
 * secrets, no API keys, no logs — the SMS body itself is the only
 * thing the user can see or copy.
 */
@Composable
fun SyrotpVerificationScreen(
    verification: Verification,
    baseUrl: String,
    modifier: Modifier = Modifier,
    pollIntervalMs: Long = VerificationController.DEFAULT_POLL_INTERVAL_MS,
    initialInstruction: String = DEFAULT_INSTRUCTION,
    onVerified: (Verification) -> Unit = {},
    onExpired: (Verification) -> Unit = {},
    onCancelled: (Verification) -> Unit = {},
    onError: (Throwable) -> Unit = {},
) {
    val parentScope = rememberCoroutineScope()
    val controller = remember(verification.id) {
        VerificationController(
            baseUrl = baseUrl,
            initial = verification,
            pollIntervalMs = pollIntervalMs,
            onVerified = onVerified,
            onExpired = onExpired,
            onCancelled = onCancelled,
            onError = onError,
        )
    }
    val state by controller.state.collectAsState()
    val context = LocalContext.current

    DisposableEffect(controller) {
        controller.start(parentScope)
        onDispose { controller.stop() }
    }

    Surface(modifier = modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val v = state.verification
            when {
                v.status == VerificationStatus.Pending && v.sendTo != null && v.message != null -> {
                    PendingContent(
                        instruction = initialInstruction,
                        verification = v,
                        secondsLeft = state.secondsLeft,
                        onCopy = { copyToClipboard(context, "SYROTP verification", v.message) },
                        onOpenSmsApp = { openSmsApp(context, v.sendTo, v.message) },
                    )
                }
                v.status == VerificationStatus.Verified -> {
                    StatusText("Phone verified.", MaterialTheme.colorScheme.primary)
                }
                v.status == VerificationStatus.Expired -> {
                    StatusText(
                        "Verification expired. Start a new one to continue.",
                        MaterialTheme.colorScheme.error,
                    )
                }
                v.status == VerificationStatus.Cancelled -> {
                    StatusText(
                        "Verification cancelled.",
                        MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                v.status == VerificationStatus.Failed -> {
                    StatusText("Verification failed.", MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

@Composable
private fun PendingContent(
    instruction: String,
    verification: Verification,
    secondsLeft: Long,
    onCopy: () -> Unit,
    onOpenSmsApp: () -> Unit,
) {
    val sendTo = verification.sendTo ?: return
    val message = verification.message ?: return

    Text(instruction, style = MaterialTheme.typography.bodyMedium)
    Text(
        "From: ${verification.phoneMasked}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text("To: $sendTo", style = MaterialTheme.typography.bodyMedium)
    Text(
        message,
        fontFamily = FontFamily.Monospace,
        fontSize = 18.sp,
        fontWeight = FontWeight.Medium,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = onCopy) { Text("Copy") }
        OutlinedButton(onClick = onOpenSmsApp) { Text("Open SMS app") }
    }
    Text(
        "Expires in ${formatCountdown(secondsLeft)}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun StatusText(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(text, color = color, style = MaterialTheme.typography.bodyLarge)
}

private fun formatCountdown(secs: Long): String {
    val m = secs / 60
    val s = secs % 60
    return "%d:%02d".format(m, s)
}

private fun copyToClipboard(context: Context, label: String, text: String) {
    val mgr = ContextCompat.getSystemService(context, ClipboardManager::class.java) ?: return
    mgr.setPrimaryClip(ClipData.newPlainText(label, text))
    Toast.makeText(context, "Copied", Toast.LENGTH_SHORT).show()
}

private fun openSmsApp(context: Context, recipient: String, body: String) {
    val intent = SmsIntent.buildSendIntent(recipient, body)
    try {
        context.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        Toast.makeText(context, "No SMS app available", Toast.LENGTH_SHORT).show()
    }
}
