import SwiftUI

struct CallSheet: View {
    let url: URL
    let botName: String
    var avatarName: String = "hermes"
    let onClose: () -> Void
    var onOpenComputer: (() -> Void)? = nil
    var onOpenExternalURL: (URL) -> Void = { url in UIApplication.shared.open(url) }

    var body: some View {
        TelegramMiniAppView(
            url: url,
            botName: botName,
            avatarName: avatarName,
            onClose: onClose,
            onOpenComputer: onOpenComputer,
            onOpenExternalURL: onOpenExternalURL
        )
    }
}
