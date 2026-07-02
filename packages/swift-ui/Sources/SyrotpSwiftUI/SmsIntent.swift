import Foundation

/// Build the `sms:` URL that opens the user's default Messages app
/// pre-filled with the verification message addressed to the
/// receiver msisdn.
///
/// Encoding rules match the React / Web Component / Android UI /
/// Flutter packages: the body is percent-encoded the same way
/// JavaScript's `encodeURIComponent` produces. Foundation's
/// `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)`
/// is too permissive (allows `?`, `&`, `#`); we restrict to a
/// custom set so the contract holds byte-for-byte.
public enum SmsIntent {
    /// Build the `sms:` URL. Force-unwraps because the path-encoded
    /// recipient is constrained at the call site (always a digit-
    /// and-`+` E.164 string from the verification record), and the
    /// percent-encoded body is always URL-safe by construction.
    public static func buildSmsUrl(recipient: String, body: String) -> URL {
        let encodedBody = encodeSmsBody(body)
        // swiftlint:disable:next force_unwrapping
        return URL(string: "sms:\(recipient)?body=\(encodedBody)")!
    }

    /// Pure-Foundation percent-encoding helper. Public so tests can
    /// pin the cross-stack `%20`-for-space contract.
    public static func encodeSmsBody(_ body: String) -> String {
        // ASCII letters/digits + `-._~` are the unreserved characters
        // per RFC 3986; everything else gets percent-encoded. This
        // matches what JavaScript's `encodeURIComponent` produces.
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return body.addingPercentEncoding(withAllowedCharacters: allowed) ?? body
    }
}
