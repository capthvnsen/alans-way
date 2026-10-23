import XCTest
@testable import AlanWorkspace

final class CallOriginPolicyTests: XCTestCase {
    func testOnlyExactHTTPSOriginIsTrusted() throws {
        let origin = try XCTUnwrap(CallOrigin(url: URL(string: "https://voice.example.test/launch?ticket=opaque")!))
        XCTAssertTrue(origin.contains(URL(string: "https://voice.example.test/v1/calls")!))
        XCTAssertFalse(origin.contains(URL(string: "https://voice.example.test.evil.invalid/path")!))
        XCTAssertFalse(origin.contains(URL(string: "https://evil.invalid/path")!))
        XCTAssertFalse(origin.contains(URL(string: "http://voice.example.test/path")!))
        XCTAssertFalse(origin.contains(URL(string: "https://voice.example.test:444/path")!))
    }

    func testRejectsHTTPAndCredentialBearingLaunchURLs() {
        XCTAssertNil(CallOrigin(url: URL(string: "http://voice.example.test/call")!))
        XCTAssertNil(CallOrigin(url: URL(string: "https://user:pass@voice.example.test/call")!))
    }

    func testNativeBridgeHandlesOnlyTelegramEventsNeededByTheCall() {
        XCTAssertTrue(CallBridgePolicy.handles("web_app_ready"))
        XCTAssertTrue(CallBridgePolicy.handles("web_app_request_theme"))
        XCTAssertTrue(CallBridgePolicy.handles("web_app_request_fullscreen"))
        XCTAssertTrue(CallBridgePolicy.handles("web_app_close"))
        XCTAssertTrue(CallBridgePolicy.handles("hermes_open_computer"))
        XCTAssertFalse(CallBridgePolicy.handles("web_app_invoke_custom_method"))
        XCTAssertFalse(CallBridgePolicy.handles("open_url"))
    }

    func testNativeBridgeParsesTelegramEventDataAsJSONOrObject() throws {
        let text = try XCTUnwrap(CallBridgePolicy.eventData("{\"is_visible\":true,\"label\":\"Hermes\"}"))
        XCTAssertEqual(text["is_visible"] as? Bool, true)
        XCTAssertEqual(text["label"] as? String, "Hermes")

        let object = try XCTUnwrap(CallBridgePolicy.eventData(["impact_style": "light"]))
        XCTAssertEqual(object["impact_style"] as? String, "light")
        XCTAssertNil(CallBridgePolicy.eventData("not json"))
    }

    func testExternalLinksRequireAUserActivatedApprovedScheme() {
        XCTAssertTrue(CallBridgePolicy.allowsExternalLink(URL(string: "https://docs.example.test/help")!))
        XCTAssertTrue(CallBridgePolicy.allowsExternalLink(URL(string: "mailto:help@example.test")!))
        XCTAssertTrue(CallBridgePolicy.allowsExternalLink(URL(string: "tel:+15555550123")!))
        XCTAssertFalse(CallBridgePolicy.allowsExternalLink(URL(string: "javascript:alert(1)")!))
        XCTAssertFalse(CallBridgePolicy.allowsExternalLink(URL(string: "file:///etc/passwd")!))
        XCTAssertFalse(CallBridgePolicy.allowsExternalLink(URL(string: "https:docs.example.test")!))
    }

    func testInactiveSceneDoesNotEndPermissionPromptOrAudioInterruption() {
        XCTAssertEqual(CallHostLifecycleAction(scenePhase: .inactive), .none)
        XCTAssertEqual(CallHostLifecycleAction(scenePhase: .background), .deactivate)
        XCTAssertEqual(CallHostLifecycleAction(scenePhase: .active), .activate)
    }
}
