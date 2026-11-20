import Foundation

/// The link's default `open`: probe once (cached), refresh the access token if it is stale, mint a single-use ticket,
/// connect, and wait for `gateway.ready`. Mirrors `createGatewayOpener` in gateway-link.cjs. The credential owner is
/// the Keychain store; a refreshed token set is saved back to it.
@MainActor final class GatewayOpener {
    private let store: GatewaySessionStore
    private let remote: GatewayRemote
    private let clock: GatewayClock
    private let allowLoopback: Bool
    private var authRequiredCache: [String: Bool] = [:]

    init(store: GatewaySessionStore, remote: GatewayRemote, clock: GatewayClock? = nil, allowLoopback: Bool = false) {
        self.store = store; self.remote = remote; self.clock = clock ?? SystemGatewayClock(); self.allowLoopback = allowLoopback
    }

    func open(timeout: TimeInterval) async throws -> GatewayConnection {
        guard var session = store.load() else { throw GatewayError("unconfigured", "No Hermes gateway is configured.") }
        guard let base = GatewayAddress.parse(session.address, allowLoopback: allowLoopback) else { throw GatewayError("bad_url", "That gateway address is not allowed.") }
        let key = base.origin + base.prefix
        if authRequiredCache[key] == nil { authRequiredCache[key] = try await remote.probe(base).authRequired }
        guard authRequiredCache[key] == true else { throw GatewayError("auth_failed", "This gateway has no sign-in, which this app needs.") }
        guard !session.refreshToken.isEmpty else { throw GatewayError("needs_signin", "Sign in to this gateway first.") }

        func refresh() async throws {
            let t = try await remote.refresh(base: base, refreshToken: session.refreshToken, provider: session.provider)
            session.accessToken = t.accessToken; session.refreshToken = t.refreshToken; session.expiresAt = t.expiresAt
            if !t.userId.isEmpty { session.userId = t.userId }
            try? store.save(session)
        }
        if session.accessToken.isEmpty || session.expiresAt - clock.now.timeIntervalSince1970 < 30 { try await refresh() }
        var ticket: String
        do { ticket = try await remote.wsTicket(base: base, accessToken: session.accessToken) }
        catch let e as GatewayError where e.code == "auth_failed" {
            try await refresh()
            ticket = try await remote.wsTicket(base: base, accessToken: session.accessToken)
        }
        try Task.checkCancellation()
        guard let url = remote.wsURL(base: base, ticket: ticket) else { throw GatewayError("bad_url", "That gateway address is not allowed.") }
        ticket = ""
        let socket = try await URLSessionGatewaySocket.connect(url: url, timeout: timeout)
        let wire = GatewayWire(socket: socket, clock: clock)
        let epoch: String
        do { epoch = try await Self.waitReady(wire, clock: clock, timeout: timeout) }
        catch { wire.dispose(); throw error }
        return GatewayConnection(wire: wire, epoch: epoch)
    }

    static func waitReady(_ wire: GatewayWire, clock: GatewayClock, timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<String, Error>) in MainActor.assumeIsolated {
            var done = false
            var timer: Task<Void, Never>?
            @MainActor func finish(_ result: Result<String, Error>) {
                guard !done else { return }
                done = true; timer?.cancel()
                wire.onEvent = nil; wire.onClose = nil
                c.resume(with: result)
            }
            wire.onEvent = { e in
                if e.type == "gateway.ready", let epoch = e.payload["replay_epoch"]?.string, !epoch.isEmpty { finish(.success(epoch)) }
            }
            wire.onClose = { _ in finish(.failure(GatewayError("gateway_down", "The connection closed before the gateway was ready."))) }
            timer = Task { @MainActor in
                do { try await clock.sleep(for: timeout) } catch { return }
                finish(.failure(GatewayError("gateway_down", "The gateway did not say it was ready.")))
            }
            wire.start()
        } }
    }
}

/// Sign-in: the one place a password is used. It goes to the gateway over https, is never stored or logged, and only
/// the session the gateway returns is saved (to the Keychain).
@MainActor enum GatewaySignIn {
    static func perform(address: String, username: String, password: String, remote: GatewayRemote, store: GatewaySessionStore,
                        allowLoopback: Bool = false) async throws -> GatewaySession {
        guard let base = GatewayAddress.parse(address, allowLoopback: allowLoopback) else {
            throw GatewayError("bad_url", "Use the https://….ts.net address of your Hermes gateway.")
        }
        let probe = try await remote.probe(base)
        guard probe.authRequired else { throw GatewayError("no_signin", "This gateway has no sign-in. Turn on its dashboard password first.") }
        guard let provider = probe.passwordProviders.first else {
            throw GatewayError("no_password_provider", "This gateway offers no username and password sign-in.")
        }
        let tokens: GatewayTokens
        do { tokens = try await remote.signIn(base: base, provider: provider, username: username, password: password) }
        catch let e as GatewayError where e.code == "auth_failed" { throw GatewayError("auth_failed", "Wrong username or password.") }
        let session = GatewaySession(address: base.origin + base.prefix, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
                                     expiresAt: tokens.expiresAt, provider: tokens.provider.isEmpty ? provider : tokens.provider, userId: tokens.userId)
        try store.save(session)
        return session
    }
}
