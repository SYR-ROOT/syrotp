import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A `URLProtocol` subclass that intercepts every request running
/// through a session configured with this protocol class, and replies
/// with whatever a per-test handler returns.
///
/// Tests configure the handler before each call so unit tests don't
/// touch the network at all.
final class MockURLProtocol: URLProtocol {

    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    /// Captures every request the SDK actually sent — useful for
    /// assertions on URL, method, headers, body shape.
    nonisolated(unsafe) static var captured: [URLRequest] = []

    static func reset() {
        handler = nil
        captured = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: "MockURLProtocol",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "no handler configured"]
            ))
            return
        }
        // Capture both the original request and a body-included copy
        // (URLProtocol strips the body from request.httpBody during
        // session execution; we restore via httpBodyStream).
        var captured = request
        if captured.httpBody == nil, let stream = request.httpBodyStream {
            captured.httpBody = MockURLProtocol.readAll(stream: stream)
        }
        MockURLProtocol.captured.append(captured)

        do {
            let (response, data) = try handler(captured)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() { /* no-op */ }

    private static func readAll(stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        var data = Data()
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}

extension URLSession {
    /// Convenience: build a session that routes all requests through
    /// `MockURLProtocol`. Must call `MockURLProtocol.reset()` and set
    /// `MockURLProtocol.handler` per test.
    static func mocked() -> URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: cfg)
    }
}
