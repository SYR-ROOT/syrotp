// Quickstart for the SYROTP Swift SDK.
//
// Reads SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) from
// the environment — same convention as scripts/smoke.mjs and the
// `syrotp` CLI.
//
// Run against a running SYROTP server:
//
//     export SYROTP_BASE_URL=http://localhost:3000
//     export SYROTP_SECRET_KEY=sk_live_...
//     swift run Quickstart "+963991234567" login
//
// `main.swift` is the executable target's entry point. Top-level await
// is allowed here as of Swift 5.5; the program runs to completion when
// the awaited Task finishes.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import SyrotpSDK

let argv = CommandLine.arguments
guard argv.count >= 3 else {
    FileHandle.standardError.write(Data("usage: Quickstart <phone> <purpose>\n".utf8))
    exit(2)
}
let phone = argv[1]
let purpose = argv[2]

guard let baseURLString = ProcessInfo.processInfo.environment["SYROTP_BASE_URL"],
      let baseURL = URL(string: baseURLString)
else {
    FileHandle.standardError.write(Data("SYROTP_BASE_URL must be set\n".utf8))
    exit(2)
}
let env = ProcessInfo.processInfo.environment
guard let apiKey = env["SYROTP_SECRET_KEY"] ?? env["SYROTP_PUBLIC_KEY"] else {
    FileHandle.standardError.write(Data("SYROTP_SECRET_KEY or SYROTP_PUBLIC_KEY must be set\n".utf8))
    exit(2)
}

do {
    let client = try SyrotpClient(baseURL: baseURL, apiKey: apiKey)
    let v = try await client.startVerification(phone: phone, purpose: purpose)
    guard v.status == .pending else {
        FileHandle.standardError.write(Data("unexpected status from start: \(v.status.rawValue)\n".utf8))
        exit(1)
    }
    print("verification id: \(v.id)")
    print("  send: \"\(v.message ?? "")\"")
    print("  to:   \(v.sendTo ?? "")")
    print("  for phone \(v.phoneMasked)")

    let cancelled = try await client.cancelVerification(v.id)
    print("final status after cancel: \(cancelled.status.rawValue)")
} catch let e as SyrotpError {
    FileHandle.standardError.write(Data("syrotp error: \(e)\n".utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data("unexpected error: \(error)\n".utf8))
    exit(1)
}
