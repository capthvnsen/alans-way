import XCTest
@testable import AlanWorkspace

@MainActor final class GatewayLinkTests: XCTestCase {
    private var server: FakeGatewayServer!
    private var clock: FakeGatewayClock!
    private var link: GatewayLink!
    private var events: [GatewaySessionEvent] = []
    private var gaps: [(String, String)] = []
    private var states: [GatewayLinkState] = []

    override func setUp() async throws {
        clock = FakeGatewayClock()
        server = FakeGatewayServer(clock: clock)
    }
    override func tearDown() async throws { link?.stop() }

    private func makeLink(online: @escaping () -> Bool = { true }) {
        link = .fake(server, online: online)
        link.onEvent = { [unowned self] in events.append($0) }
        link.onGap = { [unowned self] in gaps.append(($0, $1)) }
        link.onState = { [unowned self] in states.append($0) }
    }
    /// The link is down while `body` runs, so what the server emits can only reach it through the replay.
    private func outage(_ body: () -> Void) async {
        server.openError = GatewayError("unreachable", "x")
        server.dropAll(); await settle()
        body()
        server.openError = nil
        link.trigger(.retry); await settle()
    }
    private func text(of id: String) -> String { events.filter { $0.storedId == id && $0.type == "message.delta" }.compactMap { $0.payload["text"]?.string }.joined() }

    // MARK: connect and keep alive

    func testConnectsAndGoesLive() async {
        makeLink(); link.start(); await settle()
        XCTAssertEqual(link.state, .live)
        XCTAssertEqual(states, [.connecting, .syncing, .live])
        XCTAssertEqual(server.openSockets, 1)
    }

    func testPingFiresAfterSilenceAndAnAnsweredPingKeepsTheLink() async {
        makeLink(); link.start(); await settle()
        await clock.advance(by: 8); XCTAssertEqual(server.pings, 0)
        await clock.advance(by: 2); XCTAssertEqual(server.pings, 1)
        XCTAssertEqual(link.state, .live)
        await clock.advance(by: 30)
        XCTAssertEqual(link.state, .live)
        XCTAssertGreaterThan(server.pings, 1)
    }

    func testAnUnansweredPingMarksTheLinkDeadAndReconnects() async {
        makeLink(); link.start(); await settle()
        server.lastSocket?.blackhole = true
        await clock.advance(by: 9.5)           // ping goes out
        XCTAssertEqual(link.state, .live)
        await clock.advance(by: 4)             // no answer: dead at 13 s of silence
        XCTAssertEqual(server.connects, 2, "a dead link is replaced at once")
        XCTAssertEqual(link.state, .live)
        XCTAssertEqual(server.openSockets, 1, "never two sockets at once")
    }

    func testFramesCountAsLifeSoNoPingIsSent() async {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try? await link.open("k1")
        for _ in 0..<5 { await clock.advance(by: 5); server.emit(s, "status.update", ["text": .string("x")]) }
        XCTAssertEqual(server.pings, 0)
    }

    // MARK: backoff

    func testFailedAttemptsBackOffWithACap() async {
        server.openError = GatewayError("unreachable", "no")
        makeLink(); link.start(); await settle()
        for _ in 0..<9 { await clock.advance(by: 16) }
        // random == 1 -> delays 0, 0.5, 1, 2, 4, 8, 15, 15, ...
        XCTAssertEqual(Array(clock.requestedSleeps.prefix(8)), [0, 0.5, 1, 2, 4, 8, 15, 15])
        XCTAssertEqual(link.state, .reconnecting)
    }

    func testAnAttemptThatReachesLiveResetsTheBackoff() async {
        server.openError = GatewayError("unreachable", "no")
        makeLink(); link.start(); await settle()
        await clock.advance(by: 3)
        server.openError = nil
        await clock.advance(by: 20)
        XCTAssertEqual(link.state, .live)
        server.dropAll(); await settle()
        XCTAssertEqual(link.state, .live, "the first drop of a live link reconnects at once")
    }

    func testTheFirstFiveDropsReconnectAtOnceThenTheWaitGrows() async {
        makeLink(); link.start(); await settle()
        for n in 1...5 { server.dropAll(); await settle(); XCTAssertEqual(link.state, .live, "drop \(n)") }
        server.dropAll(); await settle()
        XCTAssertEqual(link.state, .reconnecting, "the sixth drop in two minutes waits")
        await clock.advance(by: 0.6)
        XCTAssertEqual(link.state, .live)
        server.dropAll(); await settle()
        XCTAssertEqual(link.state, .reconnecting)
        await clock.advance(by: 0.9); XCTAssertEqual(link.state, .reconnecting, "the next wait is 1 s")
        await clock.advance(by: 0.2); XCTAssertEqual(link.state, .live)
        XCTAssertEqual(server.openSockets, 1)
    }

