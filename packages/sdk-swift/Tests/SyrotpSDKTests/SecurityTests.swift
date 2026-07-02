import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import SyrotpSDK

/// Canary tests for `docs/sdk-generation.md` §5.
///
/// If the api_key or the user's phone ever leak into a log line or an
/// error rendering, these will fail.
final class SecurityTests: XCTestCase {

    private let canaryAPIKey = "sk_live_TESTSENTINEL_DO_NOT_LOG_THIS"
    private let canaryPhone = "+99999999999999"

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
    }

    func testAPIKeyNeverAppearsInErrorDescription() {
        let rendered = SyrotpAuthError(code: "unauthorized", message: "missing creds", httpStatus: 401).description
        XCTAssertFalse(rendered.contains(canaryAPIKey))
    }

    func testPhoneNeverAppearsInSyrotpLogger() async throws {
        let captured = LogBuffer()
        let captureHandler: @Sendable (String) -> Void = { line in captured.append(line) }

        MockURLProtocol.handler = { req in
            return (TestFixtures.okResponse(for: req.url!, status: 201),
                    TestFixtures.verificationJSON(sendTo: "+1", message: "VERIFY ABC"))
        }

        let client = try SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: canaryAPIKey,
            timeoutSeconds: 5,
            retries: 0,
            userAgent: nil,
            session: URLSession.mocked(),
            sleeper: { _ in },
            logHandler: captureHandler
        )
        _ = try await client.startVerification(phone: canaryPhone, purpose: "login")

        let output = captured.joined()
        XCTAssertFalse(output.contains(canaryPhone),
                       "phone leaked into logs: \(output)")
        XCTAssertFalse(output.contains(canaryAPIKey),
                       "api_key leaked into logs: \(output)")
    }

    func testCleartextToPublicHostLogsWarning() throws {
        let captured = LogBuffer()
        let captureHandler: @Sendable (String) -> Void = { line in captured.append(line) }

        _ = try SyrotpClient(
            baseURL: URL(string: "http://otp.example.com")!,
            apiKey: "sk_live_x",
            session: URLSession.mocked(),
            logHandler: captureHandler
        )
        XCTAssertTrue(captured.joined().contains("plain HTTP"),
                      "expected cleartext warning, got: \(captured.joined())")
    }

    func testCleartextToLoopbackOrPrivateDoesNotWarn() throws {
        let hosts = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://10.0.0.1",
            "http://192.168.1.1",
            "http://172.16.0.1",
        ]
        for host in hosts {
            let captured = LogBuffer()
            let captureHandler: @Sendable (String) -> Void = { line in captured.append(line) }

            _ = try SyrotpClient(
                baseURL: URL(string: host)!,
                apiKey: "sk_live_x",
                session: URLSession.mocked(),
                logHandler: captureHandler
            )
            XCTAssertFalse(captured.joined().contains("plain HTTP"),
                           "should not warn for private host \(host); got: \(captured.joined())")
        }
    }
}

/// Thread-safe log line buffer. Tests run serially per case, so the
/// lock is mostly defensive against a future async-logging change.
final class LogBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var lines: [String] = []

    func append(_ line: String) {
        lock.lock(); defer { lock.unlock() }
        lines.append(line)
    }

    func joined() -> String {
        lock.lock(); defer { lock.unlock() }
        return lines.joined(separator: "\n")
    }
}
