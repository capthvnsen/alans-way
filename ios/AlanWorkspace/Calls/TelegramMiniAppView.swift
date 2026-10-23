import AVFoundation
import SwiftUI
import UIKit
import WebKit

/// Hosts a Telegram Web App URL returned by the authenticated Telegram client.
/// This view never creates or signs Telegram initData itself.
struct TelegramMiniAppView: View {
    let url: URL
    let botName: String
    var avatarName: String = "hermes"
    let onClose: () -> Void
    var onOpenComputer: (() -> Void)? = nil
    var onOpenExternalURL: (URL) -> Void = { url in UIApplication.shared.open(url) }

    @Environment(\.scenePhase) private var scenePhase
    @State private var isLoading = true
    @State private var loadError: CallPageFailure?
    @State private var reloadToken = UUID()

    var body: some View {
        ZStack {
            Color(red: 0.047, green: 0.055, blue: 0.059).ignoresSafeArea()
            if let trustedOrigin = CallOrigin(url: url) {
                if loadError != .contentProcessTerminated {
                    HostedWebView(
                        url: url,
                        origin: trustedOrigin,
                        botName: botName,
                        avatarName: avatarName,
                        reloadToken: reloadToken,
                        onLoadingChanged: { isLoading = $0 },
                        onError: { loadError = $0; isLoading = false },
                        onClose: onClose,
                        onOpenComputer: onOpenComputer,
                        onOpenExternalURL: onOpenExternalURL
                    )
                    .id(reloadToken)
                    .ignoresSafeArea()
                }
            } else {
                invalidLaunch
            }

            if isLoading && loadError == nil && CallOrigin(url: url) != nil {
                loadingOverlay
                    .transition(.opacity)
            }

            if let loadError {
                errorOverlay(loadError)
                    .transition(.opacity)
            }

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .frame(width: 40, height: 40)
                    .background(.black.opacity(0.42), in: Circle())
                    .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close voice call")
            .padding(.top, 8)
            .padding(.trailing, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        }
        .statusBarHidden(true)
        .preferredColorScheme(.dark)
        .onChange(of: scenePhase) { phase in
            switch CallHostLifecycleAction(scenePhase: phase) {
            case .deactivate:
                NotificationCenter.default.post(name: .miniAppHostWillDeactivate, object: nil)
            case .activate:
                NotificationCenter.default.post(name: .miniAppHostDidActivate, object: nil)
            case .none:
                break
            }
        }
    }

    private var loadingOverlay: some View {
        VStack(spacing: 18) {
            Image(avatarName)
                .resizable()
                .scaledToFill()
                .frame(width: 92, height: 92)
                .clipShape(Circle())
                .overlay(Circle().stroke(.white.opacity(0.24), lineWidth: 1))
            ProgressView().tint(Color(red: 0.76, green: 0.66, blue: 0.96))
            Text("Connecting to \(botName)")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text("Preparing your private voice call")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.58))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.047, green: 0.055, blue: 0.059))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connecting to \(botName). Preparing your private voice call.")
    }

    private func errorOverlay(_ failure: CallPageFailure) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 30, weight: .regular))
                .foregroundStyle(Color(red: 0.72, green: 0.88, blue: 0.8))
            Text(failure.title)
                .font(.system(size: 19, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text(failure.message)
                .font(.system(size: 13))
                .foregroundStyle(.white.opacity(0.66))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            HStack(spacing: 12) {
                Button("Close", action: onClose)
                    .buttonStyle(CallSecondaryButtonStyle())
                if failure.canReload {
                    Button("Try again") {
                        loadError = nil
                        isLoading = true
                        reloadToken = UUID()
                    }
                    .buttonStyle(CallPrimaryButtonStyle())
                }
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.047, green: 0.055, blue: 0.059))
    }

    private var invalidLaunch: some View {
        errorOverlay(.invalidLaunch)
    }
}

enum CallPageFailure: Equatable {
    case navigation(String)
    case invalidLaunch
    case contentProcessTerminated

    var title: String {
        self == .contentProcessTerminated ? "Call interrupted" : "Call page unavailable"
    }

    var message: String {
        switch self {
        case .navigation(let message): return message
        case .invalidLaunch: return "The Telegram launch URL must use HTTPS and have a valid website origin."
        case .contentProcessTerminated: return "The call page stopped unexpectedly. Close this screen and start a new call from your chat."
        }
    }

