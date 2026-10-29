import XCTest
import TDLibKit
@testable import AlanWorkspace

final class TelegramModelMapperTests: XCTestCase {
    func testEncryptedDatabaseKeyPersistsInDeviceKeychain() throws {
        let first = try TelegramKeychain.databaseEncryptionKey()
        XCTAssertEqual(first.count, 32)
        XCTAssertEqual(try TelegramKeychain.databaseEncryptionKey(), first)
    }

    #if DEBUG
    @MainActor
    func testInterfacePreviewIsClearlySeparateFromAnAuthenticatedTelegramSession() {
        let preview = TelegramStore.interfacePreview()

        XCTAssertTrue(preview.isInterfacePreview)
        XCTAssertEqual(preview.authState, .ready)
        XCTAssertEqual(preview.chats.map(\.id), [101, 102])
        XCTAssertTrue(preview.chats.allSatisfy(\.isBot))
        XCTAssertEqual(preview.messagesByChat[101]?.count, 3)
    }
    #endif

    func testPlainTextContentPreservesTelegramTextWithoutInventingAnAttachment() {
        let content = MessageContent.messageText(
            MessageText(linkPreview: nil, linkPreviewOptions: nil,
                        text: FormattedText(entities: [], text: "A reply from the selected bot"))
        )

        let mapped = TelegramModelMapper.content(content)

        XCTAssertEqual(mapped.0, "A reply from the selected bot")
        XCTAssertNil(mapped.1)
    }

