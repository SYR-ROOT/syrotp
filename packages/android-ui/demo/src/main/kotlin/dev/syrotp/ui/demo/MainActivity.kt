package dev.syrotp.ui.demo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.syrotp.ui.SyrotpVerificationScreen
import dev.syrotp.ui.Verification
import dev.syrotp.ui.VerificationStatus
import java.time.Instant

/**
 * Minimal Android app demonstrating `SyrotpVerificationScreen`. Uses
 * a hardcoded [Verification] so you can see the UI without running
 * an SYROTP server. Status polling is a no-op against the demo
 * `baseUrl` unless you also have the server reachable from the
 * device — that's expected for a UI-only demo.
 *
 * In a real app, your backend calls `startVerification()` (with the
 * secret SDK), forwards the result to your Android client, and you
 * pass it to `SyrotpVerificationScreen`.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                DemoScreen()
            }
        }
    }
}

private val DEMO_VERIFICATION = Verification(
    id = "vrf_demo000000000",
    status = VerificationStatus.Pending,
    sendTo = "+963998887777",
    message = "VERIFY 123456",
    phoneMasked = "+963 99* *** *567",
    expiresAt = Instant.now().plusSeconds(5 * 60).toString(),
    verifiedAt = null,
)

@Composable
private fun DemoScreen() {
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("SYROTP — Android demo", style = MaterialTheme.typography.headlineSmall)
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                "In production your backend calls startVerification() via the secret SDK and forwards the result to your app. This demo uses a hardcoded verification so you can see the UI.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(modifier = Modifier.height(16.dp))
            SyrotpVerificationScreen(
                verification = DEMO_VERIFICATION,
                baseUrl = "http://10.0.2.2:3000",
                onVerified = {},
                onExpired = {},
                onCancelled = {},
                onError = {},
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun DemoScreenPreview() {
    MaterialTheme { DemoScreen() }
}
