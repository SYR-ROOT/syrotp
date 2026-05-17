import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// SwiftUI view rendering the SYROTP verification flow.
///
/// Same wire contract and lifecycle as `@syrotp/react`,
/// `@syrotp/web-component`, `syrotp-android-ui`, and `syrotp_flutter`:
/// the developer's backend creates the verification (secret-keyed),
/// forwards the result to the mobile client, and the view polls the
/// public `/v/:id/status` endpoint and fires the appropriate
/// callback on each transition out of `pending`.
///
/// Pass an optional ``webauthnFallbackUrl`` to surface a
/// "Use a passkey instead" link below the SMS section. The view
/// itself does not implement WebAuthn — it just hands the user off
/// to the operator-supplied fallback URL.
public struct VerificationView: View {
    @StateObject private var controller: VerificationController
    @Environment(\.openURL) private var openURL

    private let initialInstruction: String
    private let webauthnFallbackUrl: URL?

    public init(
        verification: Verification,
        baseUrl: URL,
        pollInterval: TimeInterval = 2.5,
        initialInstruction: String = "Send this SMS to verify your phone.",
        webauthnFallbackUrl: URL? = nil,
        onVerified: @escaping (Verification) -> Void = { _ in },
        onExpired: @escaping (Verification) -> Void = { _ in },
        onCancelled: @escaping (Verification) -> Void = { _ in },
        onError: @escaping (Error) -> Void = { _ in }
    ) {
        self.initialInstruction = initialInstruction
        self.webauthnFallbackUrl = webauthnFallbackUrl
        _controller = StateObject(wrappedValue: VerificationController(
            baseUrl: baseUrl,
            initial: verification,
            pollInterval: pollInterval,
            onVerified: onVerified,
            onExpired: onExpired,
            onCancelled: onCancelled,
            onError: onError
        ))
    }

    /// Designated initializer for advanced consumers who want to
    /// share a controller across views (e.g., to drive multiple
    /// pieces of UI from the same lifecycle). Most consumers use
    /// the convenience initializer above.
    public init(
        controller: VerificationController,
        initialInstruction: String = "Send this SMS to verify your phone.",
        webauthnFallbackUrl: URL? = nil
    ) {
        self.initialInstruction = initialInstruction
        self.webauthnFallbackUrl = webauthnFallbackUrl
        _controller = StateObject(wrappedValue: controller)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            content
        }
        .padding(16)
        .onAppear { controller.start() }
        .onDisappear { controller.stop() }
    }

    @ViewBuilder
    private var content: some View {
        let v = controller.state.verification
        if v.status == .pending, let sendTo = v.sendTo, let message = v.message {
            pendingContent(verification: v, sendTo: sendTo, message: message)
        } else {
            terminalContent(status: v.status)
        }
    }

    @ViewBuilder
    private func pendingContent(
        verification: Verification,
        sendTo: String,
        message: String
    ) -> some View {
        Text(initialInstruction)
        Text("From: \(verification.phoneMasked)")
            .font(.subheadline)
            .foregroundColor(.secondary)
        Text("To: \(sendTo)")
            .font(.body)
        Text(message)
            .font(.system(size: 18, weight: .medium, design: .monospaced))
            .padding(8)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.gray.opacity(0.15))
            )
            .textSelection(.enabled)
        HStack(spacing: 8) {
            Button("Copy") { copyToClipboard(message) }
            Button("Open SMS app") { openSmsApp(recipient: sendTo, body: message) }
        }
        Text("Expires in \(formatCountdown(controller.state.secondsLeft))")
            .font(.caption)
            .foregroundColor(.secondary)
        if let url = webauthnFallbackUrl {
            Button("Can't receive SMS? Use a passkey instead.") {
                openURL(url)
            }
            .font(.caption)
        }
    }

    @ViewBuilder
    private func terminalContent(status: VerificationStatus) -> some View {
        switch status {
        case .verified:
            Text("Phone verified.")
                .foregroundColor(.green)
        case .expired:
            Text("Verification expired. Start a new one to continue.")
                .foregroundColor(.orange)
        case .cancelled:
            Text("Verification cancelled.")
                .foregroundColor(.secondary)
        case .failed:
            Text("Verification failed.")
                .foregroundColor(.red)
        case .pending:
            EmptyView()
        }
    }

    private func openSmsApp(recipient: String, body: String) {
        let url = SmsIntent.buildSmsUrl(recipient: recipient, body: body)
        openURL(url)
    }

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        #endif
    }

    private func formatCountdown(_ secs: Int) -> String {
        let m = secs / 60
        let s = secs % 60
        return String(format: "%d:%02d", m, s)
    }
}

#if DEBUG
#Preview("Pending") {
    VerificationView(
        verification: Verification(
            id: "vrf_demo000000000",
            status: .pending,
            sendTo: "+963998887777",
            message: "VERIFY 123456",
            phoneMasked: "+963 99* *** *567",
            expiresAt: Date().addingTimeInterval(5 * 60),
            verifiedAt: nil
        ),
        // swiftlint:disable:next force_unwrapping
        baseUrl: URL(string: "http://localhost:3000")!,
        webauthnFallbackUrl: URL(string: "https://example.com/passkey")
    )
}

#Preview("Verified") {
    VerificationView(
        verification: Verification(
            id: "vrf_demo000000000",
            status: .verified,
            sendTo: nil,
            message: nil,
            phoneMasked: "+963 99* *** *567",
            expiresAt: Date().addingTimeInterval(60),
            verifiedAt: Date()
        ),
        // swiftlint:disable:next force_unwrapping
        baseUrl: URL(string: "http://localhost:3000")!
    )
}
#endif