    var canReload: Bool {
        // A crashed page may have consumed its single-use Telegram launch ticket.
        // A fresh call must obtain a fresh launch instead of replaying that URL.
        if case .navigation = self { return true }
        return false
    }
}

struct HostedWebView: UIViewRepresentable {
    let url: URL
    let origin: CallOrigin
    let botName: String
    let avatarName: String
    let reloadToken: UUID
    let onLoadingChanged: (Bool) -> Void
    let onError: (CallPageFailure) -> Void
    let onClose: () -> Void
    let onOpenComputer: (() -> Void)?
    let onOpenExternalURL: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> WKWebView {
        let content = WKUserContentController()
        content.add(context.coordinator, name: "telegramMiniApp")
        content.addUserScript(WKUserScript(
            source: hostBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = content
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.047, green: 0.055, blue: 0.059, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 30))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loadedToken != reloadToken {
            context.coordinator.loadedToken = reloadToken
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
        }
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        if !coordinator.contentProcessTerminated {
            webView.evaluateJavaScript("window.HermesVoiceHangup?.();") { _, _ in
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        coordinator.hostedWebView = nil
        NotificationCenter.default.removeObserver(coordinator)
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "telegramMiniApp")
        webView.configuration.userContentController.removeAllUserScripts()
    }

    private var hostBootstrap: String {
        let presentation: [String: Any] = [
            "botName": botName,
            "avatarName": avatarName,
            "canOpenComputer": onOpenComputer != nil
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: presentation) else {
            return ""
        }
        let base64 = json.base64EncodedString()
        return """
        (() => {
          const hostBytes = Uint8Array.from(atob('\(base64)'), character => character.charCodeAt(0));
          const host = JSON.parse(new TextDecoder().decode(hostBytes));
          Object.defineProperty(window, '__HERMES_HOST__', { value: Object.freeze(host), configurable: false });
          window.TelegramWebviewProxy = window.TelegramWebviewProxy || {};
          window.TelegramWebviewProxy.postEvent = (eventType, eventData) => {
            window.webkit?.messageHandlers?.telegramMiniApp?.postMessage({ eventType, eventData: JSON.stringify(eventData ?? {}) });
          };
        })();
        """
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: HostedWebView
        var loadedToken: UUID
        weak var hostedWebView: WKWebView?
        private var backButtonVisible = false
        private(set) var contentProcessTerminated = false

        init(parent: HostedWebView) {
            self.parent = parent
            self.loadedToken = parent.reloadToken
            super.init()
            NotificationCenter.default.addObserver(self, selector: #selector(hostWillDeactivate), name: .miniAppHostWillDeactivate, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(hostDidActivate), name: .miniAppHostDidActivate, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(audioSessionInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance())
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            handle(message: message)
        }

        private func handle(message: WKScriptMessage) {
            guard message.name == "telegramMiniApp",
                  message.frameInfo.isMainFrame,
                  CallOrigin.matches(message.frameInfo.securityOrigin, origin: parent.origin),
                  let body = message.body as? [String: Any],
                  let event = body["eventType"] as? String,
                  CallBridgePolicy.handles(event),
                  let data = CallBridgePolicy.eventData(body["eventData"]) else {
                return
            }
            switch event {
            case "web_app_ready":
                parent.onLoadingChanged(false)
            case "web_app_request_theme":
                sendTheme()
            case "web_app_request_viewport":
                sendViewport()
            case "web_app_request_safe_area":
                sendSafeArea(event: "safe_area_changed")
            case "web_app_request_content_safe_area":
                sendSafeArea(event: "content_safe_area_changed")
            case "web_app_expand", "web_app_request_fullscreen":
                sendViewport(isExpanded: true)
                if event == "web_app_request_fullscreen" { send(event: "fullscreen_changed", data: ["is_fullscreen": true]) }
            case "web_app_exit_fullscreen":
                send(event: "fullscreen_changed", data: ["is_fullscreen": false])
            case "web_app_trigger_haptic_feedback":
                performHaptic(data)
            case "web_app_setup_back_button":
                backButtonVisible = data["is_visible"] as? Bool ?? false
                send(event: "back_button_state_changed", data: ["is_visible": backButtonVisible])
            case "web_app_close":
                parent.onClose()
            case "hermes_open_computer":
                parent.onOpenComputer?()
            case "web_app_set_background_color", "web_app_set_header_color", "web_app_setup_closing_behavior", "web_app_set_bottom_bar_color", "web_app_setup_swipe_behavior", "web_app_setup_settings_button":
                // Host presentation is already full-screen; these have no native action here.
                break
            default:
                // Never forward unknown events or expose arbitrary native methods.
                break
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            self.hostedWebView = webView
            parent.onLoadingChanged(true)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            self.hostedWebView = webView
            parent.onLoadingChanged(false)
            sendTheme()
            sendViewport()
            sendSafeArea(event: "safe_area_changed")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            parent.onError(.navigation(error.localizedDescription))
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            parent.onError(.navigation(error.localizedDescription))
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            contentProcessTerminated = true
            hostedWebView = nil
            webView.stopLoading()
            webView.setMicrophoneCaptureState(.none)
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            parent.onLoadingChanged(false)
            parent.onError(.contentProcessTerminated)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let destination = navigationAction.request.url else { decisionHandler(.cancel); return }
            if parent.origin.contains(destination) {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated,
               navigationAction.targetFrame?.isMainFrame != false,
               CallBridgePolicy.allowsExternalLink(destination) {
                parent.onOpenExternalURL(destination)
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let destination = navigationAction.request.url,
                  !parent.origin.contains(destination),
                  navigationAction.navigationType == .linkActivated,
                  CallBridgePolicy.allowsExternalLink(destination) else { return nil }
            parent.onOpenExternalURL(destination)
            return nil
        }

        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            guard type == .microphone,
                  CallOrigin.matches(origin, origin: parent.origin),
                  CallOrigin.matches(frame.securityOrigin, origin: parent.origin) else {
                decisionHandler(.deny)
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { [weak self, weak webView] granted in
                DispatchQueue.main.async {
                    guard let self, let webView, self.hostedWebView === webView else {
                        decisionHandler(.deny)
                        return
                    }
                    guard granted else { decisionHandler(.deny); return }
                    do {
                        let session = AVAudioSession.sharedInstance()
                        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
                        try session.setActive(true)
                        decisionHandler(.grant)
                    } catch {
                        decisionHandler(.deny)
                    }
                }
            }
        }

        private func sendTheme() {
            let traits = UITraitCollection.current.userInterfaceStyle
            let theme: [String: Any] = [
                "bg_color": "#0c0e0f", "secondary_bg_color": "#151918",
                "text_color": "#f4f6f4", "hint_color": "#9aa39e",
                "button_color": "#b8e0cc", "button_text_color": "#14221a",
                "header_bg_color": "#0c0e0f", "section_bg_color": "#151918",
                "accent_text_color": "#b8e0cc", "destructive_text_color": "#ef5867",
                "section_header_text_color": "#a8b9af", "subtitle_text_color": "#9aa39e",
                "section_separator_color": "#292e2b", "bottom_bar_bg_color": "#0c0e0f",
                "is_dark": traits == .dark
            ]
            send(event: "theme_changed", data: ["theme_params": theme])
        }

        private func sendViewport(isExpanded: Bool = true) {
            let bounds = hostedWebView?.bounds ?? UIScreen.main.bounds
            let height = max(0, bounds.height)
            send(event: "viewport_changed", data: [
                "width": bounds.width, "height": height, "stable_height": height,
                "is_expanded": isExpanded, "is_state_stable": true
            ])
        }

        private func sendSafeArea(event: String) {
            let insets = hostedWebView?.safeAreaInsets ?? .zero
            send(event: event, data: ["top": insets.top, "bottom": insets.bottom, "left": insets.left, "right": insets.right])
        }

        private func send(event: String, data: [String: Any]) {
            guard let webView = hostedWebView,
                  let json = try? JSONSerialization.data(withJSONObject: data, options: [.fragmentsAllowed]),
                  let value = String(data: json, encoding: .utf8) else { return }
            let source = "(() => { const bytes = Uint8Array.from(atob('\(Data(value.utf8).base64EncodedString())'), character => character.charCodeAt(0)); window.Telegram?.WebView?.receiveEvent?.('\(event)', JSON.parse(new TextDecoder().decode(bytes))); })();"
            webView.evaluateJavaScript(source, completionHandler: nil)
        }

        private func performHaptic(_ data: [String: Any]) {
            guard let type = data["type"] as? String else { return }
            switch type {
            case "impact":
                let styleName = data["impact_style"] as? String ?? "light"
                let style: UIImpactFeedbackGenerator.FeedbackStyle = styleName == "heavy" ? .heavy : styleName == "medium" ? .medium : .light
                UIImpactFeedbackGenerator(style: style).impactOccurred()
            case "notification":
                let kind = data["notification_type"] as? String ?? "success"
                UINotificationFeedbackGenerator().notificationOccurred(kind == "error" ? .error : kind == "warning" ? .warning : .success)
            case "selection":
                UISelectionFeedbackGenerator().selectionChanged()
            default:
                break
            }
        }

        @objc private func hostWillDeactivate() {
            guard let webView = hostedWebView else { return }
            send(event: "deactivated", data: [:])
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('HermesHostLifecycle', {detail:{state:'background'}}));") { _, _ in
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }

        @objc private func hostDidActivate() {
            send(event: "activated", data: [:])
            hostedWebView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('HermesHostLifecycle', {detail:{state:'active'}}));")
        }

        @objc private func audioSessionInterrupted(_ notification: Notification) {
            guard let rawType = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }
            let interrupted = type == .began
            let resumable = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map { AVAudioSession.InterruptionOptions(rawValue: $0).contains(.shouldResume) } ?? false
            let data = "{interrupted:\(interrupted),shouldResume:\(resumable)}"
            hostedWebView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('HermesHostAudioInterruption', {detail:\(data)}));")
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }
    }
}

private extension Notification.Name {
    static let miniAppHostWillDeactivate = Notification.Name("TelegramMiniAppHostWillDeactivate")
    static let miniAppHostDidActivate = Notification.Name("TelegramMiniAppHostDidActivate")
}

/// Normalized, exact web origin used to constrain navigation and native messages.
struct CallOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int

