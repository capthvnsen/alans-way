import XCTest
@testable import AlanWorkspace

final class WorkspaceSettingsTests: XCTestCase {
    func testViewerRequiresEncryptedAddressWithoutURLCredentials() {
        XCTAssertNotNil(ViewerAddress.parse(" https://desktop.example.ts.net/vnc.html "))
        for address in ["http://desktop.example/vnc", "javascript:alert(1)", "https://user:password@example.com", "wss://example.com", "not a url"] {
            XCTAssertNil(ViewerAddress.parse(address), address)
        }
    }

    @MainActor func testBotPresentationAndViewerStayBoundToChat() {
        let suite = "workspace-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = WorkspaceSettings(defaults: defaults)
        settings.setAvatar("athena", for: 1)
        XCTAssertTrue(settings.setViewerAddress("https://desktop.example/view", for: 1))
        XCTAssertEqual(settings.avatar(for: 1), "athena")
        XCTAssertEqual(settings.avatar(for: 2), "hermes")
        XCTAssertNil(settings.viewerURL(for: 2))
        XCTAssertFalse(settings.setViewerAddress("http://unsafe.example", for: 1))
        XCTAssertEqual(settings.viewerURL(for: 1)?.absoluteString, "https://desktop.example/view")
        let restored = WorkspaceSettings(defaults: defaults)
        XCTAssertEqual(restored.avatar(for: 1), "athena")
        XCTAssertEqual(restored.viewerURL(for: 1), settings.viewerURL(for: 1))
    }

    @MainActor func testMiniAppDisclosureIsRememberedOnlyForThatAccountAndBot() {
        let suite = "workspace-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = WorkspaceSettings(defaults: defaults)
        settings.grantMiniAppConsent(chatID: 1, accountID: 20, host: "voice.example.test")
        XCTAssertTrue(settings.hasMiniAppConsent(chatID: 1, accountID: 20, host: "voice.example.test"))
        XCTAssertFalse(settings.hasMiniAppConsent(chatID: 1, accountID: 20, host: "other.example.test"))
        XCTAssertFalse(settings.hasMiniAppConsent(chatID: 2, accountID: 20, host: "voice.example.test"))
        XCTAssertFalse(settings.hasMiniAppConsent(chatID: 1, accountID: 21, host: "voice.example.test"))
        XCTAssertFalse(settings.hasMiniAppConsent(chatID: 1, accountID: nil, host: "voice.example.test"))
    }

    @MainActor func testOnboardingCompletionPersists() {
        let suite = "workspace-test-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let settings = WorkspaceSettings(defaults: defaults)
        XCTAssertFalse(settings.hasCompletedOnboarding)
        settings.completeOnboarding()
        XCTAssertTrue(settings.hasCompletedOnboarding)
        XCTAssertTrue(WorkspaceSettings(defaults: defaults).hasCompletedOnboarding)
    }
}
