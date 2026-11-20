import Foundation

struct GatewayOutboxItem: Codable, Equatable, Identifiable, Sendable {
    enum State: String, Codable, Sendable { case queued, sending, failed }
    /// The client message id (`cmid`): sent as `client_message_id` on `prompt.submit` and the key of the row on screen.
    var id: String
    var conversationId: String
    var text: String
    var createdAt: TimeInterval
    var state: State
    var attempts: Int
    var attemptedAt: TimeInterval
    /// The highest stored row id known when the first attempt began; the doubt check only trusts rows newer than this.
    var afterId: Int
}

/// The offline send queue, the Swift twin of the queue in `native-chat.cjs` (phase 2 of gateway-spec.md).
/// A message is written here before anything is sent. Per conversation it goes in order, one at a time; a failed head
/// holds everything behind it until the person decides. Persisted with file protection "complete until first user
/// authentication"; message text is never logged.
struct GatewayOutbox: Equatable {
    #if DEBUG
    /// UI tests shorten the 30 minutes so "Not sent" can be seen without waiting.
    static let maxAge: TimeInterval = Double(ProcessInfo.processInfo.environment["GATEWAY_QUEUE_MAX_AGE"] ?? "") ?? 30 * 60
    #else
    static let maxAge: TimeInterval = 30 * 60
    #endif
    static let maxItems = 200
    static let maxBytes = 1_048_576
    /// Rows from the history this close to (or after) the first attempt may be its echo.
    static let matchSlack: TimeInterval = 60

    private(set) var items: [GatewayOutboxItem] = []
    private let fileURL: URL?

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL
        guard let fileURL, let data = try? Data(contentsOf: fileURL),
              let stored = try? JSONDecoder().decode([GatewayOutboxItem].self, from: data) else { return }
        items = stored.filter { !$0.id.isEmpty && !$0.conversationId.isEmpty && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .prefix(Self.maxItems)
            // An attempt that was in flight when the app quit is in doubt: it goes through the history check, never straight out.
            .map { var i = $0; if i.state == .sending { i.state = .queued; i.attempts = max(i.attempts, 1) }; return i }
    }

    func items(for conversationId: String) -> [GatewayOutboxItem] { items.filter { $0.conversationId == conversationId } }
    /// Only the head of a conversation may go; a failed head blocks the rest.
    func head(for conversationId: String) -> GatewayOutboxItem? { items.first { $0.conversationId == conversationId } }
    func item(_ id: String) -> GatewayOutboxItem? { items.first { $0.id == id } }
    var conversationIds: [String] { var seen = Set<String>(); return items.compactMap { seen.insert($0.conversationId).inserted ? $0.conversationId : nil } }
    var queuedCount: Int { items.filter { $0.state == .queued }.count }

    mutating func enqueue(id: String = UUID().uuidString.lowercased(), conversationId: String, text: String, now: TimeInterval) throws -> GatewayOutboxItem {
        let bytes = items.reduce(0) { $0 + $1.text.utf8.count } + text.utf8.count
        guard items.count < Self.maxItems, bytes <= Self.maxBytes else {
            throw GatewayError("queue_full", "Too many messages are waiting to send. Wait for them to go, or delete some.")
        }
        let item = GatewayOutboxItem(id: id, conversationId: conversationId, text: text, createdAt: now, state: .queued, attempts: 0, attemptedAt: 0, afterId: 0)
        items.append(item)
        persist()
        return item
    }

    /// Too old to run: an instruction typed half an hour ago should not fire now. It stays, as "Not sent".
    @discardableResult
    mutating func sweep(now: TimeInterval) -> Bool {
        var changed = false
        for i in items.indices where items[i].state == .queued && now - items[i].createdAt > Self.maxAge { items[i].state = .failed; changed = true }
        if changed { persist() }
        return changed
    }
    /// When the next queued item runs out of time, or nil.
    func nextExpiry() -> TimeInterval? { items.filter { $0.state == .queued }.map { $0.createdAt + Self.maxAge }.min() }

    mutating func markSending(_ id: String, now: TimeInterval, afterId: Int) {
        update(id) { if $0.attempts == 0 { $0.afterId = afterId }; $0.attempts += 1; $0.attemptedAt = now; $0.state = .sending }
    }
    /// The attempt never reached the wire (the link was down): the message is not in doubt.
    mutating func unsend(_ id: String, attempts: Int, attemptedAt: TimeInterval) {
        update(id) { $0.attempts = attempts; $0.attemptedAt = attemptedAt; $0.state = .queued }
    }
    /// The attempt may have reached Hermes: the next try checks the history first.
    mutating func requeueInDoubt(_ id: String) { update(id) { $0.state = .queued } }
    mutating func fail(_ id: String) { update(id) { $0.state = .failed } }
    mutating func retry(_ id: String, now: TimeInterval) { update(id) { if $0.state == .failed { $0.state = .queued; $0.createdAt = now } } }
    mutating func remove(_ id: String) {
        guard items.contains(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }; persist()
    }
    mutating func removeAll() { items = []; persist() }

    private mutating func update(_ id: String, _ change: (inout GatewayOutboxItem) -> Void) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        change(&items[i]); persist()
    }

    private func persist() {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            if items.isEmpty { try? FileManager.default.removeItem(at: fileURL); return }
            try JSONEncoder().encode(items).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var url = fileURL, values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        } catch {}
    }

    /// The default location, in the app's private container.
    static var defaultURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Gateway/outbox.json")
    }
}

enum GatewayDelivery {
    /// A send in doubt (`attempts > 0`) is resolved from the history before any resend. Hermes takes no client id on
    /// `prompt.submit` yet, so the evidence is a user row with this text, newer than what we had when the first try
    /// began, not yet claimed by another message. Earliest wins.
    /// shortcut: if the first request is still on its way to Hermes when the history is read, the row is not there yet and
    /// the message goes twice; this closes only when Hermes returns the client id. Two identical messages within 60 s of
    /// each other can also be mistaken for one another.
    static func match(_ item: GatewayOutboxItem, in rows: [GatewayHistoryRow], claimed: Set<Int>) -> GatewayHistoryRow? {
        rows.filter { row in
            guard row.role == "user", let id = row.rowId, id > item.afterId, !claimed.contains(id),
                  row.text.trimmingCharacters(in: .whitespacesAndNewlines) == item.text.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return row.timestamp.map { $0 >= item.attemptedAt - GatewayOutbox.matchSlack } ?? true
        }.min { ($0.rowId ?? 0) < ($1.rowId ?? 0) }
    }
}
