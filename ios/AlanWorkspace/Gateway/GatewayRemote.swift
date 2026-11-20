import CryptoKit
import Foundation

struct GatewayTokens: Equatable, Sendable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: TimeInterval
    var provider: String
    var userId: String
}

struct GatewayProbe: Sendable { let authRequired: Bool; let providers: [String]; let passwordProviders: [String] }

/// The authenticated connector, the Swift twin of `hermes-remote.cjs`: probe, RFC 8252 password sign-in with PKCE,
/// refresh, and the single-use WebSocket ticket. Passwords and tokens live only in these request bodies and the
/// returned `GatewayTokens`; nothing here logs a URL, a token or a body. The address rule runs on every request.
final class GatewayRemote: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let allowLoopback: Bool
    private var session: URLSession!
    private static let maxBody = 1024 * 1024

    init(allowLoopback: Bool = false, configuration: URLSessionConfiguration? = nil) {
        self.allowLoopback = allowLoopback
        super.init()
        let config = configuration ?? .ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    /// A redirect is an answer here (password providers answer 302 to /login), never something to follow.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }

    private struct Reply { let status: Int; let json: JSONValue?; let text: String; let cookies: [HTTPCookie] }

    private func request(_ base: GatewayBase, _ method: String, _ route: String, headers: [String: String] = [:],
                         body: JSONValue? = nil, cookies: [String: String] = [:]) async throws -> Reply {
        guard GatewayAddress.parse(base.origin + base.prefix, allowLoopback: allowLoopback) != nil, let url = base.url(route) else {
            throw GatewayError("bad_url", "Use an https://….ts.net address for the Hermes gateway.")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body { req.httpBody = body.serialized()?.data(using: .utf8); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if !cookies.isEmpty { req.setValue(cookies.map { "\($0.key)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: req) }
        catch let e as URLError where e.code == .timedOut { throw GatewayError("timeout", "\(method) \(route) timed out.") }
        catch let e as URLError where e.code == .cancelled { throw GatewayError("aborted", "\(method) \(route) was cancelled.") }
        catch { throw GatewayError("unreachable", "Could not reach the gateway.") }
        guard let http = response as? HTTPURLResponse else { throw GatewayError("unreachable", "Could not reach the gateway.") }
        guard data.count <= Self.maxBody else { throw GatewayError("oversized", "\(route): response too large.") }
        let text = String(decoding: data, as: UTF8.self)
        let fields = http.allHeaderFields.reduce(into: [String: String]()) { if let k = $1.key as? String, let v = $1.value as? String { $0[k] = v } }
        return Reply(status: http.statusCode, json: JSONValue.parse(text), text: text, cookies: HTTPCookie.cookies(withResponseHeaderFields: fields, for: url))
    }

    private func failure(_ reply: Reply, _ route: String) -> GatewayError {
        let detail = reply.json?["detail"]?.string ?? reply.json?["error"]?.string ?? String(reply.text.prefix(200))
        if reply.status == 401 || reply.status == 403 { return GatewayError("auth_failed", "\(route): \(detail.isEmpty ? String(reply.status) : detail)") }
        if reply.status == 404 { return GatewayError("not_found", "\(route): \(detail.isEmpty ? "not found" : detail)") }
        return GatewayError("http_error", "\(route): HTTP \(reply.status) \(detail)")
    }

    func probe(_ base: GatewayBase) async throws -> GatewayProbe {
        let res = try await request(base, "GET", "/api/status")
        guard res.status == 200, let json = res.json, json.object != nil else { throw failure(res, "GET /api/status") }
        guard json["version"]?.string != nil else { throw GatewayError("not_hermes", "That address answered, but it is not a Hermes gateway.") }
        let authRequired = json["auth_required"]?.bool == true
        var providers: [String] = [], password: [String] = []
        if authRequired {
            let list = try? await request(base, "GET", "/api/auth/providers")
            let rows = list?.json?.array ?? list?.json?["providers"]?.array ?? (json["auth_providers"]?.array ?? []).map { JSONValue.object(["name": $0]) }
            for row in rows { if let name = row["name"]?.string { providers.append(name); if row["supports_password"]?.bool == true { password.append(name) } } }
        }
        return GatewayProbe(authRequired: authRequired, providers: providers, passwordProviders: password)
    }

    /// RFC 8252 native password login. `username` and `password` never leave this function.
    func signIn(base: GatewayBase, provider: String, username: String, password: String) async throws -> GatewayTokens {
        var verifierBytes = [UInt8](repeating: 0, count: 32), stateBytes = [UInt8](repeating: 0, count: 18)
        guard SecRandomCopyBytes(kSecRandomDefault, 32, &verifierBytes) == errSecSuccess,
              SecRandomCopyBytes(kSecRandomDefault, 18, &stateBytes) == errSecSuccess else { throw GatewayError("error", "Could not start a secure sign-in.") }
        let verifier = Self.base64URL(Data(verifierBytes)), state = Self.base64URL(Data(stateBytes))
        var query = URLComponents()
        query.queryItems = [("provider", provider), ("code_challenge", Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))),
                            ("code_challenge_method", "S256"), ("redirect_uri", "http://127.0.0.1/hermes/callback"), ("state", state)]
            .map { URLQueryItem(name: $0.0, value: $0.1) }
        let authz = try await request(base, "GET", "/auth/native/authorize?\(query.percentEncodedQuery ?? "")", headers: ["Accept": "text/html,application/json"])
        guard [302, 303].contains(authz.status), !authz.cookies.isEmpty else {
            throw GatewayError("auth_flow_unsupported", "This gateway's sign-in needs a browser, which this app does not support.")
        }
        let jar = Dictionary(authz.cookies.map { ($0.name, $0.value) }, uniquingKeysWith: { $1 })
        let login = try await request(base, "POST", "/auth/password-login", body: .object([
            "provider": .string(provider), "username": .string(username), "password": .string(password), "next": .string("")]), cookies: jar)
        guard login.status == 200, let next = login.json?["next"]?.string else { throw failure(login, "POST /auth/password-login") }
        guard let nextURL = URLComponents(string: next) else { throw GatewayError("contract_drift", "The gateway's sign-in answer is not a URL.") }
        guard ["127.0.0.1", "::1", "[::1]"].contains(nextURL.host ?? "") else { throw GatewayError("contract_drift", "The gateway's sign-in redirect is not loopback.") }
        let items = nextURL.queryItems ?? []
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
              items.first(where: { $0.name == "state" })?.value == state else { throw GatewayError("auth_failed", "The gateway's sign-in answer did not match.") }
        let token = try await request(base, "POST", "/auth/native/token", body: .object(["code": .string(code), "code_verifier": .string(verifier)]))
        guard token.status == 200, let json = token.json, json["access_token"]?.string != nil else { throw failure(token, "POST /auth/native/token") }
        return Self.tokens(json)
    }

    func refresh(base: GatewayBase, refreshToken: String, provider: String) async throws -> GatewayTokens {
        let res = try await request(base, "POST", "/auth/native/refresh", body: .object(["refresh_token": .string(refreshToken), "provider": .string(provider)]))
        if res.status == 401 || res.json?["error"]?.string == "session_expired" { throw GatewayError("session_expired", "Your sign-in expired. Sign in again.") }
        guard res.status == 200, let json = res.json, json["access_token"]?.string != nil else { throw failure(res, "POST /auth/native/refresh") }
        return Self.tokens(json, keepingRefresh: refreshToken, provider: provider)
    }

    func wsTicket(base: GatewayBase, accessToken: String) async throws -> String {
        let res = try await request(base, "POST", "/api/auth/ws-ticket", headers: ["Authorization": "Bearer \(accessToken)"])
        guard res.status == 200, let ticket = res.json?["ticket"]?.string else { throw failure(res, "POST /api/auth/ws-ticket") }
        return ticket
    }

    /// The socket URL carries a single-use, 30 s ticket. Never log it.
    func wsURL(base: GatewayBase, ticket: String) -> URL? {
        guard var parts = URLComponents(string: base.origin + base.prefix + "/api/ws") else { return nil }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        return parts.url
    }

    static func tokens(_ json: JSONValue, keepingRefresh: String = "", provider: String = "") -> GatewayTokens {
        var expires = json["expires_at"]?.double ?? 0
        if expires > 1e12 { expires /= 1000 }
        return GatewayTokens(accessToken: json["access_token"]?.string ?? "", refreshToken: json["refresh_token"]?.string ?? keepingRefresh,
                             expiresAt: expires, provider: json["provider"]?.string ?? provider, userId: json["user_id"]?.string ?? "")
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

// MARK: - Socket

/// `URLSessionWebSocketTask` behind `GatewaySocket`. Sends are queued and written one at a time, in order. The
/// connection is dialled with `connect(url:timeout:)` first; frames the server sends meanwhile wait in the task.
@MainActor final class URLSessionGatewaySocket: NSObject, GatewaySocket, URLSessionWebSocketDelegate {
    var onText: ((String) -> Void)?
    var onClose: ((Int?) -> Void)?
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var opened: CheckedContinuation<Void, Error>?
    private var outbox: [String] = []
    private var writing = false
    private var ended = false

    static func connect(url: URL, timeout: TimeInterval) async throws -> URLSessionGatewaySocket {
        let socket = URLSessionGatewaySocket()
        try await socket.dial(url, timeout: timeout)
        return socket
    }

    private func dial(_ url: URL, timeout: TimeInterval) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        let task = session.webSocketTask(with: req)
        task.maximumMessageSize = GatewayWire.maxFrameBytes
        self.task = task
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    opened = c
                    task.resume()
                }
            } onCancel: { Task { @MainActor in self.abort(GatewayError("aborted", "Connecting was cancelled.")) } }
        } catch {
            teardown(); throw error
        }
    }

    private func abort(_ error: GatewayError) {
        if let c = opened { opened = nil; c.resume(throwing: error) }
        task?.cancel(with: .goingAway, reason: nil)
    }

    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        MainActor.assumeIsolated { if let c = opened { opened = nil; c.resume() } }
    }
    nonisolated func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        MainActor.assumeIsolated { finish(code: closeCode.rawValue) }
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        MainActor.assumeIsolated {
            if let c = opened { opened = nil; c.resume(throwing: GatewayError("unreachable", "The gateway refused or did not answer the connection.")) }
            else { finish(code: nil) }
        }
    }

    func startReceiving() { receiveNext() }
    private func receiveNext() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, !self.ended else { return }
                switch result {
                case .success(.string(let text)): self.onText?(text); self.receiveNext()
                case .success(.data(let data)): self.onText?(String(decoding: data, as: UTF8.self)); self.receiveNext()
                case .success: self.receiveNext()
                case .failure: self.finish(code: nil)
                }
            }
        }
    }

    func send(_ text: String) {
        guard !ended else { return }
        outbox.append(text); pump()
    }
    private func pump() {
        guard !writing, !outbox.isEmpty, let task else { return }
        writing = true
        task.send(.string(outbox.removeFirst())) { [weak self] error in
            Task { @MainActor in
                guard let self else { return }
                self.writing = false
                if error != nil { self.finish(code: nil) } else { self.pump() }
            }
        }
    }

    func close() {
        guard !ended else { return }
        ended = true
        task?.cancel(with: .normalClosure, reason: nil)
        teardown()
    }
    private func finish(code: Int?) {
        guard !ended else { return }
        ended = true
        task?.cancel(with: .goingAway, reason: nil)
        let handler = onClose
        onText = nil; onClose = nil
        teardown()
        handler?(code)
    }
    private func teardown() { session?.invalidateAndCancel(); task = nil }
}
