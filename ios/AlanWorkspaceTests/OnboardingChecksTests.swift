import XCTest
@testable import AlanWorkspace

final class OnboardingChecksTests: XCTestCase {
    func testAppCredentialsNeedNumericIDAnd32CharacterHexHash() {
        let hash = "0123456789abcdef0123456789ABCDEF"
        XCTAssertNil(TelegramAppCredentials.problem(apiID: " 123456 ", apiHash: " \(hash)\n"))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "", apiHash: hash))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "0", apiHash: hash))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "12a", apiHash: hash))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "123", apiHash: String(hash.dropLast())))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "123", apiHash: String(hash.dropLast()) + "g"))
        XCTAssertNotNil(TelegramAppCredentials.problem(apiID: "123", apiHash: "1234567890:AAbot-token-looking-value"))
    }

    func testVoiceProbeUsesMiniAppOriginAndRejectsUnsafeAddresses() {
        XCTAssertEqual(ConnectionCheck.voiceProbeURL(" https://voice.example.net/call/?ticket=x#a ")?.absoluteString,
                       "https://voice.example.net/v1/capabilities")
        XCTAssertEqual(ConnectionCheck.voiceProbeURL("https://voice.example.net:8443/call")?.absoluteString,
                       "https://voice.example.net:8443/v1/capabilities")
        for address in ["http://voice.example.net/call", "https://user:secret@voice.example.net/call", "voice.example.net"] {
            XCTAssertNil(ConnectionCheck.voiceProbeURL(address), address)
        }
    }

    func testVoiceResponsesExplainEachFailure() {
        XCTAssertEqual(ConnectionCheck.voice(status: 200, body: Data(#"{"version":1,"ready":true}"#.utf8)),
                       .ok("The voice service is ready for calls."))
        guard case .problem(let notReady) = ConnectionCheck.voice(status: 503, body: Data(#"{"version":1,"ready":false}"#.utf8)) else {
            return XCTFail("503 must be a problem")
        }
        XCTAssertTrue(notReady.contains("STT and TTS"))
        XCTAssertEqual(ConnectionCheck.voice(status: 200, body: Data(#"{"ready":false}"#.utf8)), .problem(notReady))
        for (status, phrase) in [(502, "/call"), (504, "/call"), (404, "app_url"), (418, "HTTP 418")] {
            guard case .problem(let text) = ConnectionCheck.voice(status: status, body: Data()) else { return XCTFail("\(status)") }
            XCTAssertTrue(text.contains(phrase), "\(status): \(text)")
        }
        guard case .problem(let html) = ConnectionCheck.voice(status: 200, body: Data("<html>".utf8)) else { return XCTFail("html") }
        XCTAssertTrue(html.contains("not the Hermes voice service"))
    }

    func testViewerTreatsSignInPagesAsReachable() {
        for status in [200, 302, 401, 403] {
            guard case .ok = ConnectionCheck.viewer(status: status) else { return XCTFail("\(status)") }
        }
        for status in [404, 500, 503, 418] {
            guard case .problem = ConnectionCheck.viewer(status: status) else { return XCTFail("\(status)") }
        }
    }

    func testTransportErrorsGiveActionableAdvice() {
        let cases: [(URLError.Code, String)] = [
            (.notConnectedToInternet, "offline"), (.cannotFindHost, "Tailscale"), (.timedOut, "did not respond"),
            (.serverCertificateUntrusted, "certificate"), (.appTransportSecurityRequiresSecureConnection, "https://")
        ]
        for (code, phrase) in cases {
            guard case .problem(let text) = ConnectionCheck.transport(URLError(code)) else { return XCTFail("\(code)") }
            XCTAssertTrue(text.contains(phrase), "\(code): \(text)")
        }
    }

    func testTelegramErrorsAreReadable() {
        XCTAssertTrue(TelegramErrorText.describe(code: 400, message: "API_ID_INVALID").contains("my.telegram.org/apps"))
        XCTAssertTrue(TelegramErrorText.describe(code: 400, message: "PHONE_NUMBER_INVALID").contains("country code"))
        XCTAssertTrue(TelegramErrorText.describe(code: 400, message: "PHONE_CODE_INVALID").contains("latest code"))
        XCTAssertTrue(TelegramErrorText.describe(code: 429, message: "FLOOD_WAIT_61").contains("2 minutes"))
        XCTAssertTrue(TelegramErrorText.describe(code: 429, message: "FLOOD_WAIT_30").contains("a minute"))
        XCTAssertFalse(TelegramErrorText.describe(code: 406, message: "SECRET_DETAIL").contains("SECRET_DETAIL"))
        XCTAssertEqual(TelegramErrorText.describe(code: 400, message: "SOMETHING_NEW"), "Telegram reported SOMETHING_NEW.")
        XCTAssertEqual(TelegramErrorText.describe(TelegramStoreError.notAuthorized), "Sign in to Telegram to continue.")
    }
}