    func testOnlyOneAttemptRunsAtATime() async {
        makeLink(); link.start()
        link.trigger(.retry); link.trigger(.online); link.trigger(.focus); link.trigger(.retry)
        await settle()
        XCTAssertEqual(server.connects, 1)
    }

    // MARK: offline, sign-in, refused

    func testOfflineWaitsAndOnlineConnects() async {
        var online = false
        makeLink(online: { online })
        link.start(); await settle()
        XCTAssertEqual(link.state, .offline)
        await clock.advance(by: 3); XCTAssertEqual(server.connects, 0)
        online = true
        link.trigger(.online); await settle()
        XCTAssertEqual(link.state, .live)
    }

    func testBadCredentialsStopRetryingUntilTheCallerSaysSo() async {
        server.openError = GatewayError("session_expired", "x")
        makeLink(); link.start(); await settle()
        XCTAssertEqual(link.state, .signin)
        await clock.advance(by: 60)
        XCTAssertEqual(server.connects, 0)
        XCTAssertEqual(clock.sleeping, 0, "no retry is scheduled")
        server.openError = nil
        link.trigger(.credentials); await settle()
        XCTAssertEqual(link.state, .live)
    }

    func testARefusedAddressIsRefusedForGood() async {
        server.openError = GatewayError("bad_url", "x")
        makeLink(); link.start(); await settle()
        XCTAssertEqual(link.state, .refused)
        await clock.advance(by: 60)
        XCTAssertEqual(server.connects, 0)
        XCTAssertEqual(clock.sleeping, 0)
    }

    // MARK: background and foreground

