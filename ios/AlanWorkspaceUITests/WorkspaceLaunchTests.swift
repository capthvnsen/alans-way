import XCTest

final class WorkspaceLaunchTests: XCTestCase {
    /// Opt-in integration gate: uses an already signed-in account and launches a
    /// genuine bot call. The host harness terminates this simulator's WebContent
    /// process after the connected marker to exercise OS-driven crash recovery.
    func testAuthenticatedCallStaysActiveAndRecoversFromWebContentTermination() throws {
        continueAfterFailure = false
        guard let chatID = ProcessInfo.processInfo.environment["ALAN_CALL_SMOKE_CHAT_ID"] else {
            throw XCTSkip("Requires an opted-in, signed-in simulator and a bot chat ID.")
        }
        let app = XCUIApplication()
        app.launchArguments = Self.onboarded
        app.launch()
        let chat = app.buttons["agentChat-\(chatID)"]
        XCTAssertTrue(chat.waitForExistence(timeout: 20))
        chat.tap()
        let call = app.buttons["agentCall"]
        XCTAssertTrue(call.waitForExistence(timeout: 5))
        call.tap()
        let start = app.webViews.buttons["Start call"]
        XCTAssertTrue(start.waitForExistence(timeout: 30))
        start.tap()
        let sendVoice = app.webViews.buttons["Send recorded voice turn"]
        XCTAssertTrue(sendVoice.waitForExistence(timeout: 20))
        let interruption = app.staticTexts["Call interrupted"]
        let unexpectedCrash = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true"), object: interruption)
        unexpectedCrash.isInverted = true
        wait(for: [unexpectedCrash], timeout: 25)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Authenticated call after audio warmup"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(sendVoice.exists || app.webViews.buttons["Stop reply audio"].exists || app.webViews.staticTexts["One moment…"].exists,
                      "The call must still be listening, handling a turn, or speaking after audio monitoring warms up.")
        if ProcessInfo.processInfo.environment["ALAN_CALL_SMOKE_TERMINATE"] == "1" {
            print("[Call smoke] Authenticated call connected; ready for WebContent termination.")
            XCTAssertTrue(interruption.waitForExistence(timeout: 45))
            XCTAssertFalse(app.buttons["Try again"].exists)
        }
        let close = app.buttons["Close voice call"]
        XCTAssertTrue(close.isHittable)
        close.tap()
        XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 5))
    }

    /// Overrides the persisted first-run flag through the launch argument domain.
    private static let onboarded = ["-workspace.onboardingComplete", "YES"]
    private static let firstRun = ["-workspace.onboardingComplete", "NO"]

    /// Walks the credential steps without submitting, so no Telegram session or Keychain item is touched.
    func testFirstLaunchGuidesThroughTelegramAppCredentials() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + Self.firstRun
        app.launch()
        let start = app.buttons["onboardingStart"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        attachScreenshot(app, "Onboarding 1 — welcome")
        start.tap()

        XCTAssertTrue(app.staticTexts["STEP 1 OF 3 · TELEGRAM APP"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["telegramDeveloperLink"].exists)
        let apiID = app.textFields["telegramAPIID"]
        let apiHash = app.secureTextFields["telegramAPIHash"]
        XCTAssertFalse(app.buttons["signInContinue"].isEnabled)
        apiID.tap(); apiID.typeText("12345")
        apiHash.tap(); apiHash.typeText("not-a-hash")
        XCTAssertTrue(app.staticTexts["telegramCredentialHint"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.buttons["signInContinue"].isEnabled)
        attachScreenshot(app, "Onboarding 2 — app credentials with a validation hint")
        apiHash.tap()
        apiHash.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 10) + String(repeating: "ab", count: 16))
        XCTAssertFalse(app.staticTexts["telegramCredentialHint"].exists)
        XCTAssertTrue(app.buttons["signInContinue"].isEnabled)
        XCTAssertTrue(app.staticTexts["CONNECTED THROUGH TELEGRAM"].exists)
    }

    func testFirstRunBotChoiceChecksAndSkip() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--interface-preview"] + Self.firstRun
        app.launch()
        XCTAssertTrue(app.staticTexts["STEP 3 OF 3 · YOUR HERMES BOT"].waitForExistence(timeout: 10))
        let continueButton = app.buttons["onboardingContinue"]
        XCTAssertFalse(continueButton.isEnabled)
        app.buttons["onboardingBot-101"].tap()
        XCTAssertEqual(app.buttons["onboardingBot-101"].value as? String, "Selected")
        XCTAssertTrue(continueButton.isEnabled)
        attachScreenshot(app, "Onboarding 3 — choose the Hermes bot")
        continueButton.tap()

        XCTAssertTrue(app.staticTexts["OPTIONAL · VOICE AND COMPUTER"].waitForExistence(timeout: 5))
        let voice = app.textFields["onboardingVoiceAddress"]
        voice.tap(); voice.typeText("http://voice.example.test/call\n")
        app.buttons["onboardingVoiceCheck"].tap()
        let voiceResult = app.descendants(matching: .any)["onboardingVoiceResult"].firstMatch
        XCTAssertTrue(voiceResult.waitForExistence(timeout: 5))
        XCTAssertTrue(voiceResult.label.contains("https://"), voiceResult.label)
        let viewer = app.textFields["onboardingViewerAddress"]
        viewer.tap(); viewer.typeText("https://user:secret@desktop.example.test/vnc.html\n")
        app.buttons["onboardingViewerCheck"].tap()
        let viewerResult = app.descendants(matching: .any)["onboardingViewerResult"].firstMatch
        XCTAssertTrue(viewerResult.waitForExistence(timeout: 5))
        attachScreenshot(app, "Onboarding 4 — optional checks with clear errors")
        app.buttons["onboardingFinish"].tap()
        XCTAssertTrue(viewerResult.exists, "An unsafe viewer address must not be saved.")
        app.buttons["onboardingSkipChecks"].tap()
        XCTAssertTrue(app.buttons["agentChat-101"].waitForExistence(timeout: 5))
    }

    private func attachScreenshot(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testPreviewChatAgentPresentationAndComputerNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--interface-preview"] + Self.onboarded
        app.launch()
        XCTAssertTrue(app.staticTexts["INTERFACE PREVIEW · SAMPLE DATA"].waitForExistence(timeout: 10))
        app.buttons["agentChat-101"].tap()
        XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pick up where we left off."].exists)
        XCTAssertTrue(app.buttons["agentCall"].exists)
        app.buttons["agentSettings"].tap()
        let athena = app.buttons["Athena avatar"]
        XCTAssertTrue(athena.waitForExistence(timeout: 5))
        athena.tap()
        XCTAssertEqual(athena.value as? String, "Selected")
        app.buttons["Done"].tap()
        app.buttons["agentComputer"].tap()
        XCTAssertTrue(app.buttons["Connect computer"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(app.textFields["messageComposer"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Conversation interface preview — sample data"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testInvalidCallLaunchShowsFailureAndCanAlwaysBeClosed() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--invalid-call-host"] + Self.onboarded
        app.launch()
        XCTAssertTrue(app.staticTexts["Call page unavailable"].waitForExistence(timeout: 10))
        let close = app.buttons["Close voice call"]
        XCTAssertTrue(close.isHittable)
        close.tap()
        XCTAssertTrue(app.textFields["telegramAPIID"].waitForExistence(timeout: 5))
    }
}
