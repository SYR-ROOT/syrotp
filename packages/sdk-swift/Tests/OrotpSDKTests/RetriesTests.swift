import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import SyrotpSDK

/// Pins the retry policy from `docs/sdk-generation.md` §7.
///
///   Retry on:    network / 5xx / 429 (with Retry-After honored)
///   Never on:    400 / 401 / 403 / 4xx-other / timeout / config
final class RetriesTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
    }

    private func client(retries: Int, sleeperCapture: SleeperCapture? = nil) -> SyrotpClient {
        let sleeper: @Sendable (TimeInterval) async -> Void = { seconds in
            sleeperCapture?.append(seconds)
        }
        return try! SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: "sk_live_x",
            timeoutSeconds: 5,
            retries: retries,
            userAgent: nil,
            session: URLSession.mocked(),
            sleeper: sleeper
        )
    }

    func test5xxIsRetriedUntilSuccess() async throws {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            if counter < 3 {
                return (TestFixtures.okResponse(for: req.url!, status: 503),
                        TestFixtures.errorJSON(code: "down", message: "no"))
            }
            return (TestFixtures.okResponse(for: req.url!, status: 200),
                    TestFixtures.verificationJSON(status: "verified"))
        }
        let v = try await client(retries: 3).getVerification("vrf_01HX")
        XCTAssertEqual(v.status, .verified)
        XCTAssertEqual(counter, 3)
    }

    func test5xxEventuallyRaisesAfterBudget() async {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            return (TestFixtures.okResponse(for: req.url!, status: 503),
                    TestFixtures.errorJSON(code: "down", message: "no"))
        }
        do {
            _ = try await client(retries: 2).getVerification("vrf_01HX")
            XCTFail("expected throw")
        } catch is SyrotpServerError {
            // expected
        } catch {
            XCTFail("expected SyrotpServerError, got \(error)")
        }
        // 1 initial + 2 retries
        XCTAssertEqual(counter, 3)
    }

    func test429RespectsRetryAfter() async throws {
        var counter = 0
        let captured = SleeperCapture()
        MockURLProtocol.handler = { req in
            counter += 1
            if counter == 1 {
                let res = HTTPURLResponse(
                    url: req.url!,
                    statusCode: 429,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Retry-After": "7"]
                )!
                return (res, TestFixtures.errorJSON(code: "rate_limited", message: "slow"))
            }
            return (TestFixtures.okResponse(for: req.url!, status: 200),
                    TestFixtures.verificationJSON())
        }
        _ = try await client(retries: 2, sleeperCapture: captured).getVerification("vrf_01HX")
        XCTAssertTrue(captured.values.contains(where: { $0 >= 7.0 }),
                      "expected a sleep >= 7s, got \(captured.values)")
    }

    func testGarbageRetryAfterDoesNotCrash() async throws {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            if counter == 1 {
                let res = HTTPURLResponse(
                    url: req.url!,
                    statusCode: 429,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Retry-After": "not-a-number"]
                )!
                return (res, TestFixtures.errorJSON(code: "rate_limited", message: "slow"))
            }
            return (TestFixtures.okResponse(for: req.url!, status: 200),
                    TestFixtures.verificationJSON())
        }
        _ = try await client(retries: 2).getVerification("vrf_01HX")
        XCTAssertEqual(counter, 2)
    }

    func test400IsNotRetried() async {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            return (TestFixtures.okResponse(for: req.url!, status: 400),
                    TestFixtures.errorJSON(code: "validation_error", message: "bad"))
        }
        do {
            _ = try await client(retries: 5).getVerification("vrf_01HX")
            XCTFail("expected throw")
        } catch is SyrotpValidationError {
            // expected
        } catch {
            XCTFail("expected SyrotpValidationError, got \(error)")
        }
        XCTAssertEqual(counter, 1)
    }

    func test401IsNotRetried() async {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            return (TestFixtures.okResponse(for: req.url!, status: 401),
                    TestFixtures.errorJSON(code: "unauthorized", message: "no"))
        }
        do {
            _ = try await client(retries: 5).getVerification("vrf_01HX")
            XCTFail("expected throw")
        } catch is SyrotpAuthError {
            // expected
        } catch {
            XCTFail("expected SyrotpAuthError, got \(error)")
        }
        XCTAssertEqual(counter, 1)
    }

    func testZeroRetriesMeansSingleAttempt() async {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            return (TestFixtures.okResponse(for: req.url!, status: 503),
                    TestFixtures.errorJSON(code: "down", message: "no"))
        }
        do {
            _ = try await client(retries: 0).getVerification("vrf_01HX")
            XCTFail("expected throw")
        } catch is SyrotpServerError {
            // expected
        } catch {
            XCTFail("expected SyrotpServerError, got \(error)")
        }
        XCTAssertEqual(counter, 1)
    }

    func testCancelVerificationCapsRetriesAtOne() async {
        var counter = 0
        MockURLProtocol.handler = { req in
            counter += 1
            return (TestFixtures.okResponse(for: req.url!, status: 503),
                    TestFixtures.errorJSON(code: "down", message: "no"))
        }
        do {
            _ = try await client(retries: 10).cancelVerification("vrf_01HX")
            XCTFail("expected throw")
        } catch is SyrotpServerError {
            // expected
        } catch {
            XCTFail("expected SyrotpServerError, got \(error)")
        }
        // 1 initial + at most 1 retry = 2.
        XCTAssertLessThanOrEqual(counter, 2)
    }
}

/// Thread-safe-enough capture for the test sleeper. Tests run
/// serially per case, so a simple lock is plenty.
final class SleeperCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [TimeInterval] = []

    var values: [TimeInterval] {
        lock.lock(); defer { lock.unlock() }
        return _values
    }

    func append(_ v: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        _values.append(v)
    }
}
