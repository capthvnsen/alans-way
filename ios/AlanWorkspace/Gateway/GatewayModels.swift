import Foundation

struct GatewayConversation: Identifiable, Equatable {
    let id: String
    var title: String
    var preview: String
    var lastActive: Date?
}

struct GatewayMessage: Identifiable, Equatable {
    enum Role: Equatable { case user, assistant }
    /// What the person sees under their own message. `sent` shows nothing.
    enum Delivery: Equatable { case sent, queued, sending, failed }
    var id: String
    var role: Role
    var text: String
    var date: Date?
    var delivery: Delivery = .sent
    var isStreaming = false
}

struct GatewayThread: Equatable {
    var rows: [GatewayMessage] = []
    var isLoading = false
    var loadError: String?
    /// A reply is running (or was when we last looked): the next queued message waits for it.
    var busy = false
    /// The history is being read before a doubtful resend.
    var checking = false
    var statusLine: String?
    var notice: String?
    var replyCount = 0
    var hasLoaded = false
    var needsReload = false
    // Events for this conversation wait here while a send or a history read is in flight, so a reply is never placed
    // before the message it answers, and a reload never wipes deltas that arrived while it was in the air.
    var holdDepth = 0
    var holdAfter = 0
    var held: [GatewaySessionEvent] = []
}

enum GatewayHistory {
    /// Stored rows to messages: only what a person said and what Alan answered; tool rows and empty rows are not shown.
    static func messages(from rows: [GatewayHistoryRow]) -> [GatewayMessage] {
        rows.enumerated().compactMap { index, row in
            guard row.role == "user" || row.role == "assistant" else { return nil }
            let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return GatewayMessage(id: row.rowId.map { "row-\($0)" } ?? "row-index-\(index)", role: row.role == "user" ? .user : .assistant,
                                  text: row.text, date: row.timestamp.map { Date(timeIntervalSince1970: $0) })
        }
    }

    /// Conversations from `session.active_list` and `session.list`, one row per stored id, newest first.
    static func conversations(active: [JSONValue], stored: [JSONValue]) -> [GatewayConversation] {
        var byId: [String: GatewayConversation] = [:]
        func title(_ v: JSONValue, _ id: String) -> String {
            let t = (v["title"]?.string ?? v["name"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty || t == id ? "" : t
        }
        for v in stored {
            guard let id = v["id"]?.string, !id.isEmpty, id.count <= 300 else { continue }
            let ts = v["last_active"]?.double ?? v["lastActive"]?.double ?? v["started_at"]?.double
            byId[id] = GatewayConversation(id: id, title: title(v, id), preview: v["preview"]?.string ?? "", lastActive: ts.map { Date(timeIntervalSince1970: $0) })
        }
        for v in active {
            guard let key = v["session_key"]?.string, !key.isEmpty, key.count <= 300 else { continue }
            var row = byId[key] ?? GatewayConversation(id: key, title: "", preview: "", lastActive: nil)
            if row.title.isEmpty { row.title = title(v, key) }
            byId[key] = row
        }
        return byId.values.map { var c = $0; if c.title.isEmpty { c.title = "New conversation" }; return c }
            .sorted { ($0.lastActive ?? .distantPast, $1.title) > ($1.lastActive ?? .distantPast, $0.title) }
    }
}
