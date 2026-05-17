import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import SyrotpSDK

final class SyrotpClientTests: XCTestCase {

    override func setUp() {
        super.setUp()
        MockURLProtocol.reset()
    }

    // MARK: - constructor validation

    func testRejectsNonHTTPBaseURL() {
        XCTAssertThrowsError(try SyrotpClient(
            baseURL: URL(string: "ftp://x")!,
            apiKey: "sk_live_x"
        )) { error in
            XCTAssertTrue(error is SyrotpConfigError, "got \(error)")
        }
    }

    func testRejectsEmptyAPIKey() {
        XCTAssertThrowsError(try SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: ""
        )) { error in
            XCTAssertTrue(error is SyrotpConfigError)
        }
    }

    func testRejectsZeroTimeout() {
        XCTAssertThrowsError(try SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: "sk_live_x",
            timeoutSeconds: 0
        )) { error in
            XCTAssertTrue(error is SyrotpConfigError)
        }
    }

    func testRejectsNegativeRetries() {
        XCTAssertThrowsError(try SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: "sk_live_x",
            retries: -1
        )) { error in
            XCTAssertTrue(error is SyrotpConfigError)
        }
    }

    func testStripsTrailingSlashFromBaseURL() throws {
        let c = try SyrotpClient(
            baseURL: URL(string: "http://syrotp.test/")!,
            apiKey: "sk_live_x"
        )
        XCTAssertEqual(c.baseURL.absoluteString, "http://syrotp.test")
    }

    func testUserAgentIncludesSDKVersion() {
        let c = TestFixtures.makeClient(userAgent: "my-app/1.0")
        XCTAssertTrue(c.userAgent.hasPrefix("syrotp-sdk-swift/"))
        XCTAssertTrue(c.userAgent.contains("my-app/1.0"))
    }

    func testUserAgentStripsControlCharsFromSuffix() {
        let c = TestFixtures.makeClient(userAgent: "evil\r\nX-Injected: yes")
        XCTAssertFalse(c.userAgent.contains("\r"))
        XCTAssertFalse(c.userAgent.contains("\n"))
    }

    // MARK: - startVerification

    func testStartVerificationPostsToV1Verifications() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 201)
            return (response, TestFixtures.verificationJSON())
        }
        let v = try await TestFixtures.makeClient().startVerification(
            phone: "+963991234567",
            purpose: "login"
        )

        let captured = MockURLProtocol.captured.first!
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertEqual(captured.url?.path, "/v1/verifications")
        XCTAssertEqual(captured.value(forHTTPHeaderField: "Authorization"), "Bearer sk_live_TESTKEY")

        let body = try JSONSerialization.jsonObject(with: captured.httpBody!) as! [String: Any]
        XCTAssertEqual(body["phone"] as? String, "+963991234567")
        XCTAssertEqual(body["purpose"] as? String, "login")
        XCTAssertNil(body["client_ref"])
        XCTAssertNil(body["locale"])

        XCTAssertEqual(v.status, .pending)
        XCTAssertEqual(v.sendTo, "+963998887777")
        XCTAssertEqual(v.message, "VERIFY ABC123")
    }

    func testStartVerificationIncludesOptionalFields() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 201)
            return (response, TestFixtures.verificationJSON())
        }
        _ = try await TestFixtures.makeClient().startVerification(
            phone: "+1",
            purpose: "signup",
            clientRef: "user-42",
            locale: "en-US"
        )
        let body = try JSONSerialization.jsonObject(with: MockURLProtocol.captured.first!.httpBody!) as! [String: Any]
        XCTAssertEqual(body["client_ref"] as? String, "user-42")
        XCTAssertEqual(body["locale"] as? String, "en-US")
    }

    func testStartVerificationRejectsEmptyPhone() async {
        do {
            _ = try await TestFixtures.makeClient().startVerification(phone: "", purpose: "login")
            XCTFail("expected throw")
        } catch is SyrotpValidationError {
            // expected
        } catch {
            XCTFail("expected SyrotpValidationError, got \(error)")
        }
    }

    // MARK: - getVerification

    func testGetVerificationFetchesByID() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 200)
            return (response, TestFixtures.verificationJSON(
                status: "verified",
                verifiedAt: "2026-05-02T17:01:00.000Z"
            ))
        }
        let v = try await TestFixtures.makeClient().getVerification("vrf_01HX")
        XCTAssertEqual(v.status, .verified)
        XCTAssertEqual(v.verifiedAt, "2026-05-02T17:01:00.000Z")

        let captured = MockURLProtocol.captured.first!
        XCTAssertEqual(captured.httpMethod, "GET")
        XCTAssertEqual(captured.url?.path, "/v1/verifications/vrf_01HX")
    }

    func testGetVerificationRejectsBadID() async {
        do {
            _ = try await TestFixtures.makeClient().getVerification("not-a-vrf-id")
            XCTFail("expected throw")
        } catch is SyrotpValidationError {
            // expected
        } catch {
            XCTFail("expected SyrotpValidationError, got \(error)")
        }
    }

    // MARK: - cancelVerification

    func testCancelVerificationPostsToCancelPath() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 200)
            return (response, TestFixtures.verificationJSON(status: "cancelled"))
        }
        let v = try await TestFixtures.makeClient().cancelVerification("vrf_01HX")
        XCTAssertEqual(v.status, .cancelled)

        let captured = MockURLProtocol.captured.first!
        XCTAssertEqual(captured.httpMethod, "POST")
        XCTAssertEqual(captured.url?.path, "/v1/verifications/vrf_01HX/cancel")
    }

    // MARK: - error mapping

    func testHTTP401RaisesAuthError() async {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 401)
            return (response, TestFixtures.errorJSON(
                code: "unauthorized",
                message: "missing creds",
                requestId: "req_xyz"
            ))
        }
        do {
            _ = try await TestFixtures.makeClient().startVerification(phone: "+1", purpose: "x")
            XCTFail("expected throw")
        } catch let e as SyrotpAuthError {
            XCTAssertEqual(e.code, "unauthorized")
            XCTAssertEqual(e.httpStatus, 401)
            XCTAssertEqual(e.requestId, "req_xyz")
        } catch {
            XCTFail("expected SyrotpAuthError, got \(error)")
        }
    }

    func testHTTP400RaisesValidationError() async {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 400)
            return (response, TestFixtures.errorJSON(code: "validation_error", message: "bad"))
        }
        do {
            _ = try await TestFixtures.makeClient().startVerification(phone: "+1", purpose: "x")
            XCTFail("expected throw")
        } catch is SyrotpValidationError {
            // expected
        } catch {
            XCTFail("expected SyrotpValidationError, got \(error)")
        }
    }

    func testHTTP500RaisesServerError() async {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 500)
            return (response, TestFixtures.errorJSON(code: "internal_error", message: "boom"))
        }
        do {
            _ = try await TestFixtures.makeClient().startVerification(phone: "+1", purpose: "x")
            XCTFail("expected throw")
        } catch is SyrotpServerError {
            // expected
        } catch {
            XCTFail("expected SyrotpServerError, got \(error)")
        }
    }

    // MARK: - forward-compat

    func testUnknownStatusMapsToUnknown() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 201)
            return (response, TestFixtures.verificationJSON(status: "quantum_uncertain"))
        }
        let v = try await TestFixtures.makeClient().startVerification(phone: "+1", purpose: "x")
        XCTAssertEqual(v.status, .unknown)
    }

    func testUnknownResponseFieldsPreservedInExtras() async throws {
        MockURLProtocol.handler = { req in
            let response = TestFixtures.okResponse(for: req.url!, status: 201)
            return (response, TestFixtures.verificationJSON(extra: ["future_field": 42]))
        }
        let v = try await TestFixtures.makeClient().startVerification(phone: "+1", purpose: "x")
        XCTAssertEqual(v.extras["future_field"], .int(42))
    }
}
