import XCTest
@testable import AlanWorkspace

final class GatewayMarkdownTests: XCTestCase {
    func testParagraphsHeadingsListsAndQuotes() {
        let blocks = GatewayMarkdown.blocks("# Title\nSome **bold** text\nsecond line\n\n- one\n* two\n1. first\n2) second\n> quoted")
        XCTAssertEqual(blocks, [.heading(level: 1, text: "Title"), .paragraph("Some **bold** text\nsecond line"), .listItem(marker: "•", text: "one"),
                                .listItem(marker: "•", text: "two"), .listItem(marker: "1.", text: "first"), .listItem(marker: "2.", text: "second"), .quote("quoted")])
    }

    func testFencedCodeKeepsItsLinesAndLanguage() {
        let blocks = GatewayMarkdown.blocks("Here:\n```swift\nlet a = 1\n\n  print(a)\n```\nDone.")
        XCTAssertEqual(blocks, [.paragraph("Here:"), .code(language: "swift", text: "let a = 1\n\n  print(a)"), .paragraph("Done.")])
    }

    func testAnUnclosedFenceIsCodeToTheEndWhileAReplyStreams() {
        XCTAssertEqual(GatewayMarkdown.blocks("run:\n```\nls -la"), [.paragraph("run:"), .code(language: "", text: "ls -la")])
    }

    func testMarkdownInsideACodeBlockIsLeftAlone() {
        XCTAssertEqual(GatewayMarkdown.blocks("```\n# not a heading\n- not a list\n```"), [.code(language: "", text: "# not a heading\n- not a list")])
    }

    func testAHashWithoutASpaceIsNotAHeading() {
        XCTAssertEqual(GatewayMarkdown.blocks("#hashtag"), [.paragraph("#hashtag")])
    }

    func testInlineStylingAndUnsafeLinks() {
        let styled = GatewayMarkdown.inline("**bold** and `code` and [site](https://example.com) and [bad](javascript:alert(1)) and [call](tel:123)")
        XCTAssertEqual(String(styled.characters), "bold and code and site and bad and call")
        let links = styled.runs.compactMap(\.link).map(\.absoluteString)
        XCTAssertEqual(links, ["https://example.com"])
    }

    func testHistoryAndConversationMapping() {
        let rows = [GatewayHistoryRow(rowId: 1, role: "user", text: "hi", timestamp: 100), GatewayHistoryRow(rowId: 2, role: "tool", text: "x", timestamp: 101),
                    GatewayHistoryRow(rowId: 3, role: "assistant", text: "  ", timestamp: 102), GatewayHistoryRow(rowId: nil, role: "assistant", text: "yo", timestamp: nil)]
        let messages = GatewayHistory.messages(from: rows)
        XCTAssertEqual(messages.map(\.id), ["row-1", "row-index-3"])
        XCTAssertEqual(messages.map(\.role), [.user, .assistant])
        let list = GatewayHistory.conversations(
            active: [.object(["id": .string("rt"), "session_key": .string("b"), "title": .string("Bee")]), .object(["id": .string("rt2"), "session_key": .string("new")])],
            stored: [.object(["id": .string("a"), "title": .string("Ay"), "last_active": .number(200)]), .object(["id": .string("b"), "title": .string("B stored"), "last_active": .number(300)])])
        XCTAssertEqual(list.map(\.id), ["b", "a", "new"])
        XCTAssertEqual(list.first?.title, "B stored")
        XCTAssertEqual(list.last?.title, "New conversation")
    }
}
