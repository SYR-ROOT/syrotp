import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension URLSession {
    /// Cross-platform async data fetch.
    ///
    /// Apple platforms have `URLSession.data(for:)` natively. Swift on
    /// Linux (swift-corelibs-foundation as of Swift 5.10) does not yet
    /// expose the async overload, so we wrap the completion-handler
    /// API in a `withCheckedThrowingContinuation`. The Apple native
    /// API is itself a thin wrapper over the same callback path, so
    /// this implementation is identical in behavior.
    ///
    /// Caller `Task` cancellation cancels the in-flight `URLSessionTask`
    /// via `withTaskCancellationHandler`, matching the Apple API's
    /// semantics on every platform.
    func syrotpData(for request: URLRequest) async throws -> (Data, URLResponse) {
        let box = TaskBox()
        return try await withTaskCancellationHandler(
            operation: {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<(Data, URLResponse), Error>) in
                    let task = self.dataTask(with: request) { data, response, error in
                        if let error = error {
                            cont.resume(throwing: error)
                            return
                        }
                        guard let response = response else {
                            cont.resume(throwing: URLError(.badServerResponse))
                            return
                        }
                        cont.resume(returning: (data ?? Data(), response))
                    }
                    box.task = task
                    if box.cancelled {
                        task.cancel()
                        return
                    }
                    task.resume()
                }
            },
            onCancel: {
                box.cancelled = true
                box.task?.cancel()
            }
        )
    }
}

/// Holds a reference to the in-flight URLSessionTask so the cancel
/// handler can reach it. `@unchecked Sendable` because we serialize
/// access via the structured-concurrency contract: the body of
/// `withTaskCancellationHandler` runs on one task; `onCancel` runs at
/// most once. The two writes (`task = task` then `cancelled = true`)
/// either interleave benignly (cancel before resume → cancelled=true,
/// task may or may not be set, we cancel if set) or serially.
private final class TaskBox: @unchecked Sendable {
    var task: URLSessionTask?
    var cancelled: Bool = false
}
