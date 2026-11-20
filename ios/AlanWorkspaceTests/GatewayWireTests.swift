import XCTest
@testable import AlanWorkspace

@MainActor final class GatewayWireTests: XCTestCase {
    private func make() -> (GatewayWire, FakeGatewaySocket, FakeGatewayClock) {
        let clock = FakeGatewayClock(), socket = FakeGatewaySocket()
        return (GatewayWire(socket: socket, clock: clock), socket, clock)
    }
    private func frame(_ text: String) -> String { text }

    func testCallsAreCorrelatedByIdAndSentInOrder() async throws {
        let (wire, socket, _) = make()
        let a = wire.begin("one"), b = wire.begin("two", ["x": .number(1)])
        XCTAssertEqual(socket.sent.count, 2)
        XCTAssertTrue(socket.sent[0].contains("\"one\"") && socket.sent[1].contains("\"two\""))
        socket.onText?(#"{"jsonrpc":"2.0","id":"w2","result":{"n":2}}"#)
        socket.onText?(#"{"jsonrpc":"2.0","id":"w1","result":{"n":1}}"#)
        let (ra, rb) = try await (a.value(), b.value())
        XCTAssertEqual(ra["n"]?.int, 1); XCTAssertEqual(rb["n"]?.int, 2)
    }

    func testRemoteErrorIsADefiniteReject() async {
        let (wire, socket, _) = make()
        let call = wire.begin("prompt.submit")
        socket.onText?(#"{"jsonrpc":"2.0","id":"w1","error":{"code":4090,"message":"busy"}}"#)
        do { _ = try await call.value(); XCTFail() }
        catch let e as GatewayError { XCTAssertEqual(e.code, "remote_error"); XCTAssertTrue(e.isDefiniteReject); XCTAssertTrue(e.message.contains("4090")) }
        catch { XCTFail() }
    }

    func testCallTimesOutOnTheClockAndIsInDoubt() async {
        let (wire, _, clock) = make()
        let call = wire.begin("slow", timeout: 30)
        await clock.advance(by: 29)
        await clock.advance(by: 2)
        do { _ = try await call.value(); XCTFail() }
        catch let e as GatewayError { XCTAssertEqual(e.code, "timeout"); XCTAssertFalse(e.isDefiniteReject) }
        catch { XCTFail() }
    }

    func testEventsAndServerRequestsAreSurfacedAndRefused() async {
        let (wire, socket, _) = make()
        var events: [GatewayWire.Event] = [], requests: [GatewayWire.ServerRequest] = []
        wire.onEvent = { events.append($0) }; wire.onServerRequest = { requests.append($0) }
        socket.onText?(#"{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","session_id":"s1","seq":4,"payload":{"text":"hi"}}}"#)
        socket.onText?(#"{"jsonrpc":"2.0","id":"srv-1","method":"approval","params":{"session_id":"s1","command":"ls"}}"#)
        XCTAssertEqual(events.first?.type, "message.delta"); XCTAssertEqual(events.first?.seq, 4); XCTAssertEqual(events.first?.payload["text"]?.string, "hi")
        XCTAssertEqual(requests.first?.method, "approval"); XCTAssertEqual(requests.first?.sessionId, "s1")
        wire.refuseServerRequest(id: requests[0].id, message: "no")
        XCTAssertTrue(socket.sent.last?.contains("\"error\"") == true && socket.sent.last?.contains("srv-1") == true)
    }

    func testAMalformedOrOversizedFrameEndsTheWireAndFailsEveryCall() async {
        let (wire, socket, _) = make()
        var closed: String?
        wire.onClose = { closed = $0 }
        let call = wire.begin("x")
        socket.onText?("not json")
        XCTAssertEqual(closed, "bad_frame"); XCTAssertEqual(wire.state, .closed); XCTAssertTrue(socket.closed)
        do { _ = try await call.value(); XCTFail() } catch let e as GatewayError { XCTAssertEqual(e.code, "bad_frame") } catch { XCTFail() }

        let (wire2, socket2, _) = make()
        var closed2: String?
        wire2.onClose = { closed2 = $0 }
        socket2.onText?(String(repeating: "a", count: GatewayWire.maxFrameBytes + 1))
        XCTAssertEqual(closed2, "oversized_in")
    }

    func testAnOversizedSendIsRefusedBeforeItIsWritten() async {
        let (wire, socket, _) = make()
        let call = wire.begin("prompt.submit", ["text": .string(String(repeating: "a", count: GatewayWire.maxFrameBytes))])
        XCTAssertTrue(socket.sent.isEmpty)
        do { _ = try await call.value(); XCTFail() } catch let e as GatewayError { XCTAssertEqual(e.code, "oversized_out"); XCTAssertTrue(e.isDefiniteReject) } catch { XCTFail() }
    }

    func testTooManyPendingCallsAreRefused() async {
        let (wire, _, _) = make()
        for _ in 0..<GatewayWire.maxPendingCalls { _ = wire.begin("x").quiet() }
        do { _ = try await wire.begin("one-too-many").value(); XCTFail() } catch let e as GatewayError { XCTAssertEqual(e.code, "queue_full") } catch { XCTFail() }
    }

    func testPeerCloseFailsPendingCallsAndReportsOnce() async {
        let (wire, socket, _) = make()
        var closes = 0
        wire.onClose = { _ in closes += 1 }
        let call = wire.begin("x")
        socket.peerClose(1006); socket.peerClose(1006)
        XCTAssertEqual(closes, 1)
        do { _ = try await call.value(); XCTFail() } catch let e as GatewayError { XCTAssertEqual(e.code, "ws_closed") } catch { XCTFail() }
    }
}
