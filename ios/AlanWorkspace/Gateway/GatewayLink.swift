import Foundation

enum GatewayLinkState: String, Equatable, Sendable {
    case idle, connecting, reconnecting, syncing, live, offline, signin, refused, suspended, stopped
}

struct GatewayHistoryRow: Equatable, Sendable {
    var rowId: Int?
    var role: String
    var text: String
    var timestamp: TimeInterval?
}

/// What a conversation looks like when it is bound: its stored rows, and a reply that was already streaming.
struct GatewaySnapshot: Equatable, Sendable {
    var rows: [GatewayHistoryRow] = []
    var inflightAssistant: String?
    var latestSeq = 0
}

struct GatewaySessionEvent: Equatable, Sendable {
    let storedId: String
    let type: String
    let seq: Int?
    let payload: JSONValue
}

/// A socket the link owns, past `gateway.ready`.
@MainActor final class GatewayConnection {
    let wire: GatewayWire
    let epoch: String
    var negotiated = false
    init(wire: GatewayWire, epoch: String) { self.wire = wire; self.epoch = epoch }
    func close() { wire.dispose() }
}

/// Link supervisor, one per account: the Swift twin of `gateway-link.cjs`. It owns the single WebSocket, keeps it
/// alive (ping), reconnects with a capped jittered backoff and resumes every attached conversation from its last
/// applied `seq` instead of losing a reply. It adds no protocol; the wire speaks, this decides WHEN and what a gap means.
///
/// Rules held here:
/// - One attempt at a time, never more than one open socket. A trigger cancels the wait, never a running attempt.
/// - `lastSeq` and the replay epoch survive a drop in the attachment; a new socket resumes from them.
/// - Same epoch and the session still live: replay since `lastSeq`. Epoch changed, replay truncated or holed, or the
///   session reaped: emit `onGap` and let the store reload history. Nothing is replayed for a send.
/// - Logs carry state names, codes and counts. Never a URL, a credential or message text.
@MainActor final class GatewayLink {
    struct Options {
        var baseDelay: TimeInterval = 0.5, cap: TimeInterval = 15
        var freeDrops = 5, dropWindow: TimeInterval = 120
        var connectTimeout: TimeInterval = 8, bindTimeout: TimeInterval = 8
        var pingIdle: TimeInterval = 9, pingDead: TimeInterval = 4   // 13 s worst case from the last frame, inside Hermes's 45 s
        var offlinePoll: TimeInterval = 1, focusIdle: TimeInterval = 15
        init() {}
    }
    enum Trigger { case online, focus, wake, retry, credentials }
    typealias OpenFunction = @MainActor (_ timeout: TimeInterval) async throws -> GatewayConnection

    private(set) var state: GatewayLinkState = .idle { didSet { if state != oldValue { onState?(state) } } }
    private(set) var lastError = ""
    private(set) var epoch = ""
    var onState: ((GatewayLinkState) -> Void)?
    var onEvent: ((GatewaySessionEvent) -> Void)?
    var onGap: ((_ storedId: String, _ reason: String) -> Void)?
    var onLive: (() -> Void)?
    /// A server request (approval, question) this app cannot answer was refused on the wire.
    var onRefusedRequest: ((_ storedId: String?, _ method: String) -> Void)?
    var isLive: Bool { state == .live && conn != nil }

    private let openFn: OpenFunction
    private let clock: GatewayClock
    private let isOnline: () -> Bool
    private let random: () -> Double
    private let o: Options
    private var started = false, suspended = false, stopped = false
    private var failures = 0, drops: [Date] = [], everLive = false, liveSince: Date?
    private var conn: GatewayConnection?
    private var generation = 0, running = false
    private var attemptTask: Task<Void, Never>?, waitTask: Task<Void, Never>?, pingTask: Task<Void, Never>?
    private var lastActivity = Date.distantPast
    private var probing = false
    private final class Attachment {
        let storedId: String
        var sessionId = "", sessionKey = "", epoch = ""
        var lastSeq = 0
        var bound = false
        var buffer: [GatewayWire.Event]?
        var attaching: Task<GatewaySnapshot, Error>?
        init(_ id: String) { storedId = id }
    }
    private var atts: [String: Attachment] = [:]
    private var bySession: [String: Attachment] = [:]

    init(open: @escaping OpenFunction, clock: GatewayClock, isOnline: @escaping () -> Bool = { true },
         random: @escaping () -> Double = { Double.random(in: 0..<1) }, options: Options = Options()) {
        openFn = open; self.clock = clock; self.isOnline = isOnline; self.random = random; o = options
    }

