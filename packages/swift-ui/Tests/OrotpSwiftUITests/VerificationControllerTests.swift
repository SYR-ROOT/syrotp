import XCTest
@testable import SyrotpSwiftUI

@MainActor
final class VerificationControllerTests: XCTestCase {

    var session: URLSession!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        session = URLSession(configuration: config)
        MockURLProtocol.reset()
    }

    override func tearDown() {
        MockURLProtocol.reset()
        super.tearDown()
    }

    private func mkVerification(
        id: String = "vrf_abc123",
        status: VerificationStatus = .pending,
        expiresAt: Date? = nil
    ) -> Verification {
        Verification(
            id: id,
            status: status,
            sendTo: "+963998887777",
            message: "VERIFY 123456",
            phoneMasked: "+963 99* *** *567",
            expiresAt: expiresAt ?? Date().addingTimeInterval(600),
            verifiedAt: nil
        )
    }

    private func makeResponse(_ json: String, statusCode: Int = 200) -> (HTTPURLResponse, Data) {
        let url = URL(string: "https://otp.example.com/")!
        let response = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }

    /// Block until `condition` evaluates to true or `timeout` elapses.
    /// Yields back to the runtime every 10ms so the controller's
    /// async work has a chance to progress.
    private func waitFor(
        timeout: TimeInterval = 3.0,
        _ condition: @escaping () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("timed out waiting for condition")
                return
            }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    func testPollsStatusEndpointAgainstBaseUrlWithTrailingSlashTrimmed() async throws {
        let isoNow = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
        MockURLProtocol.handler = { _ in
            self.makeResponse(#"{"status":"pending","expires_at":"\#(isoNow)","verified_at":null}"#)
        }
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(),
            pollInterval: 0.05,
            urlSession: session
        )
        c.start()
        try await waitFor { !MockURLProtocol.captured.isEmpty }
        XCTAssertEqual(
            MockURLProtocol.captured.first?.url?.absoluteString,
            "https://otp.example.com/v/vrf_abc123/status"
        )
        c.stop()
    }

    func testFiresOnVerifiedAndClearsSendToAndMessage() async throws {
        let verifiedAt = ISO8601DateFormatter().string(from: Date())
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
        MockURLProtocol.handler = { _ in
            self.makeResponse(#"{"status":"verified","expires_at":"\#(expiresAt)","verified_at":"\#(verifiedAt)"}"#)
        }
        var received: Verification?
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(),
            pollInterval: 0.05,
            urlSession: session,
            onVerified: { received = $0 }
        )
        c.start()
        try await waitFor { received != nil }
        XCTAssertEqual(received?.status, .verified)
        XCTAssertNil(received?.sendTo)
        XCTAssertNil(received?.message)
        XCTAssertNotNil(received?.verifiedAt)
        c.stop()
    }

    func testFiresOnCancelledOnPendingToCancelledTransition() async throws {
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(600))
        MockURLProtocol.handler = { _ in
            self.makeResponse(#"{"status":"cancelled","expires_at":"\#(expiresAt)","verified_at":null}"#)
        }
        var received: Verification?
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(),
            pollInterval: 0.05,
            urlSession: session,
            onCancelled: { received = $0 }
        )
        c.start()
        try await waitFor { received != nil }
        XCTAssertEqual(received?.status, .cancelled)
        c.stop()
    }

    func testFiresOnExpiredWhenServerReportsExpired() async throws {
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-1))
        MockURLProtocol.handler = { _ in
            self.makeResponse(#"{"status":"expired","expires_at":"\#(expiresAt)","verified_at":null}"#)
        }
        var received: Verification?
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(),
            pollInterval: 0.05,
            urlSession: session,
            onExpired: { received = $0 }
        )
        c.start()
        try await waitFor { received != nil }
        XCTAssertEqual(received?.status, .expired)
        c.stop()
    }

    func testCallsOnErrorOnHttpFailureButKeepsStatePending() async throws {
        MockURLProtocol.handler = { _ in
            self.makeResponse("{}", statusCode: 500)
        }
        var receivedError: Error?
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(),
            pollInterval: 0.05,
            urlSession: session,
            onError: { receivedError = $0 }
        )
        c.start()
        try await waitFor { receivedError != nil }
        XCTAssertEqual(c.state.verification.status, .pending)
        c.stop()
    }

    func testDoesNotPollWhenInitialStateIsAlreadyTerminal() async throws {
        MockURLProtocol.handler = { _ in
            self.makeResponse(#"{"status":"pending","expires_at":"\#(ISO8601DateFormatter().string(from: Date()))","verified_at":null}"#)
        }
        // Use a unique id so we can filter MockURLProtocol's static
        // captured array down to requests this test produced — a
        // previous test's cancelled-but-still-in-flight URL request
        // can record into the static array after our setUp resets
        // it, otherwise. See controller.stop() — it cancels but
        // doesn't await pending URLSession.data calls.
        let uniqueId = "vrf_already_terminal_\(UUID().uuidString)"
        let initial = Verification(
            id: uniqueId,
            status: .verified,
            sendTo: nil,
            message: nil,
            phoneMasked: "+963 99* *** *567",
            expiresAt: Date(),
            verifiedAt: Date()
        )
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: initial,
            pollInterval: 0.03,
            urlSession: session
        )
        c.start()
        try await Task.sleep(nanoseconds: 120_000_000)
        let ours = MockURLProtocol.captured.filter {
            $0.url?.absoluteString.contains(uniqueId) ?? false
        }
        XCTAssertEqual(ours.count, 0, "controller polled despite already-terminal initial state")
        c.stop()
    }

    func testLocalTtlFallbackFiresOnExpiredWhenExpiresAtPasses() async throws {
        // Hold the connection so the poll never lands a verdict during
        // the test window — the countdown task drives the transition.
        MockURLProtocol.handler = { _ in
            // Returning an empty pending response keeps the polling
            // loop healthy without ever flipping state.
            let now = ISO8601DateFormatter().string(from: Date())
            return self.makeResponse(#"{"status":"pending","expires_at":"\#(now)","verified_at":null}"#)
        }
        var fakeNow = Date(timeIntervalSince1970: 0)
        var received: Verification?
        let c = VerificationController(
            baseUrl: URL(string: "https://otp.example.com")!,
            initial: mkVerification(expiresAt: Date(timeIntervalSince1970: 2)),
            pollInterval: 30.0,
            urlSession: session,
            onExpired: { received = $0 },
            now: { fakeNow }
        )
        c.start()
        // Step the clock past expires_at; the next 1Hz countdown tick
        // (real time) will see <= 0 and transition to expired.
        fakeNow = Date(timeIntervalSince1970: 3)
        try await waitFor(timeout: 3.0) { received != nil }
        XCTAssertEqual(c.state.verification.status, .expired)
        XCTAssertNil(received?.sendTo)
        XCTAssertNil(received?.message)
        c.stop()
    }
}
