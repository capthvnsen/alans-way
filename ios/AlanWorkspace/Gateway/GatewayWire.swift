import Foundation

/// A failure with a stable code, the same codes the desktop's `RemoteError`/`WireError` use, so a link rule can switch on them.
struct GatewayError: Error, LocalizedError, Equatable {
    let code: String
    let message: String
    init(_ code: String, _ message: String = "") { self.code = code; self.message = message.isEmpty ? code : message }
    var errorDescription: String? { message }
    /// `prompt.submit` outcomes that prove the text was NOT admitted (`DEFINITE_REJECT` in hermes-conversation.cjs).
    var isDefiniteReject: Bool { ["remote_error", "oversized_out", "queue_full", "bad_params"].contains(code) }
}

@MainActor protocol GatewayClock: AnyObject {
    var now: Date { get }
    func sleep(for seconds: TimeInterval) async throws
}

@MainActor final class SystemGatewayClock: GatewayClock {
    var now: Date { Date() }
    func sleep(for seconds: TimeInterval) async throws {
        try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }
}

/// One text frame in, one out. The real one wraps `URLSessionWebSocketTask`; tests use a fake.
@MainActor protocol GatewaySocket: AnyObject {
    var onText: ((String) -> Void)? { get set }
    /// Called once when the socket ends, with the close code if there was one.
    var onClose: ((Int?) -> Void)? { get set }
    func startReceiving()
    func send(_ text: String)
    func close()
}

/// JSON-RPC 2.0 over one socket, the Swift twin of `hermes-session-wire.cjs`: framing, call correlation, server
/// requests, and the same limits. It never retries, replays or reconnects; the link above it decides that.
@MainActor final class GatewayWire {
    struct Event { let type: String; let sessionId: String?; let seq: Int?; let payload: JSONValue }
    struct ServerRequest { let id: JSONValue; let method: String; let sessionId: String?; let params: JSONValue }
    enum State { case open, closed }

    static let maxFrameBytes = 1024 * 1024
    static let maxPendingCalls = 128

    var onEvent: ((Event) -> Void)?
    var onServerRequest: ((ServerRequest) -> Void)?
    var onServerRequestWithdrawn: ((JSONValue) -> Void)?
    /// Any inbound frame: proof the link is alive.
    var onFrame: (() -> Void)?
    var onClose: ((String) -> Void)?
    private(set) var state: State = .open

    private let socket: GatewaySocket
    private let clock: GatewayClock
    private let callTimeout: TimeInterval
    private var nextID = 0
    private var pending: [String: WireCall] = [:]

    init(socket: GatewaySocket, clock: GatewayClock, callTimeout: TimeInterval = 30) {
        self.socket = socket; self.clock = clock; self.callTimeout = callTimeout
        socket.onText = { [weak self] text in self?.receive(text) }
        socket.onClose = { [weak self] code in self?.fail(code: "ws_closed", message: "The connection closed\(code.map { " (\($0))" } ?? "").") }
    }

    func start() { socket.startReceiving() }

