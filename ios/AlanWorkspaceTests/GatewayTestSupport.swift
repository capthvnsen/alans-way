import Foundation
@testable import AlanWorkspace

/// Time the test moves by hand. `advance` wakes every sleeper whose deadline has passed, oldest first.
@MainActor final class FakeGatewayClock: GatewayClock {
    private(set) var now: Date
    private(set) var requestedSleeps: [TimeInterval] = []
    private var sleepers: [(id: Int, deadline: Date, continuation: CheckedContinuation<Void, Error>)] = []
    private var nextID = 0
    init(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) { self.now = now }

    func sleep(for seconds: TimeInterval) async throws {
        requestedSleeps.append(seconds)
        if seconds <= 0 { await Task.yield(); return }
        nextID += 1
        let id = nextID
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                sleepers.append((id, now.addingTimeInterval(seconds), c))
            }
        } onCancel: {
            Task { @MainActor in
                if let i = self.sleepers.firstIndex(where: { $0.id == id }) { self.sleepers.remove(at: i).continuation.resume(throwing: CancellationError()) }
            }
        }
    }

    func advance(by seconds: TimeInterval) async {
        let target = now.addingTimeInterval(seconds)
        await settle()
        while let next = sleepers.filter({ $0.deadline <= target }).min(by: { $0.deadline < $1.deadline }) {
            now = max(now, next.deadline)
            sleepers.removeAll { $0.id == next.id }
            next.continuation.resume()
            await settle()
        }
        now = target
        await settle()
    }
    var sleeping: Int { sleepers.count }
}

/// Lets queued tasks run. Everything under test lives on the main actor, so yielding is enough.
@MainActor func settle(_ rounds: Int = 60) async { for _ in 0..<rounds { await Task.yield() } }

@MainActor final class FakeGatewaySocket: GatewaySocket {
    var onText: ((String) -> Void)?
    var onClose: ((Int?) -> Void)?
    var sent: [String] = []
    var server: ((String) -> Void)?
    var closed = false
    /// A half-open link: what we send goes nowhere and nothing comes back.
    var blackhole = false
    func startReceiving() {}
    func send(_ text: String) { sent.append(text); if !blackhole { server?(text) } }
    func close() { closed = true }
    func deliver(_ frame: JSONValue) { guard !blackhole, !closed, let text = frame.serialized() else { return }; onText?(text) }
    func peerClose(_ code: Int = 1006) { onClose?(code) }
}

/// An in-memory Hermes gateway: the Swift twin of `desktop/test/hermes-gateway-engine.cjs`. Per-session monotonic
/// `seq` in a bounded ring, a per-process epoch, `gateway.ping`, an orphan reap, and NO dedupe on `prompt.submit`.
@MainActor final class FakeGatewayServer {
    struct Row { var id: Int; var role: String; var text: String; var timestamp: TimeInterval }
    final class Live {
        let id: String, key: String
        var seq = 0
        var ring: [(seq: Int, type: String, payload: JSONValue)] = []
        var sockets: [FakeGatewaySocket] = []
        var busy = false
        init(id: String, key: String) { self.id = id; self.key = key }
    }
    struct Submit: Equatable { let sessionId: String; let text: String; let clientMessageId: String }

    let clock: FakeGatewayClock
    var epoch = "epoch-1"
    var ringMax = 512
    var live: [String: Live] = [:]
    var titles: [String: String] = [:]
    var history: [String: [Row]] = [:]
    var submits: [Submit] = []
    var pings = 0
    var sockets: [FakeGatewaySocket] = []
    var openError: GatewayError?
    var swallowSubmits = false     // the write reaches the server but the answer never comes back
    var dropSubmits = false         // the write never reaches the server
    var beforeSince: (() -> Void)?
    var onSubmit: ((Live) -> Void)?   // runs before prompt.submit is answered, as a fast reply would
    var mangleReplay: (([JSONValue]) -> [JSONValue])?
    var failSubmit: String?         // answer prompt.submit with this JSON-RPC error message
    private var rowSeq = 0, runtimeSeq = 0
    private(set) var connects = 0

    init(clock: FakeGatewayClock) { self.clock = clock }

    @discardableResult
    func addConversation(key: String, title: String, rows: [(String, String)] = []) -> Live {
        titles[key] = title
        history[key] = rows.map { Row(id: nextRow(), role: $0.0, text: $0.1, timestamp: clock.now.timeIntervalSince1970 - 100) }
        return runtime(for: key)
    }
    private func nextRow() -> Int { rowSeq += 1; return rowSeq }
    private func runtime(for key: String) -> Live {
        if let s = live.values.first(where: { $0.key == key }) { return s }
        runtimeSeq += 1
        let s = Live(id: "rt-\(runtimeSeq)", key: key); live[s.id] = s
        return s
    }

    func connect() throws -> GatewayConnection {
        if let openError { throw openError }
        connects += 1
        let socket = FakeGatewaySocket()
        socket.server = { [unowned self, unowned socket] text in self.receive(text, from: socket) }
        sockets.append(socket)
        let wire = GatewayWire(socket: socket, clock: clock)
        return GatewayConnection(wire: wire, epoch: epoch)
    }
    var lastSocket: FakeGatewaySocket? { sockets.last }
    var openSockets: Int { sockets.filter { !$0.closed }.count }

    // MARK: events

