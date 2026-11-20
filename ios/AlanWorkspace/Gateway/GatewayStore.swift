import Foundation
import Network
import Observation

/// Alan's Way chat state: the link, the conversations, each open thread and the offline send queue.
/// The view reads this; nothing here draws.
@MainActor @Observable
final class GatewayStore {
    private(set) var isConfigured: Bool
    private(set) var linkState: GatewayLinkState = .idle
    private(set) var conversations: [GatewayConversation] = []
    private(set) var isLoadingConversations = false
    private(set) var conversationsError: String?
    private(set) var threads: [String: GatewayThread] = [:]
    private(set) var outbox: GatewayOutbox
    private(set) var address: String
    var errorMessage: String?
    let allowLoopback: Bool

    @ObservationIgnored private let sessionStore: GatewaySessionStore
    @ObservationIgnored private let remote: GatewayRemote
    @ObservationIgnored private let clock: GatewayClock
    @ObservationIgnored private let makeLink: (GatewayStore) -> GatewayLink
    @ObservationIgnored private var link: GatewayLink?
    @ObservationIgnored private var claimed = Set<Int>()
    @ObservationIgnored private var drainTask: Task<Void, Never>?
    @ObservationIgnored private var sweepTask: Task<Void, Never>?
    @ObservationIgnored private var monitor: NWPathMonitor?
    @ObservationIgnored private var online = true
    @ObservationIgnored private var active = true
    @ObservationIgnored private var reconnectTask: Task<Void, Never>?
    private var showReconnecting = false

    /// `makeLink` is for tests, which supply a link wired to a fake socket and clock.
    init(sessionStore: GatewaySessionStore = KeychainGatewaySessionStore(), outboxURL: URL? = GatewayOutbox.defaultURL,
         clock: GatewayClock? = nil, allowLoopback: Bool = false, monitorNetwork: Bool = true,
         makeLink: ((GatewayStore) -> GatewayLink)? = nil) {
        self.sessionStore = sessionStore
        let clock = clock ?? SystemGatewayClock()
        self.clock = clock
        self.allowLoopback = allowLoopback
        remote = GatewayRemote(allowLoopback: allowLoopback)
        let session = sessionStore.load()
        isConfigured = session != nil
        address = session.flatMap { GatewayAddress.parse($0.address, allowLoopback: allowLoopback)?.label } ?? ""
        outbox = GatewayOutbox(fileURL: outboxURL)
        self.makeLink = makeLink ?? { store in
            let opener = GatewayOpener(store: store.sessionStore, remote: store.remote, clock: store.clock, allowLoopback: store.allowLoopback)
            return GatewayLink(open: { try await opener.open(timeout: $0) }, clock: store.clock, isOnline: { store.online })
        }
        if monitorNetwork { startMonitor() }
        scheduleSweep()
    }

    // MARK: sign-in

    /// The password is used once, here, and never stored. Only the session the gateway returns is kept, in the Keychain.
    func signIn(address: String, username: String, password: String) async throws {
        link?.stop(); link = nil
        let session = try await GatewaySignIn.perform(address: address, username: username, password: password, remote: remote,
                                                      store: sessionStore, allowLoopback: allowLoopback)
        self.address = GatewayAddress.parse(session.address, allowLoopback: allowLoopback)?.label ?? ""
        isConfigured = true
        reset(keepOutbox: true)
        start()
    }

    /// Clears the credential and everything fetched with it. Unsent messages are deleted unless `keepUnsent`.
    func signOut(keepUnsent: Bool) {
        link?.stop(); link = nil
        try? sessionStore.clear()
        isConfigured = false
        address = ""
        reset(keepOutbox: keepUnsent)
        linkState = .idle
    }

    private func reset(keepOutbox: Bool) {
        conversations = []; threads = [:]; conversationsError = nil; claimed = []
        drainTask?.cancel(); drainTask = nil
        if !keepOutbox { outbox.removeAll() }
    }

    // MARK: link

    func start() {
        guard link == nil, isConfigured else { return }
        let l = makeLink(self)
        l.onState = { [weak self] state in self?.linkStateChanged(state) }
        l.onEvent = { [weak self] e in self?.receive(e) }
        l.onGap = { [weak self] id, _ in self?.reload(id) }
        l.onLive = { [weak self] in self?.becameLive() }
        l.onRefusedRequest = { [weak self] id, _ in
            guard let self, let id else { return }
            self.threads[id, default: GatewayThread()].notice = "Alan asked for approval, which this app cannot answer yet. Answer it from the desktop app."
        }
        link = l
        linkState = l.state
        l.start()
    }

