import Foundation

/// What the gateway returns on sign-in, plus the address it belongs to. The password is never part of this.
struct GatewaySession: Codable, Equatable, Sendable {
    var address: String
    var accessToken: String
    var refreshToken: String
    /// Seconds since 1970 (the server sends either seconds or milliseconds; `GatewayTokens` normalises).
    var expiresAt: TimeInterval
    var provider: String
    var userId: String
}

protocol GatewaySessionStore: AnyObject {
    func load() -> GatewaySession?
    func save(_ session: GatewaySession) throws
    func clear() throws
}

/// The session credential lives in the Keychain only, under its own service name, never iCloud
/// (`ThisDeviceOnly`, as the Telegram secrets are).
final class KeychainGatewaySessionStore: GatewaySessionStore {
    private let service: String
    private let account = "session"
    init(service: String = "com.hermescompanion.gateway") { self.service = service }

    func load() -> GatewaySession? {
        guard let data = try? TelegramKeychain.get(account: account, service: service) else { return nil }
        return try? JSONDecoder().decode(GatewaySession.self, from: data)
    }
    func save(_ session: GatewaySession) throws {
        try TelegramKeychain.set(JSONEncoder().encode(session), account: account, service: service)
    }
    func clear() throws { try TelegramKeychain.remove(account: account, service: service) }
}

final class MemoryGatewaySessionStore: GatewaySessionStore {
    private(set) var session: GatewaySession?
    init(_ session: GatewaySession? = nil) { self.session = session }
    func load() -> GatewaySession? { session }
    func save(_ session: GatewaySession) throws { self.session = session }
    func clear() throws { session = nil }
}