    init?(url: URL) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased(), scheme == "https",
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = components.port ?? 443
    }

    func contains(_ url: URL) -> Bool {
        guard let candidate = CallOrigin(url: url) else { return false }
        return self == candidate
    }

    static func matches(_ securityOrigin: WKSecurityOrigin, origin: CallOrigin) -> Bool {
        let scheme = securityOrigin.protocol.lowercased()
        let host = securityOrigin.host.lowercased()
        let port = securityOrigin.port == 0 ? 443 : securityOrigin.port
        return origin.scheme == scheme && origin.host == host && origin.port == port
    }
}

enum CallBridgePolicy {
    private static let acceptedEvents: Set<String> = [
        "web_app_ready", "web_app_request_theme", "web_app_request_viewport",
        "web_app_request_safe_area", "web_app_request_content_safe_area",
        "web_app_expand", "web_app_request_fullscreen", "web_app_exit_fullscreen",
        "web_app_trigger_haptic_feedback", "web_app_setup_back_button", "web_app_close",
        "web_app_set_background_color", "web_app_set_header_color",
        "web_app_setup_closing_behavior", "web_app_set_bottom_bar_color",
        "web_app_setup_swipe_behavior", "web_app_setup_settings_button",
        "hermes_open_computer"
    ]

    static func handles(_ event: String) -> Bool {
        acceptedEvents.contains(event)
    }

