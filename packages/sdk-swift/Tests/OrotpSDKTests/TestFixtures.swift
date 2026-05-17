import Foundation
@testable import SyrotpSDK

enum TestFixtures {
    static func verificationJSON(
        id: String = "vrf_01HX",
        status: String = "pending",
        sendTo: String? = "+963998887777",
        message: String? = "VERIFY ABC123",
        verifiedAt: String? = nil,
        extra: [String: Any] = [:]
    ) -> Data {
        var dict: [String: Any] = [
            "id": id,
            "status": status,
            "phone_masked": "+96399****567",
            "purpose": "login",
            "expires_at": "2026-05-02T18:00:00.000Z",
            "created_at": "2026-05-02T17:00:00.000Z",
        ]
        if let s = sendTo { dict["send_to"] = s }
        if let m = message { dict["message"] = m }
        if let v = verifiedAt { dict["verified_at"] = v }
        for (k, v) in extra { dict[k] = v }
        return try! JSONSerialization.data(withJSONObject: dict)
    }

    static func errorJSON(code: String, message: String, requestId: String? = nil) -> Data {
        var inner: [String: Any] = ["code": code, "message": message]
        if let r = requestId { inner["request_id"] = r }
        return try! JSONSerialization.data(withJSONObject: ["error": inner])
    }

    static func okResponse(for url: URL, status: Int = 200) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
    }

    static func makeClient(
        retries: Int = 0,
        userAgent: String? = nil,
        logHandler: (@Sendable (String) -> Void)? = nil
    ) -> SyrotpClient {
        try! SyrotpClient(
            baseURL: URL(string: "http://syrotp.test")!,
            apiKey: "sk_live_TESTKEY",
            timeoutSeconds: 5.0,
            retries: retries,
            userAgent: userAgent,
            session: URLSession.mocked(),
            sleeper: { _ in /* no wall-clock waiting in tests */ },
            logHandler: logHandler
        )
    }
}