    /// Sends now, in call order, and returns the call to wait on, so two calls started back to back reach the server in that order.
    func begin(_ method: String, _ params: [String: JSONValue] = [:], timeout: TimeInterval? = nil) -> WireCall {
        let call = WireCall()
        guard state == .open else { call.settle(.failure(GatewayError("closed", "The connection is closed."))); return call }
        guard pending.count < Self.maxPendingCalls else { call.settle(.failure(GatewayError("queue_full", "Too many requests are waiting."))); return call }
        nextID += 1
        let id = "w\(nextID)"
        let frame: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .string(id), "method": .string(method), "params": .object(params)]
        guard let text = JSONValue.object(frame).serialized(), text.utf8.count <= Self.maxFrameBytes else {
            call.settle(.failure(GatewayError("oversized_out", "That message is too large to send.")))
            return call
        }
        pending[id] = call
        call.timer = Task { [weak self, clock] in
            do { try await clock.sleep(for: timeout ?? self?.callTimeout ?? 30) } catch { return }
            self?.settle(id, .failure(GatewayError("timeout", "\(method) timed out.")))
        }
        socket.send(text)
        return call
    }

    func call(_ method: String, _ params: [String: JSONValue] = [:], timeout: TimeInterval? = nil) async throws -> JSONValue {
        try await begin(method, params, timeout: timeout).value()
    }

    func answerServerRequest(id: JSONValue, result: JSONValue) { reply(["jsonrpc": .string("2.0"), "id": id, "result": result]) }
    func refuseServerRequest(id: JSONValue, code: Int = -32601, message: String) {
        reply(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(Double(code)), "message": .string(message)])])
    }
    private func reply(_ frame: [String: JSONValue]) {
        guard state == .open, let text = JSONValue.object(frame).serialized() else { return }
        socket.send(text)
    }

    /// Ends the wire and the socket. Every pending call fails, so nothing waits on a dead link.
    func dispose() {
        guard state == .open else { return }
        state = .closed
        socket.onText = nil; socket.onClose = nil
        socket.close()
        failAll(GatewayError("closed", "The connection closed."))
    }

    private func fail(code: String, message: String) {
        guard state == .open else { return }
        state = .closed
        socket.onText = nil; socket.onClose = nil
        socket.close()
        failAll(GatewayError(code, message))
        onClose?(code)
    }
    private func failAll(_ error: GatewayError) {
        let calls = pending; pending = [:]
        for call in calls.values { call.settle(.failure(error)) }
    }
    private func settle(_ id: String, _ result: Result<JSONValue, Error>) {
        guard let call = pending.removeValue(forKey: id) else { return }
        call.settle(result)
    }

    private func receive(_ text: String) {
        guard state == .open else { return }
        guard text.utf8.count <= Self.maxFrameBytes else { fail(code: "oversized_in", message: "A message from the gateway was too large."); return }
        onFrame?()
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard state == .open else { return }
            guard let frame = JSONValue.parse(String(line)), frame.object != nil, frame["jsonrpc"]?.string == "2.0" else {
                fail(code: "bad_frame", message: "The gateway sent something this app cannot read."); return
            }
            handle(frame)
        }
    }

    private func handle(_ frame: JSONValue) {
        let method = frame["method"]?.string
        let id = frame["id"]
        if let method, let id, id != .null {
            let params = frame["params"] ?? .object([:])
            onServerRequest?(ServerRequest(id: id, method: method, sessionId: params["session_id"]?.string, params: params))
        } else if let method {
            guard method == "event", let params = frame["params"], params.object != nil, let type = params["type"]?.string else { return }
            let payload = params["payload"] ?? .null
            if type == "request.cancel", let cancelled = payload["id"] { onServerRequestWithdrawn?(cancelled) }
            onEvent?(Event(type: type, sessionId: params["session_id"]?.string, seq: params["seq"]?.int, payload: payload))
        } else if let id = id?.string {
            if let error = frame["error"] {
                let code = error["code"]?.int.map(String.init) ?? "?"
                settle(id, .failure(GatewayError("remote_error", "remote error \(code): \(error["message"]?.string ?? "")")))
            } else {
                settle(id, .success(frame["result"] ?? .null))
            }
        }
    }
}

/// A started call. `value()` waits for the answer; it can be read once or many times.
@MainActor final class WireCall {
    fileprivate var timer: Task<Void, Never>?
    private var result: Result<JSONValue, Error>?
    private var waiters: [CheckedContinuation<JSONValue, Error>] = []

    fileprivate func settle(_ r: Result<JSONValue, Error>) {
        guard result == nil else { return }
        result = r; timer?.cancel(); timer = nil
        let w = waiters; waiters = []
        for c in w { c.resume(with: r) }
    }
    func value() async throws -> JSONValue {
        if let result { return try result.get() }
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }
    /// Keeps an un-awaited call from reporting a failure nobody reads.
    @discardableResult func quiet() -> WireCall { Task { _ = try? await value() }; return self }
}