    static func eventData(_ value: Any?) -> [String: Any]? {
        guard let value else { return [:] }
        if value is NSNull { return [:] }
        if let dictionary = value as? [String: Any] { return dictionary }
        guard let string = value as? String,
              let data = string.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any] else { return nil }
        return dictionary
    }

    static func allowsExternalLink(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil else { return false }
        switch components.scheme?.lowercased() {
        case "https": return components.host?.isEmpty == false
        case "mailto", "tel": return !components.path.isEmpty
        default: return false
        }
    }
}

enum CallHostLifecycleAction: Equatable {
    case none
    case activate
    case deactivate

    init(scenePhase: ScenePhase) {
        switch scenePhase {
        case .active: self = .activate
        case .background: self = .deactivate
        case .inactive: self = .none
        @unknown default: self = .none
        }
    }
}

private struct CallPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .foregroundStyle(Color(red: 0.08, green: 0.13, blue: 0.1))
            .background(Color(red: 0.72, green: 0.88, blue: 0.8), in: Capsule())
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

private struct CallSecondaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .padding(.horizontal, 16).padding(.vertical, 10)
            .foregroundStyle(.white.opacity(0.85))
            .background(.white.opacity(0.1), in: Capsule())
            .opacity(configuration.isPressed ? 0.65 : 1)
    }
}