    func testInlineWebAppButtonRetainsItsHTTPSDestinationAndKind() {
        let button = InlineKeyboardButton(
            iconCustomEmojiId: 0,
            style: .buttonStyleDefault,
            text: "Call",
            type: .inlineKeyboardButtonTypeWebApp(InlineKeyboardButtonTypeWebApp(url: "https://voice.example.test/call"))
        )
        let markup = ReplyMarkup.replyMarkupInlineKeyboard(
            ReplyMarkupInlineKeyboard(forceReply: false, rows: [[button]])
        )

        let rows = TelegramModelMapper.buttons(markup)

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].count, 1)
        XCTAssertEqual(rows[0][0].title, "Call")
        XCTAssertEqual(rows[0][0].kind, .webApp(URL(string: "https://voice.example.test/call")!))
    }

    func testOrdinaryURLButtonIsNotPromotedToAuthenticatedMiniApp() {
        let button = InlineKeyboardButton(
            iconCustomEmojiId: 0,
            style: .buttonStyleDefault,
            text: "Website",
            type: .inlineKeyboardButtonTypeUrl(InlineKeyboardButtonTypeUrl(url: "https://example.test"))
        )
        let markup = ReplyMarkup.replyMarkupInlineKeyboard(
            ReplyMarkupInlineKeyboard(forceReply: false, rows: [[button]])
        )

        let mapped = TelegramModelMapper.buttons(markup)[0][0]

        XCTAssertEqual(mapped.kind, .url(URL(string: "https://example.test")!))
    }

    func testReplyKeyboardWebAppButtonIsStillRepresentedAsAWebApp() {
        let button = KeyboardButton(
            iconCustomEmojiId: 0,
            style: .buttonStyleDefault,
            text: "Call",
            type: .keyboardButtonTypeWebApp(KeyboardButtonTypeWebApp(url: "https://voice.example.test/call"))
        )
        let markup = ReplyMarkup.replyMarkupShowKeyboard(
            ReplyMarkupShowKeyboard(forceReply: false, inputFieldPlaceholder: "", isPersistent: true,
                                    isPersonal: false, oneTime: false, resizeKeyboard: true, rows: [[button]])
        )

        let mapped = TelegramModelMapper.buttons(markup)[0][0]

        XCTAssertEqual(mapped.kind, .webApp(URL(string: "https://voice.example.test/call")!))
    }

    func testCallTicketMatcherAcceptsOnlyFreshIncomingWebAppFromSelectedBotAndChat() {
        let freshCall = message(id: 12, chatID: 4, senderID: 9, isOutgoing: false,
                               title: "Start call", kind: .webApp(URL(string: "https://voice.example.test/call?ticket=once")!))
        let oldCall = message(id: 10, chatID: 4, senderID: 9, isOutgoing: false,
                              title: "Call", kind: .webApp(URL(string: "https://voice.example.test/call?ticket=old")!))
        let otherBot = message(id: 13, chatID: 4, senderID: 11, isOutgoing: false,
                               title: "Call", kind: .webApp(URL(string: "https://voice.example.test/call?ticket=wrong-bot")!))
        let otherChat = message(id: 14, chatID: 5, senderID: 9, isOutgoing: false,
                                title: "Call", kind: .webApp(URL(string: "https://voice.example.test/call?ticket=wrong-chat")!))
        let outgoing = message(id: 15, chatID: 4, senderID: 4, isOutgoing: true,
                               title: "Call", kind: .webApp(URL(string: "https://voice.example.test/call?ticket=outgoing")!))

        let match = TelegramLaunchMatcher.callURL(in: [oldCall, otherBot, otherChat, outgoing, freshCall],
                                                   afterMessageID: 10, chatID: 4, botID: 9)

        XCTAssertEqual(match?.absoluteString, "https://voice.example.test/call?ticket=once")
    }

    func testOfflineAndReconnectingStatesAreShownButAWorkingConnectionIsNot() {
        XCTAssertEqual(TelegramModelMapper.connectionStatus(.connectionStateWaitingForNetwork), "Waiting for network…")
        XCTAssertEqual(TelegramModelMapper.connectionStatus(.connectionStateConnecting), "Connecting…")
        XCTAssertEqual(TelegramModelMapper.connectionStatus(.connectionStateUpdating), "Updating…")
        XCTAssertNil(TelegramModelMapper.connectionStatus(.connectionStateReady))
    }

    func testNetworkPathIsReportedToTelegramAsItsInterfaceType() {
        XCTAssertEqual(TelegramModelMapper.networkType(satisfied: false, wifi: true, cellular: false), .networkTypeNone)
        XCTAssertEqual(TelegramModelMapper.networkType(satisfied: true, wifi: true, cellular: true), .networkTypeWiFi)
        XCTAssertEqual(TelegramModelMapper.networkType(satisfied: true, wifi: false, cellular: true), .networkTypeMobile)
        XCTAssertEqual(TelegramModelMapper.networkType(satisfied: true, wifi: false, cellular: false), .networkTypeOther)
    }

    func testShortHistoryPageStillOffersEarlierMessages() {
        // TDLib often answers the first history request with only the locally cached last message.
        let pushed = text(id: 30)
        let page = TelegramHistory.merge(page: [pushed], into: [pushed])
        XCTAssertFalse(page.hasMore, "A page with nothing new means the start of the chat was reached.")

        let short = TelegramHistory.merge(page: [text(id: 20), text(id: 30)], into: [pushed])
        XCTAssertEqual(short.messages.map(\.id), [20, 30])
        XCTAssertTrue(short.hasMore)

        XCTAssertFalse(TelegramHistory.merge(page: [], into: short.messages).hasMore)
    }

    private func text(id: Int64) -> TelegramMessage {
        TelegramMessage(id: id, chatID: 4, senderName: "Bot", isOutgoing: false, date: .distantPast, text: "\(id)")
    }

    private func message(id: Int64, chatID: Int64, senderID: Int64, isOutgoing: Bool,
                         title: String, kind: TelegramButtonKind) -> TelegramMessage {
        TelegramMessage(id: id, chatID: chatID, senderID: senderID, senderName: "Bot",
                        isOutgoing: isOutgoing, date: .distantPast, text: "",
                        buttonRows: [[TelegramButton(id: title, title: title, kind: kind)]])
    }
}
