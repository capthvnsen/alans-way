import Foundation
import Observation

enum ViewerAddress {
    /// The browser viewer is user-selected. Credentials belong in the viewer's login,
    /// not a URL that can be copied into settings or diagnostics.
    static func parse(_ input: String) -> URL? {
        guard let url = URL(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil else { return nil }
        return url
    }
}

@MainActor @Observable
final class WorkspaceSettings {
    private let defaults: UserDefaults
    private var viewers: [String: String]
    private var avatars: [String: String]
    private(set) var hasCompletedOnboarding: Bool
    static let availableAvatars = ["hermes", "athena", "apollo", "artemis", "zeus", "poseidon", "hades", "medusa", "faun", "minotaur"]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        viewers = defaults.dictionary(forKey: "workspace.viewerURLs") as? [String: String] ?? [:]
        avatars = defaults.dictionary(forKey: "workspace.avatars") as? [String: String] ?? [:]
        hasCompletedOnboarding = defaults.bool(forKey: "workspace.onboardingComplete")
    }

    func completeOnboarding() {
        hasCompletedOnboarding = true
        defaults.set(true, forKey: "workspace.onboardingComplete")
    }

    func avatar(for chatID: Int64) -> String { avatars[String(chatID)] ?? "hermes" }
    func setAvatar(_ avatar: String, for chatID: Int64) {
        guard Self.availableAvatars.contains(avatar) else { return }
        avatars[String(chatID)] = avatar
        defaults.set(avatars, forKey: "workspace.avatars")
    }
    func viewerURL(for chatID: Int64) -> URL? { viewers[String(chatID)].flatMap(ViewerAddress.parse) }
    func viewerAddress(for chatID: Int64) -> String { viewers[String(chatID)] ?? "" }
    func hasMiniAppConsent(chatID: Int64, accountID: Int64?, host: String?) -> Bool {
        guard let accountID, let host else { return false }
        return defaults.bool(forKey: "workspace.miniAppConsent.\(accountID).\(chatID).\(host.lowercased())")
    }
    func grantMiniAppConsent(chatID: Int64, accountID: Int64?, host: String?) {
        guard let accountID, let host else { return }
        defaults.set(true, forKey: "workspace.miniAppConsent.\(accountID).\(chatID).\(host.lowercased())")
    }
    @discardableResult
    func setViewerAddress(_ address: String, for chatID: Int64) -> Bool {
        let clean = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.isEmpty || ViewerAddress.parse(clean) != nil else { return false }
        viewers[String(chatID)] = clean.isEmpty ? nil : clean
        defaults.set(viewers, forKey: "workspace.viewerURLs")
        return true
    }
}