    func emit(_ s: Live, _ type: String, _ payload: [String: JSONValue] = [:]) {
        s.seq += 1
        s.ring.append((s.seq, type, .object(payload)))
        while s.ring.count > ringMax { s.ring.removeFirst() }
        let frame: JSONValue = .object(["jsonrpc": .string("2.0"), "method": .string("event"), "params": .object([
            "type": .string(type), "session_id": .string(s.id), "seq": .number(Double(s.seq)), "payload": .object(payload)])])
        for peer in s.sockets { peer.deliver(frame) }
    }
    func stream(_ s: Live, _ pieces: [String]) {
        emit(s, "message.start"); for p in pieces { emit(s, "message.delta", ["text": .string(p)]) }
    }
    func complete(_ s: Live, text: String) {
        history[s.key, default: []].append(Row(id: nextRow(), role: "assistant", text: text, timestamp: clock.now.timeIntervalSince1970))
        s.busy = false
        emit(s, "message.complete", ["text": .string(text), "status": .string("complete")])
    }
    /// A Hermes restart: new epoch, every runtime session and seq gone, stored history kept.
    func restart() { epoch = "epoch-\(Int.random(in: 1000...9999))"; live = [:]; for s in sockets { s.peerClose() } }
    func reap(_ s: Live) { live[s.id] = nil }
    func dropAll() { for s in sockets where !s.closed { s.peerClose() } }

    // MARK: rpc

    private func receive(_ text: String, from socket: FakeGatewaySocket) {
        guard let frame = JSONValue.parse(text), let method = frame["method"]?.string, let id = frame["id"] else { return }
        let params = frame["params"] ?? .object([:])
        let answer: (JSONValue?, String?) -> Void = { result, error in
            var f: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": id]
            if let error { f["error"] = .object(["code": .number(error.contains("4090") ? 4090 : -32000), "message": .string(error)]) } else { f["result"] = result ?? .null }
            socket.deliver(.object(f))
        }
        func rowJSON(_ r: Row) -> JSONValue { .object(["role": .string(r.role), "text": .string(r.text), "row_id": .number(Double(r.id)), "timestamp": .number(r.timestamp)]) }
        switch method {
        case "gateway.ping": pings += 1; answer(.object(["ok": .bool(true)]), nil)
        case "gateway.capabilities": answer(.object(["per_session_exclusive_submit": .bool(true)]), nil)
        case "client.capabilities": answer(.object(["server_requests": .array([.string("tool.approval")])]), nil)
        case "session.active_list":
            answer(.object(["sessions": .array(live.values.sorted { $0.id < $1.id }.map { .object(["id": .string($0.id), "session_key": .string($0.key), "title": .string(titles[$0.key] ?? $0.key)]) })]), nil)
        case "session.list":
            answer(.object(["sessions": .array(history.keys.sorted().map { .object(["id": .string($0), "title": .string(titles[$0] ?? $0)]) })]), nil)
        case "session.create":
            let key = "key-new-\(runtimeSeq + 1)"; titles[key] = key; history[key] = []
            answer(.object(["session_id": .string(runtime(for: key).id)]), nil)
        case "session.resume":
            let key = params["session_id"]?.string ?? ""
            guard history[key] != nil else { answer(nil, "unknown session"); return }
            let s = runtime(for: key)
            answer(.object(["session_id": .string(s.id), "session_key": .string(s.key), "resumed": .bool(true)]), nil)
        case "session.activate":
            guard let s = live[params["session_id"]?.string ?? ""] else { answer(nil, "unknown session"); return }
            if !s.sockets.contains(where: { $0 === socket }) { s.sockets.append(socket) }
            let rows = params["omit_messages"]?.bool == true ? [] : (history[s.key] ?? []).map(rowJSON)
            answer(.object(["session_id": .string(s.id), "session_key": .string(s.key), "messages": .array(rows), "open_requests": .array([]), "inflight": .null]), nil)
        case "session.events.since":
            guard let s = live[params["session_id"]?.string ?? ""] else { answer(nil, "unknown session"); return }
            beforeSince?()
            let last = params["last_seen"]?.int ?? 0
            let first = s.ring.first?.seq ?? s.seq + 1
            let events = s.ring.filter { $0.seq > last }.map { JSONValue.object(["type": .string($0.type), "session_id": .string(s.id), "seq": .number(Double($0.seq)), "payload": $0.payload]) }
            answer(.object(["epoch": .string(epoch), "events": .array(mangleReplay?(events) ?? events), "open_requests": .array([]), "latest_seq": .number(Double(s.seq)),
                            "truncated": .bool(last < first - 1), "count": .number(Double(events.count))]), nil)
        case "prompt.submit":
            if dropSubmits { return }
            guard let s = live[params["session_id"]?.string ?? ""] else { answer(nil, "unknown session"); return }
            if let failSubmit { answer(nil, failSubmit); return }
            if s.busy { answer(nil, "Nothing was sent: 4090 a reply is still running"); return }
            let text = params["text"]?.string ?? ""
            submits.append(Submit(sessionId: s.id, text: text, clientMessageId: params["client_message_id"]?.string ?? ""))
            let row = Row(id: nextRow(), role: "user", text: text, timestamp: clock.now.timeIntervalSince1970)
            history[s.key, default: []].append(row)
            s.busy = true
            onSubmit?(s)
            if !swallowSubmits { answer(.object(["status": .string("streaming"), "user_row_id": .number(Double(row.id))]), nil) }
        case "session.interrupt": answer(.object(["status": .string("ok"), "interrupted": .bool(true)]), nil)
        default: answer(nil, "unknown method \(method)")
        }
    }
}

extension GatewayLink {
    /// A link wired to the fake server and the fake clock.
    static func fake(_ server: FakeGatewayServer, online: @escaping () -> Bool = { true }, random: @escaping () -> Double = { 1 },
                     options: Options = Options()) -> GatewayLink {
        GatewayLink(open: { _ in try server.connect() }, clock: server.clock, isOnline: online, random: random, options: options)
    }
}
