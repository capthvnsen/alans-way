import SwiftUI
import WebKit

struct ComputerView: View {
    let chatID: Int64
    let botName: String
    @Environment(WorkspaceSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var showSettings = false
    @State private var reloadID = UUID()
    @State private var loadError: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Group {
                if let url = settings.viewerURL(for: chatID) {
                    ZStack {
                        ComputerWebView(url: url, onLoading: { loading = $0 }, onError: { loadError = $0; loading = false }).id(reloadID)
                        if loading { ProgressView("Connecting to computer…").padding(22).background(WorkspaceTheme.surface, in: RoundedRectangle(cornerRadius: 18)) }
                        if let loadError {
                            ContentUnavailableView {
                                Label("Computer unavailable", systemImage: "wifi.exclamationmark")
                            } description: {
                                Text(loadError)
                            } actions: {
                                Button("Reconnect") { reconnect() }
                            }.background(WorkspaceTheme.background)
                        }
                    }
                } else {
                    VStack(spacing: 22) {
                        Image(systemName: "desktopcomputer").font(.system(size: 48, weight: .ultraLight)).foregroundStyle(WorkspaceTheme.mint)
                        Text("A window into their work.").font(.system(size: 26, weight: .medium, design: .serif))
                        Text("Connect \(botName)’s existing desktop viewer to see what your agent is doing, wherever you are.")
                            .font(.system(size: 14)).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(5).multilineTextAlignment(.center)
                        Button("Connect computer") { showSettings = true }.buttonStyle(WorkspacePrimaryButton()).padding(.top, 6)
                    }.padding(32).frame(maxWidth: 480).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(WorkspaceTheme.background)
            .navigationTitle("\(botName)’s computer").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if settings.viewerURL(for: chatID) != nil {
                        Button { reconnect() } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Reconnect viewer")
                    }
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Computer connection settings")
                }
            }
            .sheet(isPresented: $showSettings) { ViewerSettingsView(chatID: chatID, botName: botName) }
            .onChange(of: settings.viewerURL(for: chatID)) { _, _ in reconnect() }
        }
    }

    private func reconnect() { loadError = nil; loading = true; reloadID = UUID() }
}

private struct ComputerWebView: UIViewRepresentable {
    let url: URL
    let onLoading: (Bool) -> Void
    let onError: (String) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = UIColor(WorkspaceTheme.background)
        view.scrollView.backgroundColor = UIColor(WorkspaceTheme.background)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(origin: url, onLoading: onLoading, onError: onError) }
    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        uiView.stopLoading()
        uiView.loadHTMLString("", baseURL: nil)
        uiView.navigationDelegate = nil
        uiView.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let origin: URL
        let onLoading: (Bool) -> Void
        let onError: (String) -> Void
        init(origin: URL, onLoading: @escaping (Bool) -> Void, onError: @escaping (String) -> Void) {
            self.origin = origin; self.onLoading = onLoading; self.onError = onError
        }
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { onLoading(true) }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onLoading(false) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { onError("Check that the computer is running and that Tailscale is connected, then reconnect.") }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { onError("Check the viewer address and your private network connection, then reconnect.") }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
            // A user-supplied viewer has no native bridge. Restrict top-level changes
            // so a remote desktop page cannot repurpose this sheet for another origin.
            let allowed = url.scheme == "https" && url.host == origin.host && url.port == origin.port
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.deny)
        }
    }
}

struct AgentSettingsView: View {
    let chat: TelegramChat
    @Environment(WorkspaceSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(chat.title).font(.system(size: 30, weight: .medium, design: .serif))
                        if let username = chat.username { Text("@\(username)").font(.footnote).foregroundStyle(WorkspaceTheme.secondary) }
                    }
                    Text("CHOOSE THEIR FACE").font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(2).foregroundStyle(WorkspaceTheme.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84))], spacing: 16) {
                        ForEach(WorkspaceSettings.availableAvatars, id: \.self) { avatar in
                            Button { settings.setAvatar(avatar, for: chat.id) } label: {
                                VStack(spacing: 8) {
                                    AgentPortrait(name: avatar, size: 78)
                                        .overlay(RoundedRectangle(cornerRadius: 24).stroke(settings.avatar(for: chat.id) == avatar ? WorkspaceTheme.mint : .clear, lineWidth: 2))
                                    Text(avatar.capitalized).font(.system(size: 11)).foregroundStyle(WorkspaceTheme.secondary)
                                }
                            }.accessibilityLabel("\(avatar.capitalized) avatar")
                                .accessibilityValue(settings.avatar(for: chat.id) == avatar ? "Selected" : "")
                        }
                    }
                    Text("Your avatar choice appears in this app and its call screen. Your bot’s Telegram profile stays as it is.")
                        .font(.caption).foregroundStyle(WorkspaceTheme.secondary).lineSpacing(4)
                    NavigationLink { ViewerSettingsView(chatID: chat.id, botName: chat.title) } label: {
                        Label("Computer connection", systemImage: "desktopcomputer").frame(maxWidth: .infinity, alignment: .leading).padding(18)
                            .background(WorkspaceTheme.surface, in: RoundedRectangle(cornerRadius: 18))
                    }
                }.padding(24)
            }
            .background(WorkspaceTheme.background)
            .navigationTitle("Agent").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct ViewerSettingsView: View {
    let chatID: Int64
    let botName: String
    @Environment(WorkspaceSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://computer.example.ts.net/vnc.html", text: $address, axis: .vertical)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityIdentifier("computerViewerAddress")
                } header: {
                    Text("\(botName)’s desktop viewer")
                } footer: {
                    Text("Use the HTTPS address of your existing noVNC viewer. If it is on your tailnet, connect Tailscale on this iPhone first. Sign in through the viewer when asked.")
                }.listRowBackground(WorkspaceTheme.surface)
                Section {
                    Label("Your agent computer must be running", systemImage: "power")
                    Label("This opens the viewer you configure", systemImage: "network")
                }.font(.footnote).listRowBackground(WorkspaceTheme.surface)
                if let errorText { Section { Text(errorText).font(.footnote).foregroundStyle(.orange) }.listRowBackground(WorkspaceTheme.surface) }
            }
            .scrollContentBackground(.hidden).background(WorkspaceTheme.background)
            .navigationTitle("Computer connection").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if settings.setViewerAddress(address, for: chatID) { dismiss() }
                        else { errorText = "Enter a valid HTTPS address without a username or password in the URL." }
                    }.accessibilityIdentifier("saveComputerConnection")
                }
            }
            .onAppear { address = settings.viewerAddress(for: chatID) }
        }
    }
}