    // MARK: scheduling

    private func clearWait() { waitTask?.cancel(); waitTask = nil }
    private func schedule(_ delay: TimeInterval) {
        clearWait()
        guard !stopped, !suspended else { return }
        waitTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: delay) } catch { return }
            self?.waitTask = nil
            self?.attemptNow()
        }
    }
    private func backoff(_ n: Int) -> TimeInterval { n <= 0 ? 0 : random() * min(o.cap, o.baseDelay * pow(2, Double(n - 1))) }
    /// The first `freeDrops` drops of a live link inside `dropWindow` reconnect at once; each one past that doubles the
    /// wait (capped, half-to-full jitter so luck cannot make a flapping link a loop).
    private func dropDelay() -> TimeInterval {
        let t = clock.now
        drops = drops.filter { t.timeIntervalSince($0) < o.dropWindow } + [t]
        let over = drops.count - o.freeDrops
        if over <= 0 { return 0 }
        let cap = min(o.cap, o.baseDelay * pow(2, Double(over - 1)))
        return cap / 2 + random() * cap / 2
    }
    private func scheduleNext(_ delay: TimeInterval? = nil) {
        let wait = delay ?? backoff(failures)
        failures += 1
        schedule(wait)
    }

    private func attemptNow() {
        guard !stopped, !suspended, !running, conn == nil else { return }
        clearWait()
        guard isOnline() else { state = .offline; schedule(o.offlinePoll); return }
        running = true
        generation += 1
        let gen = generation
        state = everLive ? .reconnecting : .connecting
        attemptTask = Task { [weak self] in await self?.runAttempt(gen) }
    }

    private func runAttempt(_ gen: Int) async {
        var opened: GatewayConnection?
        do {
            let c = try await openFn(o.connectTimeout)
            opened = c
            if gen != generation || stopped || suspended { c.close(); return }
            adopt(c)
            state = .syncing
            try await resumeAll(c)
            guard gen == generation, conn === c else { return }
            everLive = true; lastError = ""; liveSince = clock.now; epoch = c.epoch; failures = 0
            state = .live
            armPing()
            onLive?()
        } catch {
            guard gen == generation else { return }
            let code = (error as? GatewayError)?.code ?? "error"
            lastError = code
            if let c = opened { if conn === c { dropConn("attach_failed", keepState: true) } else { c.close() } }
            if ["session_expired", "needs_signin", "auth_failed"].contains(code) { state = .signin }
            else if code == "bad_url" { state = .refused }
            else if ["unconfigured", "no_credential"].contains(code) { state = .idle }
            else { state = isOnline() ? .reconnecting : .offline; scheduleNext() }
        }
        if gen == generation { running = false; attemptTask = nil }
    }

    private func adopt(_ c: GatewayConnection) {
        conn = c; lastActivity = clock.now; probing = false
        c.wire.onFrame = { [weak self, weak c] in if let self, self.conn === c { self.lastActivity = self.clock.now } }
        c.wire.onClose = { [weak self, weak c] code in if let self, let c, self.conn === c { self.dropConn("wire_\(code)") } }
        c.wire.onEvent = { [weak self, weak c] e in if let self, self.conn === c { self.route(e) } }
        c.wire.onServerRequest = { [weak self, weak c] r in if let self, let c, self.conn === c { self.refuse(r, on: c) } }
    }

    /// Approvals and questions need a card this app does not have yet. Say so on the wire rather than leave Hermes waiting.
    private func refuse(_ r: GatewayWire.ServerRequest, on c: GatewayConnection) {
        c.wire.refuseServerRequest(id: r.id, message: "This app cannot answer \(r.method) yet.")
        onRefusedRequest?(r.sessionId.flatMap { bySession[$0]?.storedId }, r.method)
    }

    /// Tears the socket down and keeps every attachment's watermark. `keepState` is for a failed attempt, whose caller sets the state.
    private func dropConn(_ reason: String, keepState: Bool = false) {
        guard let c = conn else { return }
        conn = nil
        pingTask?.cancel(); pingTask = nil
        let wasLive = liveSince != nil
        liveSince = nil
        for a in atts.values { a.bound = false; a.buffer = nil; a.attaching?.cancel(); a.attaching = nil }
        bySession.removeAll()
        c.close()
        if keepState || stopped || suspended { return }
        state = isOnline() ? .reconnecting : .offline
        generation += 1; running = false
        attemptTask?.cancel(); attemptTask = nil
        scheduleNext(wasLive ? dropDelay() : nil)
    }

    // MARK: liveness

    private func armPing(after delay: TimeInterval? = nil) {
        pingTask?.cancel()
        guard conn != nil else { return }
        let wait = max(0.001, delay ?? o.pingIdle - clock.now.timeIntervalSince(lastActivity))
        pingTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: wait) } catch { return }
            self?.pingCheck()
        }
    }
    private func pingCheck() {
        guard conn != nil else { return }
        if clock.now.timeIntervalSince(lastActivity) < o.pingIdle { armPing(); return }
        probeNow()
    }
    private func probeNow() {
        guard let c = conn, !probing else { return }
        probing = true
        Task { [weak self] in
            do {
                _ = try await c.wire.call("gateway.ping", [:], timeout: self?.o.pingDead)
                guard let self, self.conn === c else { return }
                self.probing = false; self.lastActivity = self.clock.now; self.armPing()
            } catch {
                guard let self, self.conn === c else { return }
                self.probing = false; self.dropConn("ping_timeout")
            }
        }
    }

    // MARK: attachments

    private func route(_ e: GatewayWire.Event) {
        guard let sid = e.sessionId, let a = bySession[sid] else { return }
        if a.buffer != nil { a.buffer?.append(e); return }
        deliver(e, to: a)
    }
    /// Applies an event once: `seq` only moves forward, so replayed and live frames may overlap safely.
    private func deliver(_ e: GatewayWire.Event, to a: Attachment) {
        if e.type == "session.reclaimed" { gap(a, "reaped"); return }
        if let seq = e.seq {
            guard seq > a.lastSeq else { return }
            a.lastSeq = seq
        }
        onEvent?(GatewaySessionEvent(storedId: a.storedId, type: e.type, seq: e.seq, payload: e.payload))
    }
    private func gap(_ a: Attachment, _ reason: String) {
        a.bound = false; a.lastSeq = 0; a.epoch = ""; a.buffer = nil
        if !a.sessionId.isEmpty { bySession.removeValue(forKey: a.sessionId) }
        a.sessionId = ""; a.sessionKey = ""
        onGap?(a.storedId, reason)
    }

    private func negotiate(_ c: GatewayConnection, sessionId: String, key: String) async throws {
        let wire = c.wire
        let caps = c.negotiated ? nil : wire.begin("gateway.capabilities").quiet()
        let adv = c.negotiated ? nil : wire.begin("client.capabilities", ["server_requests": .bool(true)]).quiet()
        let rows = wire.begin("session.active_list").quiet()
        if let caps, let adv {
            guard try await caps.value()["per_session_exclusive_submit"]?.bool == true else { throw GatewayError("capability_missing", "This gateway cannot guard against two sends at once.") }
            guard try await adv.value()["server_requests"]?.array != nil else { throw GatewayError("contract_drift", "client.capabilities drifted") }
        }
        let list = try await rows.value()["sessions"]?.array ?? []
        guard list.contains(where: { $0["id"]?.string == sessionId && $0["session_key"]?.string == key }) else {
            throw GatewayError("identity_unavailable", "That conversation is no longer live on the gateway.")
        }
        c.negotiated = true
    }

    private static func snapshot(_ activated: JSONValue, latestSeq: Int) -> GatewaySnapshot {
        var snap = GatewaySnapshot(latestSeq: latestSeq)
        for m in activated["messages"]?.array ?? [] {
            guard let role = m["role"]?.string else { continue }
            snap.rows.append(GatewayHistoryRow(rowId: m["row_id"]?.int, role: role, text: m["text"]?.string ?? m["content"]?.string ?? "",
                                               timestamp: m["timestamp"]?.double))
        }
        if let text = activated["inflight"]?["assistant"]?.string, !text.isEmpty { snap.inflightAssistant = text }
        return snap
    }

    private func requireLive() throws -> GatewayConnection {
        guard state == .live, let c = conn else {
            throw GatewayError(state == .signin ? "signin" : "not_live", state == .signin ? "Sign in to Hermes again." : "The connection to Hermes is not live.")
        }
        return c
    }

    /// Binds a runtime session fresh: history from `session.activate`, watermark from `session.events.since`.
    private func bindFresh(_ a: Attachment, _ c: GatewayConnection, sessionId: String, key: String) async throws -> GatewaySnapshot {
        a.sessionId = sessionId; a.sessionKey = key; a.buffer = []; a.lastSeq = 0
        bySession[sessionId] = a
        do {
            try await negotiate(c, sessionId: sessionId, key: key)
            let act = c.wire.begin("session.activate", ["session_id": .string(sessionId), "omit_messages": .bool(false)], timeout: o.bindTimeout).quiet()
            let since = c.wire.begin("session.events.since", ["session_id": .string(sessionId), "last_seen": .number(0)], timeout: o.bindTimeout).quiet()
            let activated = try await act.value()
            guard activated["session_id"]?.string == sessionId else { throw GatewayError("identity_drift", "session.activate returned a different session.") }
            let replay = try await since.value()
            guard replay["epoch"]?.string == c.epoch, let latest = replay["latest_seq"]?.int else { throw GatewayError("epoch_mismatch", "The gateway restarted while this conversation opened.") }
            guard conn === c, bySession[sessionId] === a else { throw GatewayError("closed", "The connection changed while this conversation opened.") }
            a.lastSeq = latest; a.epoch = c.epoch; a.bound = true
            let late = a.buffer ?? []; a.buffer = nil
            for e in late { deliver(e, to: a) }
            return Self.snapshot(activated, latestSeq: latest)
        } catch {
            bySession.removeValue(forKey: sessionId)
            a.sessionId = ""; a.sessionKey = ""; a.buffer = nil; a.bound = false
            throw error
        }
    }

    private func attachment(_ storedId: String) -> Attachment {
        if let a = atts[storedId] { return a }
        let a = Attachment(storedId); atts[storedId] = a; return a
    }

    /// Binds the conversation on the live socket (or reads its history again if it is bound) and returns what is stored.
    func open(_ storedId: String) async throws -> GatewaySnapshot {
        guard !storedId.isEmpty else { throw GatewayError("bad_session", "A conversation id is required.") }
        let c = try requireLive()
        let a = attachment(storedId)
        if a.bound, a.sessionId != "" {
            let activated = try await c.wire.call("session.activate", ["session_id": .string(a.sessionId), "omit_messages": .bool(false)])
            return Self.snapshot(activated, latestSeq: a.lastSeq)
        }
        if let running = a.attaching { return try await running.value }
        let task = Task { [self] () throws -> GatewaySnapshot in
            let resumed = try await c.wire.call("session.resume", ["session_id": .string(storedId), "lazy": .bool(true), "inline_images": .bool(false)])
            guard let sid = resumed["session_id"]?.string, !sid.isEmpty else { throw GatewayError("contract_drift", "session.resume did not return a session.") }
            return try await bindFresh(a, c, sessionId: sid, key: resumed["session_key"]?.string ?? storedId)
        }
        a.attaching = task
        defer { if a.attaching == task { a.attaching = nil } }
        return try await task.value
    }

    /// A new conversation on the gateway, bound and ready for its first message.
    func create() async throws -> (storedId: String, snapshot: GatewaySnapshot) {
        let c = try requireLive()
        let created = try await c.wire.call("session.create")
        guard let sid = created["session_id"]?.string ?? created["id"]?.string, !sid.isEmpty else { throw GatewayError("contract_drift", "session.create did not return a session.") }
        var key = created["session_key"]?.string ?? ""
        if key.isEmpty {
            let rows = try await c.wire.call("session.active_list")["sessions"]?.array ?? []
            key = rows.first { $0["id"]?.string == sid }?["session_key"]?.string ?? ""
        }
        guard !key.isEmpty else { throw GatewayError("contract_drift", "The new conversation is not in the live list yet.") }
        let a = attachment(key)
        return (key, try await bindFresh(a, c, sessionId: sid, key: key))
    }

    func request(_ method: String, _ params: [String: JSONValue] = [:]) async throws -> JSONValue {
        try await requireLive().wire.call(method, params)
    }

    /// `prompt.submit`. Throws `not_live` before writing anything when the link is down, so that is a definite "not sent".
    /// Anything thrown after the write (`timeout`, `closed`) is a send in doubt.
    @discardableResult
    func submit(_ storedId: String, text: String, clientMessageId: String) async throws -> Int? {
        let c = try requireLive()
        var a = attachment(storedId)
        if !a.bound { _ = try await open(storedId); a = attachment(storedId) }
        guard a.bound, conn === c else { throw GatewayError("not_live", "The connection to Hermes is not live.") }
        let result = try await c.wire.call("prompt.submit", ["session_id": .string(a.sessionId), "text": .string(text), "client_message_id": .string(clientMessageId)])
        return result["user_row_id"]?.int
    }

    func interrupt(_ storedId: String) async throws {
        let c = try requireLive()
        guard let a = atts[storedId], a.bound else { throw GatewayError("not_live", "This conversation is not attached.") }
        _ = try await c.wire.call("session.interrupt", ["session_id": .string(a.sessionId)])
    }

    func detach(_ storedId: String) {
        guard let a = atts.removeValue(forKey: storedId) else { return }
        if !a.sessionId.isEmpty { bySession.removeValue(forKey: a.sessionId) }
        a.attaching?.cancel()
    }

    // MARK: resume after a drop

    private func resumeAll(_ c: GatewayConnection) async throws {
        for a in atts.values.sorted(by: { $0.storedId < $1.storedId }) where a.sessionId != "" {
            try await resume(a, on: c)
        }
    }

    private func resume(_ a: Attachment, on c: GatewayConnection) async throws {
        if !a.epoch.isEmpty, a.epoch != c.epoch { gap(a, "restarted"); return }
        a.buffer = []; bySession[a.sessionId] = a
        let sessionId = a.sessionId
        do {
            try await negotiate(c, sessionId: sessionId, key: a.sessionKey)
            let act = c.wire.begin("session.activate", ["session_id": .string(sessionId), "omit_messages": .bool(true)], timeout: o.bindTimeout).quiet()
            let since = c.wire.begin("session.events.since", ["session_id": .string(sessionId), "last_seen": .number(Double(a.lastSeq))], timeout: o.bindTimeout).quiet()
            let activated = try await act.value()
            guard activated["session_id"]?.string == sessionId else { gap(a, "restarted"); return }
            let replay = try await since.value()
            guard conn === c else { throw GatewayError("closed", "The connection changed while resuming.") }
            guard replay["epoch"]?.string == c.epoch, let latest = replay["latest_seq"]?.int, let events = replay["events"]?.array else { gap(a, "restarted"); return }
            let frames = events.compactMap { f -> GatewayWire.Event? in
                guard let type = f["type"]?.string, let seq = f["seq"]?.int else { return nil }
                return GatewayWire.Event(type: type, sessionId: sessionId, seq: seq, payload: f["payload"] ?? .null)
            }.sorted { $0.seq! < $1.seq! }
            // Replay first, then the live frames that arrived meanwhile, through the same `seq` check.
            var seen = Set<Int>()
            let ordered = (frames + (a.buffer ?? [])).filter { $0.seq.map { seen.insert($0).inserted } ?? true }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
            var next = a.lastSeq, holes = 0
            for e in ordered { guard let s = e.seq, s > next else { continue }; if next > 0, s > next + 1 { holes += s - next - 1 }; next = s }
            if next < latest { holes += latest - next }
            if replay["truncated"]?.bool == true || holes > 0 { gap(a, "truncated"); return }
            a.buffer = nil
            for e in ordered { deliver(e, to: a) }
            a.epoch = c.epoch; a.bound = true
        } catch let e as GatewayError where e.code == "identity_unavailable" {
            gap(a, "reaped")
        }
    }

    // MARK: triggers and lifecycle

    func trigger(_ reason: Trigger) {
        guard started, !stopped else { return }
        switch reason {
        case .retry, .credentials:
            if suspended { return }
            if [.signin, .idle, .refused].contains(state) { failures = 0; state = .reconnecting }
            if conn == nil { clearWait(); attemptNow() }
        case .wake:
            if suspended || state == .signin { return }
            if conn != nil { dropConn("wake", keepState: true); state = isOnline() ? .reconnecting : .offline; generation += 1; running = false; attemptTask?.cancel() }
            clearWait(); attemptNow()
        case .online, .focus:
            if suspended || state == .signin { return }
            if conn != nil {
                if reason == .online || clock.now.timeIntervalSince(lastActivity) > o.focusIdle { probeNow() }
                return
            }
            clearWait(); attemptNow()
        }
    }

    /// iOS suspends sockets in the background: close it now and reconnect on `resume()`.
    func suspend() {
        guard !stopped, !suspended else { return }
        suspended = true
        clearWait(); attemptTask?.cancel(); attemptTask = nil
        if conn != nil { dropConn("suspend", keepState: true) }
        generation += 1; running = false
        state = .suspended
    }
    func resume() {
        guard !stopped, suspended else { return }
        suspended = false
        state = .reconnecting
        attemptNow()
    }
    func start() {
        guard !started, !stopped else { return }
        started = true
        attemptNow()
    }
    func stop() {
        stopped = true; clearWait(); attemptTask?.cancel(); attemptTask = nil
        if conn != nil { dropConn("stop", keepState: true) }
        generation += 1; running = false
        state = .stopped
    }
}
