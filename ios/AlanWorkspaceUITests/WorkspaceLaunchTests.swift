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

    func testFirstLaunchExplainsTelegramAndRequiresCredentials() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.textFields["telegramAPIID"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.secureTextFields["telegramAPIHash"].exists)
        XCTAssertFalse(app.buttons["signInContinue"].isEnabled)
        XCTAssertTrue(app.staticTexts["CONNECTED THROUGH TELEGRAM"].exists)
    }

    func testPreviewChatAgentPresentationAndComputerNavigation() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "--interface-preview"]
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
        app.launchArguments = ["--ui-testing", "--invalid-call-host"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Call page unavailable"].waitForExistence(timeout: 10))
        let close = app.buttons["Close voice call"]
        XCTAssertTrue(close.isHittable)
        close.tap()
        XCTAssertTrue(app.textFields["telegramAPIID"].waitForExistence(timeout: 5))
    }
}
