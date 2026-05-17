import XCTest
@testable import SyrotpSDK

final class ErrorsTests: XCTestCase {

    func testAllSevenInheritFromSyrotpError() {
        let errors: [SyrotpError] = [
            SyrotpConfigError("x"),
            SyrotpAuthError(code: "unauthorized", message: "x"),
            SyrotpValidationError(code: "validation_error", message: "x"),
            SyrotpRateLimitError(code: "rate_limited", message: "x"),
            SyrotpNetworkError(message: "x"),
            SyrotpServerError(code: "internal_error", message: "x", httpStatus: 500),
            SyrotpTimeoutError(),
        ]
        for e in errors {
            // Compile-time check: they all assign to SyrotpError. The
            // runtime check via `is SyrotpError` is implicit by typing.
            XCTAssertNotNil(e.code)
        }
    }

    func testEachErrorHasFourCoreAttributes() {
        let e = SyrotpAuthError(
            code: "unauthorized",
            message: "missing creds",
            httpStatus: 401,
            requestId: "req_xyz"
        )
        XCTAssertEqual(e.code, "unauthorized")
        XCTAssertEqual(e.message, "missing creds")
        XCTAssertEqual(e.httpStatus, 401)
        XCTAssertEqual(e.requestId, "req_xyz")
    }

    func testRateLimitErrorCarriesRetryAfterSeconds() {
        let e = SyrotpRateLimitError(
            code: "rate_limited",
            message: "slow",
            retryAfterSeconds: 42
        )
        XCTAssertEqual(e.retryAfterSeconds, 42)
        XCTAssertEqual(e.httpStatus, 429)
    }

    func testDescriptionIncludesClassNameCodeMessageStatus() {
        let rendered = SyrotpAuthError(
            code: "unauthorized",
            message: "missing creds",
            httpStatus: 401,
            requestId: "req_xyz"
        ).description
        XCTAssertTrue(rendered.contains("SyrotpAuthError"))
        XCTAssertTrue(rendered.contains("unauthorized"))
        XCTAssertTrue(rendered.contains("missing creds"))
        XCTAssertTrue(rendered.contains("401"))
        XCTAssertTrue(rendered.contains("req_xyz"))
    }

    func testDescriptionDoesNotEchoArbitraryAttributes() {
        let rendered = SyrotpAuthError(
            code: "unauthorized",
            message: "missing creds",
            httpStatus: 401,
            requestId: "req_xyz"
        ).description
        let lower = rendered.lowercased()
        XCTAssertFalse(lower.contains("api_key"))
        XCTAssertFalse(lower.contains("authorization"))
    }

    func testNetworkErrorPreservesUnderlying() {
        let cause = NSError(domain: "Test", code: -1, userInfo: nil)
        let e = SyrotpNetworkError(message: "transport failed", underlying: cause)
        XCTAssertNotNil(e.underlying)
    }

    func testTimeoutErrorHasStableCode() {
        let e = SyrotpTimeoutError()
        XCTAssertEqual(e.code, "timeout")
    }
}