    /// iOS suspends sockets in the background: close now, reconnect and resume on return.
    func setActive(_ isActive: Bool) {
        active = isActive
        if isActive { link?.resume(); link?.trigger(.focus) } else { link?.suspend() }
    }

    private func linkStateChanged(_ state: GatewayLinkState) {
        linkState = state
        reconnectTask?.cancel(); reconnectTask = nil
        if state != .reconnecting { showReconnecting = false; return }
        // A short blip does not flicker a banner: it shows only after 3 s.
        reconnectTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: 3) } catch { return }
            self?.showReconnecting = true
        }
    }

    private func becameLive() {
        Task { await refreshConversations() }
        for id in threads.keys where threads[id]?.needsReload == true { reload(id) }
        drainAll()
    }

    private func startMonitor() {
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                let was = self.online
                self.online = satisfied
                if satisfied && !was { self.link?.trigger(.online) }
            }
        }
        m.start(queue: DispatchQueue(label: "gateway.path"))
        monitor = m
    }

    // MARK: conversations

    func refreshConversations() async {
        guard let link, link.isLive else { return }
        isLoadingConversations = true
        defer { isLoadingConversations = false }
        do {
            async let active = link.request("session.active_list")
            async let stored = link.request("session.list", ["limit": .number(100)])
            let (a, s) = try await (active, stored)
            conversations = GatewayHistory.conversations(active: a["sessions"]?.array ?? [], stored: s["sessions"]?.array ?? [])
            conversationsError = nil
        } catch {
            conversationsError = "Conversations could not be loaded."
        }
    }

    func newConversation() async throws -> String {
        guard let link, link.isLive else { throw GatewayError("not_live", "Connect to Hermes first.") }
        let made = try await link.create()
        threads[made.storedId] = GatewayThread(rows: GatewayHistory.messages(from: made.snapshot.rows), hasLoaded: true)
        if !conversations.contains(where: { $0.id == made.storedId }) {
            conversations.insert(GatewayConversation(id: made.storedId, title: "New conversation", preview: "", lastActive: clock.now), at: 0)
        }
        return made.storedId
    }

    func messages(for id: String) -> [GatewayMessage] {
        let queued = outbox.items(for: id).map { item in
            GatewayMessage(id: item.id, role: .user, text: item.text, date: Date(timeIntervalSince1970: item.createdAt),
                           delivery: item.state == .failed ? .failed : item.state == .sending ? .sending : .queued)
        }
        return (threads[id]?.rows ?? []) + queued
    }
    func thread(_ id: String) -> GatewayThread { threads[id] ?? GatewayThread() }

    func open(_ id: String) {
        if threads[id] == nil { threads[id] = GatewayThread() }
        threads[id]?.notice = nil
        reload(id)
    }

    func closeConversation(_ id: String) { _ = id }

    /// Reads the stored history again and replaces what is shown. Events that arrive meanwhile wait, then apply on top.
    func reload(_ id: String) {
        guard let link else { return }
        var t = threads[id] ?? GatewayThread()
        guard link.isLive else {
            t.isLoading = false; t.needsReload = true; t.loadError = t.hasLoaded ? nil : "Waiting for the connection to Hermes."
            threads[id] = t; return
        }
        t.isLoading = !t.hasLoaded; t.loadError = nil; t.needsReload = false; t.holdDepth += 1
        threads[id] = t
        Task {
            do {
                let snap = try await link.open(id)
                var rows = GatewayHistory.messages(from: snap.rows)
                var thread = threads[id] ?? GatewayThread()
                thread.busy = snap.inflightAssistant != nil
                if let text = snap.inflightAssistant { thread.replyCount += 1; rows.append(GatewayMessage(id: "reply-\(thread.replyCount)", role: .assistant, text: text, isStreaming: true)) }
                thread.rows = rows; thread.isLoading = false; thread.hasLoaded = true; thread.statusLine = nil
                threads[id] = thread
                releaseHold(id, after: snap.latestSeq)
                drain(id)
            } catch {
                threads[id]?.isLoading = false
                threads[id]?.loadError = (error as? GatewayError)?.code == "identity_unavailable" ? "This conversation is no longer on the gateway." : "This conversation could not be loaded."
                releaseHold(id, after: 0)
            }
        }
    }

    // MARK: events

    private func releaseHold(_ id: String, after seq: Int) {
        guard var t = threads[id], t.holdDepth > 0 else { return }
        t.holdAfter = max(t.holdAfter, seq); t.holdDepth -= 1
        guard t.holdDepth == 0 else { threads[id] = t; return }
        let held = t.held.filter { ($0.seq ?? Int.max) > t.holdAfter }
        t.held = []; t.holdAfter = 0
        threads[id] = t
        for e in held { apply(e) }
    }

    private func receive(_ e: GatewaySessionEvent) {
        if let t = threads[e.storedId], t.holdDepth > 0 { threads[e.storedId]?.held.append(e); return }
        apply(e)
    }

    /// One session event into the thread. `message.complete` may carry the whole reply (the VM streams nothing) or end
    /// one that streamed; both end with the same row.
    private func apply(_ e: GatewaySessionEvent) {
        var t = threads[e.storedId] ?? GatewayThread()
        func streamingIndex() -> Int? { t.rows.lastIndex { $0.isStreaming } }
        func startRow(_ text: String) {
            t.replyCount += 1
            t.rows.append(GatewayMessage(id: "reply-\(t.replyCount)", role: .assistant, text: text, date: clock.now, isStreaming: true))
        }
        switch e.type {
        case "message.start":
            if let i = streamingIndex() { t.rows[i].isStreaming = false }
            startRow(""); t.busy = true; t.statusLine = nil
        case "message.delta":
            guard let text = e.payload["text"]?.string else { break }
            if let i = streamingIndex() { t.rows[i].text += text } else { startRow(text) }
            t.busy = true; t.statusLine = nil
        case "tool.start":
            t.statusLine = e.payload["name"]?.string.map { "Using \($0)…" }
        case "tool.complete":
            t.statusLine = nil
        case "message.complete":
            let status = e.payload["status"]?.string ?? "complete"
            let streamed = streamingIndex().map { t.rows[$0].text } ?? ""
            let text = e.payload["text"]?.string ?? streamed
            if let i = streamingIndex() {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { t.rows.remove(at: i) } else { t.rows[i].text = text; t.rows[i].isStreaming = false; t.rows[i].date = clock.now }
            } else if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                t.replyCount += 1
                t.rows.append(GatewayMessage(id: "reply-\(t.replyCount)", role: .assistant, text: text, date: clock.now))
            }
            t.busy = false; t.statusLine = nil
            if ["interrupted", "cancelled"].contains(status) { t.notice = "Stopped." }
            else if ["error", "failed"].contains(status) { t.notice = e.payload["error"]?.string ?? "Hermes could not finish this reply." }
        case "error":
            t.notice = e.payload["message"]?.string ?? "Hermes reported an error."
        default:
            return
        }
        threads[e.storedId] = t
        if e.type == "message.complete" { drain(e.storedId) }
    }

    // MARK: sending

    /// The message is written to the queue first, then goes when the link is live and the conversation is idle.
    func send(_ text: String, to id: String) throws {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        _ = try outbox.enqueue(conversationId: id, text: clean, now: clock.now.timeIntervalSince1970)
        scheduleSweep()
        threads[id, default: GatewayThread()].notice = nil
        bumpConversation(id, preview: clean)
        drain(id)
    }

    func cancel(_ itemID: String) {
        guard let item = outbox.item(itemID), item.state != .sending else { return }
        outbox.remove(itemID)
        drain(item.conversationId)
    }
    func retry(_ itemID: String) {
        guard let item = outbox.item(itemID), item.state == .failed else { return }
        outbox.retry(itemID, now: clock.now.timeIntervalSince1970)
        scheduleSweep()
        drain(item.conversationId)
    }
    func stopReply(_ id: String) {
        guard let link else { return }
        Task { try? await link.interrupt(id) }
    }

    private func bumpConversation(_ id: String, preview: String) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        var c = conversations.remove(at: i)
        c.lastActive = clock.now; c.preview = String(preview.prefix(200))
        conversations.insert(c, at: 0)
    }

    private func drainAll() { for id in outbox.conversationIds { drain(id) } }

    /// Only the head goes, only on a live link, and only with no reply running: a failed head holds everything behind it.
    private func drain(_ id: String) {
        outbox.sweep(now: clock.now.timeIntervalSince1970)
        guard let link, link.isLive, let head = outbox.head(for: id), head.state == .queued else { return }
        var t = threads[id] ?? GatewayThread()
        guard !t.busy, !t.checking else { if t.busy { scheduleDrain() }; return }
        t.checking = true
        threads[id] = t
        Task { await attempt(id, head.id, link) }
    }

    private func scheduleDrain(after seconds: TimeInterval = 3) {
        guard drainTask == nil else { return }
        drainTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: seconds) } catch { return }
            self?.drainTask = nil
            self?.drainAll()
        }
    }

    private func attempt(_ id: String, _ itemID: String, _ link: GatewayLink) async {
        func done() { threads[id]?.checking = false }
        guard var item = outbox.item(itemID), item.state == .queued else { done(); return }
        if item.attempts > 0 {
            // An earlier try may have reached Hermes; the history decides before anything goes twice.
            do {
                let snap = try await link.open(id)
                guard let current = outbox.item(itemID), current.state == .queued else { done(); return }
                if let hit = GatewayDelivery.match(current, in: snap.rows, claimed: claimed) {
                    claimed.insert(hit.rowId ?? -1)
                    outbox.remove(itemID)
                    var rows = GatewayHistory.messages(from: snap.rows)
                    var thread = threads[id] ?? GatewayThread()
                    thread.busy = snap.inflightAssistant != nil
                    if let text = snap.inflightAssistant { thread.replyCount += 1; rows.append(GatewayMessage(id: "reply-\(thread.replyCount)", role: .assistant, text: text, isStreaming: true)) }
                    thread.rows = rows; thread.notice = "Your earlier message did arrive; it was not sent twice."
                    threads[id] = thread
                    done(); drain(id); return
                }
                item = current
            } catch { done(); scheduleDrain(); return }
        }
        let before = (attempts: item.attempts, at: item.attemptedAt)
        let known = (threads[id]?.rows.compactMap { Int($0.id.dropFirst(4)) }.max() ?? 0)
        outbox.markSending(itemID, now: clock.now.timeIntervalSince1970, afterId: max(known, claimed.max() ?? 0, item.afterId))
        threads[id]?.checking = false
        beginSubmit(id)
        do {
            let rowId = try await link.submit(id, text: item.text, clientMessageId: item.id)
            outbox.remove(itemID)
            threads[id]?.rows.append(GatewayMessage(id: rowId.map { "row-\($0)" } ?? "sent-\(itemID)", role: .user, text: item.text, date: Date(timeIntervalSince1970: item.createdAt)))
            threads[id]?.busy = true
            endSubmit(id)
        } catch {
            endSubmit(id)
            let e = error as? GatewayError
            if e?.code == "not_live" || e?.code == "signin" {
                // Never written: not in doubt. It waits for the link.
                outbox.unsend(itemID, attempts: before.attempts, attemptedAt: before.at)
            } else if e?.isDefiniteReject == true {
                // 4090: a reply is already running (another device's turn). Not a failure; the message waits its turn.
                if e?.message.contains("4090") == true { outbox.unsend(itemID, attempts: before.attempts, attemptedAt: before.at); scheduleDrain() }
                else { outbox.fail(itemID); threads[id]?.notice = "That message was not sent." }
            } else {
                outbox.requeueInDoubt(itemID)
                scheduleDrain()
            }
        }
    }

    private func beginSubmit(_ id: String) { threads[id, default: GatewayThread()].holdDepth += 1 }
    private func endSubmit(_ id: String) { releaseHold(id, after: 0) }

    /// A message that waited past 30 minutes becomes "Not sent" even if nothing else is happening.
    private func scheduleSweep() {
        sweepTask?.cancel(); sweepTask = nil
        guard let expiry = outbox.nextExpiry() else { return }
        let wait = max(0.1, expiry - clock.now.timeIntervalSince1970 + 0.1)
        sweepTask = Task { [weak self, clock] in
            do { try await clock.sleep(for: wait) } catch { return }
            guard let self else { return }
            self.outbox.sweep(now: self.clock.now.timeIntervalSince1970)
            self.scheduleSweep()
        }
    }

    // MARK: banner

    /// One line about the connection, or nil when all is well.
    var banner: String? {
        let waiting = outbox.queuedCount
        let suffix = waiting > 0 ? " \(waiting) waiting to send." : ""
        switch linkState {
        case .live, .idle: return waiting > 0 ? "\(waiting) waiting to send." : nil
        case .connecting, .syncing: return "Connecting to Hermes…" + suffix
        case .reconnecting: return showReconnecting ? "Reconnecting…" + suffix : (waiting > 0 ? suffix.trimmingCharacters(in: .whitespaces) : nil)
        case .offline: return "Offline." + suffix
        case .suspended: return nil
        case .signin: return "Sign in to Hermes again." + suffix
        case .refused: return "This gateway address is not allowed. Check it in settings." + suffix
        case .stopped: return nil
        }
    }
}
