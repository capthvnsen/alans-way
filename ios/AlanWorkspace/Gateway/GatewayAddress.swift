import Foundation

/// A validated gateway address: scheme and host (and port) plus an optional path prefix for a reverse-proxy mount.
struct GatewayBase: Equatable, Codable, Sendable {
    let origin: String
    let prefix: String
    var label: String { URL(string: origin)?.host.map { $0 + prefix } ?? origin }
    func url(_ route: String) -> URL? { URL(string: origin + prefix + route) }
}

/// The address rule from `desktop/src/tailnet.cjs` (`isServeName`, `tailnetUrl` with `serveName`): only an `https`
/// Tailscale Serve name, `<machine>.<tailnet>.ts.net`. No plain http, no other host, no credentials in the URL.
/// Literal tailnet IPs are not accepted: TLS to a bare IP cannot be verified and App Transport Security would need an exception.
enum GatewayAddress {
    /// `allowLoopback` is the iOS twin of `HERMES_WORKSPACE_ALLOW_LOOPBACK`. Only tests and DEBUG builds pass it.
    static func parse(_ input: String, allowLoopback: Bool = false) -> GatewayBase? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, var parts = URLComponents(string: raw), parts.user == nil, parts.password == nil,
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased() else { return nil }
        let serve = scheme == "https" && isServeName(host)
        let loopback = allowLoopback && scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)
        guard serve || loopback else { return nil }
        parts.scheme = scheme; parts.host = host; parts.query = nil; parts.fragment = nil
        var prefix = parts.path
        while prefix.hasSuffix("/") { prefix.removeLast() }
        parts.path = ""
        guard let origin = parts.url?.absoluteString else { return nil }
        return GatewayBase(origin: origin, prefix: prefix)
    }

    /// ASCII labels under `ts.net`: not the bare domain, no trailing dot, no punycode label.
    static func isServeName(_ host: String) -> Bool {
        let suffix = ".ts.net"
        guard host.hasSuffix(suffix), host.count > suffix.count else { return false }
        let labels = host.dropLast(suffix.count).split(separator: ".", omittingEmptySubsequences: false)
        let ok = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        return labels.allSatisfy { label in
            guard let first = label.first, let last = label.last, first != "-", last != "-", !label.hasPrefix("xn--") else { return false }
            return label.allSatisfy { ok.contains($0) }
        }
    }
}
