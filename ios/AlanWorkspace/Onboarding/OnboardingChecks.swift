import Foundation

enum TelegramAppCredentials {
    /// my.telegram.org issues a numeric api_id and a 32-character hexadecimal api_hash.
    static func problem(apiID: String, apiHash: String) -> String? {
        guard let id = Int32(apiID.trimmingCharacters(in: .whitespacesAndNewlines)), id > 0 else {
            return "The API ID is the number shown as App api_id."
        }
        let hash = apiHash.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hash.count == 32, hash.allSatisfy(\.isHexDigit) else {
            return "The API hash is the 32-character code shown as App api_hash."
        }
        return nil
    }
}

/// Optional first-run reachability checks. They only read public status pages and never send credentials.
enum ConnectionCheck {
    enum Outcome: Equatable {
        case ok(String)
        case problem(String)
    }

    static let invalidAddress = Outcome.problem("Enter a full https:// address without a username or password.")

    /// The voice plugin answers unauthenticated readiness on the Mini App origin.
    static func voiceProbeURL(_ address: String) -> URL? {
        guard let url = ViewerAddress.parse(address),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/v1/capabilities"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    static func voice(status: Int, body: Data) -> Outcome {
        switch status {
        case 200:
            let ready = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["ready"] as? Bool
            if ready == true { return .ok("The voice service is ready for calls.") }
            if ready == false { return notReady }
            return .problem("Something answered, but it is not the Hermes voice service. Check the address.")
        case 503: return notReady
        case 502, 504:
            return .problem("Your HTTPS front answered, but the voice plugin behind it is not running. Send /call to your bot once to start it, then check again.")
        case 404:
            return .problem("No voice service at this address. Use the plugin’s app_url and forward /v1/* to it.")
        default:
            return .problem("The voice service returned an unexpected response (HTTP \(status)).")
        }
    }

    static func viewer(status: Int) -> Outcome {
        switch status {
        case 200..<400: return .ok("Your desktop viewer answered.")
        case 401, 403: return .ok("Your desktop viewer answered and asks you to sign in. That is expected.")
        case 404: return .problem("The server answered, but nothing is at that path. Check the full viewer address, for example …/vnc.html.")
        case 500...: return .problem("The viewer’s server returned an error (HTTP \(status)). Check that the desktop viewer is running.")
        default: return .problem("The viewer returned an unexpected response (HTTP \(status)).")
        }
    }

    static func transport(_ error: Swift.Error) -> Outcome {
        guard let error = error as? URLError else { return .problem("Could not reach the server. \(error.localizedDescription)") }
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
            return .problem("This iPhone is offline. Connect to the internet and try again.")
        case .cannotFindHost, .dnsLookupFailed:
            return .problem("Could not find that server. Check the address. For a private tailnet address, connect Tailscale on this iPhone first.")
        case .timedOut, .cannotConnectToHost:
            return .problem("The server did not respond. Check that it is running and reachable from this network.")
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected:
            return .problem("The server’s HTTPS certificate is not trusted by this iPhone. Use a valid certificate, such as Tailscale HTTPS or a Cloudflare Tunnel.")
        case .appTransportSecurityRequiresSecureConnection:
            return .problem("The address redirected to an insecure http:// page. Use the final https:// address.")
        default:
            return .problem("Could not reach the server. \(error.localizedDescription)")
        }
    }

    static func run(_ url: URL, session: URLSession = .shared, interpret: (Int, Data) -> Outcome) async -> Outcome {
        let request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return .problem("The server did not return a web response.") }
            return interpret(http.statusCode, data)
        } catch {
            return transport(error)
        }
    }

    private static let notReady = Outcome.problem("The voice service answered but is not ready. Check the speech (STT and TTS) settings in your Hermes dashboard.")
}