    func testSuspendClosesTheSocketAndResumeReconnectsAndResumesAReply() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.stream(s, ["a", "b"])
        link.suspend(); await settle()
        XCTAssertEqual(link.state, .suspended); XCTAssertEqual(server.openSockets, 0)
        server.stream(s, ["c"]); server.complete(s, text: "abc")      // happens while the app is in the background
        await clock.advance(by: 10)
        XCTAssertEqual(server.connects, 1, "nothing reconnects while suspended")
        link.resume(); await settle()
        XCTAssertEqual(link.state, .live); XCTAssertEqual(server.openSockets, 1)
        XCTAssertEqual(text(of: "k1"), "abc", "no text lost, none doubled")
        XCTAssertTrue(gaps.isEmpty)
        XCTAssertEqual(events.compactMap(\.seq), Array(1...events.count), "every seq once, in order")
    }

    // MARK: resume

    func testADropMidReplyResumesWithoutLosingOrDoublingText() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.stream(s, ["Hel", "lo "])
        await outage {
            server.emit(s, "message.delta", ["text": .string("wor")])      // emitted while no socket is attached
            server.emit(s, "message.delta", ["text": .string("ld")])
            server.complete(s, text: "Hello world")
        }
        XCTAssertEqual(link.state, .live)
        XCTAssertEqual(server.connects, 2)
        XCTAssertEqual(text(of: "k1"), "Hello world")
        XCTAssertEqual(events.last?.type, "message.complete")
        XCTAssertTrue(gaps.isEmpty)
    }

    func testReplayAndLiveFramesMayOverlapWithoutDuplicates() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.stream(s, ["a"])
        // The resume attaches the new socket, then a live frame lands just before the replay answer, which repeats it.
        var fired = false
        server.beforeSince = { [unowned self] in if !fired { fired = true; server.emit(s, "message.delta", ["text": .string("c")]) } }
        await outage { server.emit(s, "message.delta", ["text": .string("b")]) }
        XCTAssertTrue(fired)
        XCTAssertEqual(text(of: "k1"), "abc")
        XCTAssertEqual(events.compactMap(\.seq), Array(1...events.count))
    }

    func testAReplayWithRepeatsAndOutOfOrderFramesIsAppliedOnce() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.stream(s, ["a"])
        server.mangleReplay = { $0.reversed() + $0 }
        await outage { server.emit(s, "message.delta", ["text": .string("b")]); server.emit(s, "message.delta", ["text": .string("c")]) }
        XCTAssertEqual(text(of: "k1"), "abc")
        XCTAssertEqual(events.compactMap(\.seq), Array(1...events.count))
    }

    func testATruncatedReplayIsAGapNotAHole() async throws {
        server.ringMax = 3
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.emit(s, "message.start")
        await outage { for i in 0..<6 { server.emit(s, "message.delta", ["text": .string("\(i)")]) } }
        XCTAssertEqual(gaps.count, 1); XCTAssertEqual(gaps.first?.0, "k1"); XCTAssertEqual(gaps.first?.1, "truncated")
        XCTAssertEqual(link.state, .live)
    }

    func testAHermesRestartDiscardsTheWatermarkAndIsAGap() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        server.emit(s, "message.start")
        server.restart(); await settle()
        XCTAssertEqual(gaps.map(\.1), ["restarted"])
        XCTAssertEqual(link.state, .live)
        // The conversation binds again from scratch and its first events count from 1.
        events.removeAll()
        let snapshot = try await link.open("k1")
        XCTAssertEqual(snapshot.latestSeq, 0)
        let fresh = server.live.values.first { $0.key == "k1" }!
        server.emit(fresh, "message.delta", ["text": .string("x")])
        XCTAssertEqual(events.first?.seq, 1, "a stale watermark would have swallowed this")
    }

    func testAReapedSessionIsAGap() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        await outage { server.reap(s) }
        XCTAssertEqual(gaps.map(\.1), ["reaped"])
    }

    func testOpenReturnsHistoryAndTheStreamingTextOfAReplyInFlight() async throws {
        makeLink(); link.start(); await settle()
        server.addConversation(key: "k1", title: "one", rows: [("user", "hi"), ("assistant", "hello")])
        let snap = try await link.open("k1")
        XCTAssertEqual(snap.rows.map(\.text), ["hi", "hello"])
        XCTAssertEqual(snap.rows.map(\.role), ["user", "assistant"])
        XCTAssertNotNil(snap.rows.first?.rowId)
    }

    func testSubmitWhileNotLiveFailsBeforeAnythingIsWritten() async {
        server.openError = GatewayError("unreachable", "x")
        makeLink(); link.start(); await settle()
        do { _ = try await link.submit("k1", text: "hi", clientMessageId: "c1"); XCTFail() }
        catch let e as GatewayError { XCTAssertEqual(e.code, "not_live") } catch { XCTFail() }
        XCTAssertTrue(server.submits.isEmpty)
    }

    func testAnApprovalWaitsForAnAnswerAndTheAnswerGoesOnTheWire() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        var got: [(String, String)] = [], closed: [String] = []
        link.onRequest = { id, r in got.append((id, r.method)) }
        link.onRequestClosed = { key, _, _ in closed.append(key) }
        server.request(s, id: "srv-1", method: "approval", params: ["command": .string("rm -rf build")])
        server.request(s, id: "srv-2", method: "approval")
        XCTAssertEqual(got.map(\.1), ["approval", "approval"]); XCTAssertEqual(got.first?.0, "k1")
        XCTAssertTrue(server.requestAnswers.isEmpty, "nothing is answered or refused until the person decides")
        try link.answerRequest("srv-1", result: .object(["choice": .string("once")]))
        XCTAssertEqual(server.requestAnswers.map(\.id), ["srv-1"]); XCTAssertEqual(server.requestAnswers.first?.result?["choice"]?.string, "once")
        do { try link.answerRequest("srv-1", result: .object([:])); XCTFail("one answer per request") }
        catch let e as GatewayError { XCTAssertEqual(e.code, "request_closed") }
        // Hermes withdraws the other one; a drop ends whatever is still open.
        server.emit(s, "request.cancel", ["id": .string("srv-2")])
        XCTAssertEqual(closed, ["srv-2"])
    }

    func testRequestsStillOpenWhenTheConnectionDropsAreReportedClosed() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        var closed: [(String, Bool)] = []
        link.onRequestClosed = { key, _, dropped in closed.append((key, dropped)) }
        server.request(s, id: "srv-3", method: "clarify")
        server.dropAll(); await settle()
        XCTAssertEqual(closed.map(\.0), ["srv-3"]); XCTAssertEqual(closed.map(\.1), [true])
    }

    func testServerRequestsAreRefusedOnTheWireAndReported() async throws {
        makeLink(); link.start(); await settle()
        let s = server.addConversation(key: "k1", title: "one")
        _ = try await link.open("k1")
        var refused: [String] = []
        link.onRefusedRequest = { _, method in refused.append(method) }
        server.lastSocket?.deliver(.object(["jsonrpc": .string("2.0"), "id": .string("srv-9"), "method": .string("sudo"), "params": .object(["session_id": .string(s.id)])]))
        XCTAssertEqual(refused, ["sudo"])
        XCTAssertTrue(server.lastSocket?.sent.last?.contains("srv-9") == true && server.lastSocket?.sent.last?.contains("-32601") == true)
    }
}
