import XCTest
@testable import AlanWorkspace

@MainActor final class GatewayStoreTests: XCTestCase {
    private var clock: FakeGatewayClock!
    private var server: FakeGatewayServer!
    private var credentials: MemoryGatewaySessionStore!
    private var outboxURL: URL!
    private var store: GatewayStore!

    override func setUp() async throws {
        clock = FakeGatewayClock(); server = FakeGatewayServer(clock: clock)
        credentials = MemoryGatewaySessionStore(GatewaySession(address: "https://vm.tail1234.ts.net", accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999, provider: "basic", userId: "u"))
        outboxURL = FileManager.default.temporaryDirectory.appendingPathComponent("store-\(UUID().uuidString)/outbox.json")
        store = makeStore()
    }
    override func tearDown() async throws { store.signOut(keepUnsent: false); try? FileManager.default.removeItem(at: outboxURL.deletingLastPathComponent()) }

    private func makeStore() -> GatewayStore {
        GatewayStore(sessionStore: credentials, outboxURL: outboxURL, clock: clock, monitorNetwork: false, makeLink: { [unowned self] _ in .fake(self.server) })
    }
    private func texts(_ id: String) -> [String] { store.messages(for: id).map(\.text) }

    func testOpeningAConversationShowsItsHistoryAndOnlyWhatAPersonSaid() async {
        let s = server.addConversation(key: "k1", title: "Alpha", rows: [("user", "hi"), ("tool", "ls output"), ("assistant", "hello"), ("assistant", "")])
        _ = s
        store.start(); await settle()
        store.open("k1"); await settle()
        XCTAssertEqual(texts("k1"), ["hi", "hello"])
        XCTAssertEqual(store.messages(for: "k1").map(\.role), [.user, .assistant])
        XCTAssertEqual(store.conversations.map(\.title), ["Alpha"])
    }

