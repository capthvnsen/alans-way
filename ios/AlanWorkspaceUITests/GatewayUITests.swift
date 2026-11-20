import XCTest

/// Alan's Way end to end through the real UI, against the desktop's fake Hermes backend (fake data, loopback only).
/// Started by `ios/scripts/test-gateway-integration.sh`, which passes GATEWAY_FAKE_URL / GATEWAY_FAKE_CONTROL; without
/// them these tests skip. With GATEWAY_SHOT_DIR set, each step also saves a screenshot there as i1-<name>.png.
final class GatewayUITests: XCTestCase {
    private var fakeURL = "", control = ""
    private var shots: URL?
    private let dynamicType = "UICTContentSizeCategoryAccessibilityXXXL"

    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let url = env["GATEWAY_FAKE_URL"], let control = env["GATEWAY_FAKE_CONTROL"] else { throw XCTSkip("Run ios/scripts/test-gateway-integration.sh to start the fake backend.") }
        fakeURL = url; self.control = control
        shots = env["GATEWAY_SHOT_DIR"].map { URL(fileURLWithPath: $0) }
    }

    /// The sign-in lives in the simulator's Keychain, which outlives the app: clear it so later tests start signed out.
    override func tearDown() {
        guard !fakeURL.isEmpty else { return }
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--gateway-reset"]
        app.launch(); app.terminate()
    }

    private func launch(_ args: [String], environment: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--gateway-reset", "--gateway-allow-loopback"] + args
        app.launchEnvironment.merge(environment) { $1 }
        app.launch()
        return app
    }
    private func snap(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png"); attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
        if let shots { try? png.write(to: shots.appendingPathComponent("i1-\(name).png")) }
    }
    private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    private func containing(_ app: XCUIApplication, _ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }
    /// The reply has finished streaming: no bubble says "Replying…" any more.
    private func waitForReplyToFinish(_ app: XCUIApplication) {
        let replying = containing(app, "Replying")
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: replying)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 30), .completed, "the reply finishes")
    }
    private func fillSignIn(_ app: XCUIApplication) {
        let address = app.textFields["gatewayAddress"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap(); address.typeText(fakeURL)
        let user = app.textFields["gatewayUsername"]; user.tap(); user.typeText("alex")
        let password = app.secureTextFields["gatewayPassword"]; password.tap(); password.typeText("a-fake-password")
    }
    private func submitSignIn(_ app: XCUIApplication) {
        // The Go key on the password field signs in; at the largest type size the button is scrolled away under the keyboard.
        let password = app.secureTextFields["gatewayPassword"]
        XCTAssertTrue(password.exists)
        password.typeText("\n")
    }
    private func send(_ app: XCUIApplication, _ text: String) {
        let composer = any(app, "gatewayComposer")
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        composer.tap(); composer.typeText(text)
        app.buttons["gatewaySend"].tap()
    }
    private func signInFromFirstRun(_ app: XCUIApplication, snapshotForm: Bool = false) {
        let use = app.buttons["useAlansWay"]
        XCTAssertTrue(use.waitForExistence(timeout: 15))
        use.tap()
        fillSignIn(app)
        if snapshotForm { app.swipeDown(); snap("settings-signin") }
        submitSignIn(app)
    }

    func testGatewayOnlyGoldenPath() throws {
        let app = launch([])
        signInFromFirstRun(app, snapshotForm: true)
        let row = app.buttons["gatewayConversation-key-1"]
        if !row.waitForExistence(timeout: 20) { snap("debug-no-list"); print(app.debugDescription) }
        XCTAssertTrue(row.exists, "the conversation list appears once signed in")
        XCTAssertFalse(app.tabBars.firstMatch.exists, "no tab bar without Telegram")
        snap("conversation-list")
        row.tap()
        XCTAssertTrue(containing(app, "said:").waitForExistence(timeout: 15), "history loads")
        snap("chat-history")
        send(app, "show me an example in code")
        XCTAssertTrue(containing(app, "eplying").waitForExistence(timeout: 15), "the reply is seen streaming")
        waitForReplyToFinish(app)
        XCTAssertTrue(app.buttons["Copy code"].exists, "the reply arrived with its code block")
        XCTAssertTrue(app.buttons["Copy code"].exists)
        snap("chat-reply-code")
        // Edge: Stop is not left behind after the reply.
        XCTAssertFalse(any(app, "gatewayReplying").exists)
    }

    func testAMessageSentWhileOfflineWaitsThenIsNotSentAfterTheLimit() throws {
        let app = launch([], environment: ["GATEWAY_QUEUE_MAX_AGE": "6"])
        signInFromFirstRun(app)
        let row = app.buttons["gatewayConversation-key-2"]
        XCTAssertTrue(row.waitForExistence(timeout: 20)); row.tap()
        XCTAssertTrue(containing(app, "Draft the release notes headline").waitForExistence(timeout: 15))
        _ = try? Data(contentsOf: URL(string: control + "/stop")!)     // the gateway goes away
        defer { _ = try? Data(contentsOf: URL(string: control + "/start")!) }
        send(app, "Please remember this when you are back")
        let waiting = app.staticTexts["Waiting to send"]
        XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["gatewayCancel"].exists)
        snap("chat-queued")
        let notSent = app.staticTexts["Not sent"]
        XCTAssertTrue(notSent.waitForExistence(timeout: 20), "past the limit it becomes Not sent, it is not sent on its own")
        XCTAssertTrue(app.buttons["gatewayRetry"].exists && app.buttons["gatewayDelete"].exists)
        snap("chat-not-sent")
        app.buttons["gatewayRetry"].tap()
        XCTAssertTrue(waiting.waitForExistence(timeout: 5), "Retry queues it again")
        app.buttons["gatewayCancel"].tap()
        XCTAssertFalse(containing(app, "Please remember this").waitForExistence(timeout: 2), "Cancel removes it")
    }

    func testTabsAppearBesideTelegramOnceAGatewayIsSignedIn() throws {
        let app = launch(["--interface-preview", "-workspace.onboardingComplete", "YES"])
        let settings = app.buttons["workspaceSettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 15))
        XCTAssertFalse(app.tabBars.firstMatch.exists, "one tab until a gateway is configured")
        snap("tabs-absent-telegram-only")
        settings.tap()
        let link = app.buttons["alansWaySettings"]
        for _ in 0..<3 where !link.exists { app.swipeUp() }     // the section sits below the fold
        XCTAssertTrue(link.waitForExistence(timeout: 5)); link.tap()
        fillSignIn(app)
        submitSignIn(app)
        // Signing in closes the settings: the tab bar appears beside Telegram.
        let telegramTab = app.tabBars.buttons["Telegram"], alansWayTab = app.tabBars.buttons["Alan’s Way"]
        XCTAssertTrue(telegramTab.waitForExistence(timeout: 20) && alansWayTab.exists)
        snap("tabs-present-telegram")
        alansWayTab.tap()
        XCTAssertTrue(app.buttons["gatewayConversation-key-1"].waitForExistence(timeout: 20))
        snap("tabs-present-alans-way")
        telegramTab.tap()
        XCTAssertTrue(app.buttons["workspaceSettings"].waitForExistence(timeout: 5))
    }

    func testLargestDynamicTypeStaysUsable() throws {
        let app = launch(["-UIPreferredContentSizeCategoryName", dynamicType])
        signInFromFirstRun(app)
        let row = app.buttons["gatewayConversation-key-1"]
        XCTAssertTrue(row.waitForExistence(timeout: 20))
        snap("conversation-list-largest-type")
        row.tap()
        XCTAssertTrue(containing(app, "said:").waitForExistence(timeout: 15), "history loads")
        send(app, "hello")
        XCTAssertTrue(containing(app, "You said: hello").waitForExistence(timeout: 30))
        waitForReplyToFinish(app)
        snap("chat-largest-type")
        XCTAssertTrue(app.buttons["gatewaySend"].isHittable || any(app, "gatewayComposer").isHittable)
    }
}
