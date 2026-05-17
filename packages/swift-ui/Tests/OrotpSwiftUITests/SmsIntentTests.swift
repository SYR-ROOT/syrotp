import XCTest
@testable import SyrotpSwiftUI

final class SmsIntentTests: XCTestCase {

    func testEncodeSmsBodyPercentEncodesSpacesAs20() {
        XCTAssertEqual(SmsIntent.encodeSmsBody("VERIFY 123456"), "VERIFY%20123456")
    }

    func testEncodeSmsBodyPercentEncodesSpecialCharacters() {
        XCTAssertEqual(SmsIntent.encodeSmsBody("a&b"), "a%26b")
        XCTAssertEqual(SmsIntent.encodeSmsBody("a?b"), "a%3Fb")
        XCTAssertEqual(SmsIntent.encodeSmsBody("a#b"), "a%23b")
    }

    func testEncodeSmsBodyKeepsAsciiAlphanumericAsIs() {
        XCTAssertEqual(SmsIntent.encodeSmsBody("ABC123abc"), "ABC123abc")
    }

    func testBuildSmsUrlProducesSmsSchemeWithEncodedBody() {
        let url = SmsIntent.buildSmsUrl(recipient: "+963998887777", body: "VERIFY 123456")
        XCTAssertEqual(url.scheme, "sms")
        XCTAssertEqual(url.absoluteString, "sms:+963998887777?body=VERIFY%20123456")
    }
}