    func testApprovingACommandAnswersHermesAndClearsTheCard() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.request(s, id: "srv-1", method: "approval", params: ["command": .string("ls -la"), "description": .string("List files"), "choices": .array([.string("once"), .string("deny"), .string("bogus")])])
        await settle()
        let prompt = try XCTUnwrap(store.thread("k1").prompts.first)
        XCTAssertEqual(prompt.kind, .approval(command: "ls -la", description: "List files", choices: ["once", "deny"]))
        store.answer("srv-1", in: "k1", with: "always")          // not offered: nothing is sent
        XCTAssertTrue(server.requestAnswers.isEmpty); XCTAssertEqual(store.thread("k1").prompts.count, 1)
        store.answer("srv-1", in: "k1", with: "deny")
        XCTAssertEqual(server.requestAnswers.first?.result?["choice"]?.string, "deny")
        XCTAssertTrue(store.thread("k1").prompts.isEmpty)
    }

    func testAClarifyAnswerIsKeyedByTheQuestionIdAndAWithdrawnOneDisappears() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.request(s, id: "srv-7", method: "clarify", params: ["questions": .array([.object(["qid": .string("q1"), "question": .string("Which branch?"), "choices": .array([.string("main")])])])])
        server.request(s, id: "srv-8", method: "clarify", params: ["question": .string("Sure?")])
        await settle()
        XCTAssertEqual(store.thread("k1").prompts.map(\.kind), [.clarify(question: "Which branch?", choices: ["main"]), .clarify(question: "Sure?", choices: [])])
        store.answer("srv-7", in: "k1", with: "   ")             // empty answers are not sent
        XCTAssertTrue(server.requestAnswers.isEmpty)
        store.answer("srv-7", in: "k1", with: " release ")
        XCTAssertEqual(server.requestAnswers.first?.result?["answers"]?["q1"]?.string, "release")
        server.emit(s, "request.cancel", ["id": .string("srv-8")]); await settle()
        XCTAssertTrue(store.thread("k1").prompts.isEmpty)
    }

    func testAPromptEndsWithTheReplyAndADropSaysWhy() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.request(s, id: "srv-1", method: "approval"); await settle()
        server.complete(s, text: "done"); await settle()
        XCTAssertTrue(store.thread("k1").prompts.isEmpty)
        server.request(s, id: "srv-2", method: "approval"); await settle()
        XCTAssertEqual(store.thread("k1").prompts.count, 1)
        server.dropAll(); await settle()
        XCTAssertTrue(store.thread("k1").prompts.isEmpty)
        XCTAssertEqual(store.thread("k1").notice, "The connection dropped while Alan waited for your answer. Send a message to continue.")
    }

    func testAWholeReplyArrivesAsOneMessageComplete() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        try store.send("hello there", to: "k1"); await settle()
        XCTAssertEqual(server.submits.map(\.text), ["hello there"])
        XCTAssertEqual(texts("k1"), ["hello there"])
        XCTAssertTrue(store.thread("k1").busy)
        server.complete(s, text: "Hi! Here is **bold** and `code`."); await settle()
        XCTAssertEqual(texts("k1"), ["hello there", "Hi! Here is **bold** and `code`."])
        XCTAssertFalse(store.thread("k1").busy)
        XCTAssertFalse(store.messages(for: "k1").contains { $0.isStreaming })
    }

    func testAStreamedReplyGrowsThenEndsWithTheFinalText() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        try store.send("go", to: "k1"); await settle()
        server.stream(s, ["Hel", "lo"]); await settle()
        XCTAssertEqual(store.messages(for: "k1").last?.text, "Hello")
        XCTAssertEqual(store.messages(for: "k1").last?.isStreaming, true)
        server.emit(s, "message.delta", ["text": .string(" world")]); await settle()
        server.complete(s, text: "Hello world"); await settle()
        XCTAssertEqual(texts("k1"), ["go", "Hello world"])
        XCTAssertEqual(store.messages(for: "k1").last?.isStreaming, false)
    }

    func testACompleteWithoutTextKeepsWhatStreamed() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.stream(s, ["only ", "deltas"]); server.emit(s, "message.complete", ["status": .string("complete")]); await settle()
        XCTAssertEqual(texts("k1"), ["only deltas"])
    }

    func testAReplyThatBeatsTheSendResultStillLandsAfterTheMessageItAnswers() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        server.onSubmit = { [unowned self] live in server.stream(live, ["quick"]); server.complete(live, text: "quick") }
        store.start(); await settle(); store.open("k1"); await settle()
        try store.send("question", to: "k1"); await settle()
        XCTAssertEqual(texts("k1"), ["question", "quick"])
        _ = s
    }

    func testAMessageSentWhileOfflineWaitsThenGoesOnceAndInOrder() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        store.open("k1"); await settle()
        try store.send("first", to: "k1"); try store.send("second", to: "k1"); try store.send("third", to: "k1")
        await settle()
        XCTAssertEqual(store.messages(for: "k1").map(\.delivery), [.queued, .queued, .queued])
        XCTAssertTrue(server.submits.isEmpty)
        XCTAssertEqual(store.banner, "3 waiting to send.")
        server.openError = nil
        await clock.advance(by: 20)
        XCTAssertEqual(store.linkState, .live)
        // One at a time: the next waits for the reply to the one before.
        XCTAssertEqual(server.submits.map(\.text), ["first"])
        for expected in [["first", "second"], ["first", "second", "third"]] {
            let live = server.live.values.first { $0.key == "k1" }!
            server.complete(live, text: "ok"); await settle()
            XCTAssertEqual(server.submits.map(\.text), expected)
        }
        XCTAssertEqual(Set(server.submits.map(\.clientMessageId)).count, 3, "each carries its own client message id")
        XCTAssertFalse(server.submits.contains { $0.clientMessageId.isEmpty })
        XCTAssertTrue(store.outbox.items.isEmpty)
    }

    func testAWaitingMessageCanBeCancelled() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        try store.send("never mind", to: "k1")
        let id = store.messages(for: "k1")[0].id
        store.cancel(id); await settle()
        XCTAssertTrue(store.messages(for: "k1").isEmpty)
        XCTAssertTrue(store.outbox.items.isEmpty)
    }

    func testAMessageThatWaitsThirtyMinutesBecomesNotSentAndCanBeRetriedOrDeleted() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        try store.send("too late", to: "k1")
        await clock.advance(by: 29 * 60)
        XCTAssertEqual(store.messages(for: "k1")[0].delivery, .queued)
        await clock.advance(by: 2 * 60)
        XCTAssertEqual(store.messages(for: "k1")[0].delivery, .failed)
        server.openError = nil
        await clock.advance(by: 30)
        XCTAssertTrue(server.submits.isEmpty, "an expired message is never sent on its own")
        let id = store.messages(for: "k1")[0].id
        store.retry(id); await settle()
        XCTAssertEqual(server.submits.map(\.text), ["too late"])
        // Delete path
    }

    func testANotSentMessageCanBeDeleted() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        try store.send("expires", to: "k1")
        await clock.advance(by: 31 * 60)
        let id = store.messages(for: "k1")[0].id
        XCTAssertEqual(store.messages(for: "k1")[0].delivery, .failed)
        store.cancel(id)
        XCTAssertTrue(store.messages(for: "k1").isEmpty)
        XCTAssertTrue(store.outbox.items.isEmpty)
    }

    func testTheQueueSurvivesARestartAndGoesExactlyOnce() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        try store.send("persist me", to: "k1")
        store.signOut(keepUnsent: true)
        credentials = MemoryGatewaySessionStore(GatewaySession(address: "https://vm.tail1234.ts.net", accessToken: "at", refreshToken: "rt", expiresAt: 9_999_999_999, provider: "basic", userId: "u"))
        server.openError = nil
        store = makeStore()
        XCTAssertEqual(store.outbox.items.map(\.text), ["persist me"])
        store.start(); await settle()
        XCTAssertEqual(server.submits.map(\.text), ["persist me"])
        let live = server.live.values.first { $0.key == "k1" }!
        server.complete(live, text: "ok"); await clock.advance(by: 10)
        XCTAssertEqual(server.submits.count, 1)
    }

    // MARK: doubt

    func testASendInDoubtThatDidArriveIsNotSentAgain() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.swallowSubmits = true      // Hermes got it; the answer never came back
        try store.send("did it arrive", to: "k1"); await settle()
        XCTAssertEqual(server.submits.count, 1)
        await clock.advance(by: 31)       // the call times out: in doubt
        server.swallowSubmits = false
        await clock.advance(by: 10)
        XCTAssertEqual(server.submits.count, 1, "the history showed it; no second submit")
        XCTAssertTrue(store.outbox.items.isEmpty)
        XCTAssertEqual(texts("k1"), ["did it arrive"])
    }

    func testASendInDoubtThatNeverArrivedIsSentOnce() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.dropSubmits = true         // the write was lost on the way
        try store.send("lost on the way", to: "k1"); await settle()
        await clock.advance(by: 31)
        XCTAssertTrue(server.submits.isEmpty)
        server.dropSubmits = false
        await clock.advance(by: 10)
        XCTAssertEqual(server.submits.map(\.text), ["lost on the way"])
        XCTAssertTrue(store.outbox.items.isEmpty)
    }

    func testABusyRefusalIsAWaitNotAFailure() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        s.busy = true     // another device's turn is running
        try store.send("wait your turn", to: "k1"); await settle()
        XCTAssertEqual(store.messages(for: "k1")[0].delivery, .queued)
        XCTAssertTrue(server.submits.isEmpty)
        s.busy = false
        await clock.advance(by: 4)
        XCTAssertEqual(server.submits.map(\.text), ["wait your turn"])
    }

    func testADefiniteRejectIsNotSent() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        server.failSubmit = "session is gone"
        try store.send("refused", to: "k1"); await settle()
        XCTAssertEqual(store.messages(for: "k1")[0].delivery, .failed)
        XCTAssertEqual(store.thread("k1").notice, "That message was not sent.")
    }

    // MARK: reconnect and gap

    func testADropMidReplyKeepsTheReplyWhole() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        try store.send("go", to: "k1"); await settle()
        server.stream(s, ["one ", "two "]); await settle()
        server.openError = GatewayError("unreachable", "x")
        server.dropAll(); await settle()
        server.emit(s, "message.delta", ["text": .string("three ")])
        server.complete(s, text: "one two three ")
        server.openError = nil
        await clock.advance(by: 20)
        XCTAssertEqual(store.linkState, .live)
        XCTAssertEqual(texts("k1"), ["go", "one two three "])
    }

    func testAHermesRestartReloadsTheHistory() async throws {
        let s = server.addConversation(key: "k1", title: "Alpha", rows: [("user", "earlier"), ("assistant", "yes")])
        store.start(); await settle(); store.open("k1"); await settle()
        server.emit(s, "message.start")
        server.restart(); await settle()
        XCTAssertEqual(store.linkState, .live)
        XCTAssertEqual(texts("k1"), ["earlier", "yes"], "the half-streamed reply is gone; history is the truth")
        XCTAssertFalse(store.thread("k1").busy)
    }

    func testTheReconnectingBannerWaitsThreeSeconds() async {
        server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle()
        server.openError = GatewayError("unreachable", "x")
        server.dropAll(); await settle()
        XCTAssertNil(store.banner)
        await clock.advance(by: 2.5); XCTAssertNil(store.banner)
        await clock.advance(by: 1); XCTAssertEqual(store.banner, "Reconnecting…")
    }

    func testStopAsksTheGatewayToInterrupt() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        store.start(); await settle(); store.open("k1"); await settle()
        store.stopReply("k1"); await settle()
        XCTAssertTrue(server.sockets.last?.sent.contains { $0.contains("session.interrupt") } == true)
    }

    func testANewConversationIsBoundAndListed() async throws {
        store.start(); await settle()
        let id = try await store.newConversation()
        XCTAssertTrue(store.conversations.contains { $0.id == id })
        try store.send("first words", to: id); await settle()
        XCTAssertEqual(server.submits.map(\.text), ["first words"])
    }

    // MARK: sign-out

    func testSignOutClearsTheCredentialAndEverythingFetchedWithIt() async throws {
        server.addConversation(key: "k1", title: "Alpha", rows: [("user", "secret"), ("assistant", "reply")])
        store.start(); await settle(); store.open("k1"); await settle()
        server.openError = GatewayError("unreachable", "x")
        server.dropAll(); await settle()
        try store.send("unsent", to: "k1")
        store.signOut(keepUnsent: false)
        XCTAssertNil(credentials.load()); XCTAssertFalse(store.isConfigured)
        XCTAssertTrue(store.conversations.isEmpty); XCTAssertTrue(store.threads.isEmpty); XCTAssertTrue(store.outbox.items.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outboxURL.path))
    }

    func testSignOutCanKeepUnsentMessages() async throws {
        server.addConversation(key: "k1", title: "Alpha")
        server.openError = GatewayError("unreachable", "x")
        store.start(); await settle()
        try store.send("keep me", to: "k1")
        store.signOut(keepUnsent: true)
        XCTAssertNil(credentials.load())
        XCTAssertEqual(GatewayOutbox(fileURL: outboxURL).items.map(\.text), ["keep me"])
    }
}
