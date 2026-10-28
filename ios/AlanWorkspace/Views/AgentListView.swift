import SwiftUI

struct AgentListView: View {
    @Environment(TelegramStore.self) private var telegram
    @Environment(WorkspaceSettings.self) private var settings
    @State private var search = ""
    @State private var showSettings = false
    @State private var showAddBot = false
    @State private var botUsername = ""
    @State private var errorText: String?

    private var agents: [TelegramChat] {
        telegram.chats.filter { $0.isBot && (search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || ($0.username?.localizedCaseInsensitiveContains(search) ?? false)) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("YOUR WORKSPACE").font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(2)
                                .foregroundStyle(WorkspaceTheme.secondary)
                            Text("Your agents").font(.system(size: 36, weight: .medium, design: .serif)).tracking(-0.7)
                        }
                        Spacer()
                        Button { showSettings = true } label: {
                            Image(systemName: "slider.horizontal.3").font(.system(size: 19)).frame(width: 46, height: 46)
                                .background(WorkspaceTheme.surface, in: Circle())
                        }.accessibilityLabel("Workspace settings").accessibilityIdentifier("workspaceSettings")
                    }

                    HStack(spacing: 11) {
                        Image(systemName: "magnifyingglass").foregroundStyle(WorkspaceTheme.secondary)
                        TextField("Find an agent", text: $search).font(.system(size: 15))
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }.modifier(WorkspaceField())

                    HStack(spacing: 7) {
                        Circle().fill(WorkspaceTheme.mint).frame(width: 5, height: 5)
                        Text("Your conversations, connected through Telegram")
                            .font(.system(size: 11)).foregroundStyle(WorkspaceTheme.secondary)
                    }

                    if telegram.isLoadingChats && agents.isEmpty {
                        ProgressView("Loading your conversations…").frame(maxWidth: .infinity).padding(.top, 60)
                    } else if agents.isEmpty {
                        ContentUnavailableView {
                            Label(search.isEmpty ? "Your agents belong here" : "No matching agents", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(search.isEmpty ? "Open an existing Hermes bot by its Telegram username, or pull down to refresh your chats." : "Try another name or username.")
                        } actions: {
                            if search.isEmpty { Button("Open a bot") { showAddBot = true } }
                        }
                        .padding(.top, 25)
                    } else {
                        LazyVStack(spacing: 10) {
                            ForEach(agents) { chat in
                                NavigationLink {
                                    ConversationView(chat: chat)
                                } label: {
                                    AgentRow(chat: chat, avatar: settings.avatar(for: chat.id))
                                }.buttonStyle(.plain).accessibilityIdentifier("agentChat-\(chat.id)")
                            }
                        }
                    }

                    Button { showAddBot = true } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus").font(.system(size: 15))
                            Text("Open another bot").font(.system(size: 14, weight: .medium))
                        }.frame(maxWidth: .infinity).padding(.vertical, 20)
                            .overlay(RoundedRectangle(cornerRadius: 20).stroke(WorkspaceTheme.line, style: StrokeStyle(lineWidth: 1, dash: [5, 5])))
                    }.foregroundStyle(WorkspaceTheme.secondary)
                }
                .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 40)
                .frame(maxWidth: 720).frame(maxWidth: .infinity)
            }
            .background(WorkspaceTheme.background)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await refresh() }
            .task { await refresh() }
            .sheet(isPresented: $showSettings) { WorkspaceSettingsView() }
            .alert("Open a Telegram bot", isPresented: $showAddBot) {
                TextField("@username", text: $botUsername).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Open") {
                    Task {
                        do { _ = try await telegram.openBot(username: botUsername); botUsername = "" }
                        catch { errorText = error.localizedDescription }
                    }
                }
                Button("Cancel", role: .cancel) { botUsername = "" }
            } message: { Text("Use the username of your existing Hermes bot.") }
            .alert("Connection needs attention", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK") { errorText = nil }
            } message: { Text(errorText ?? "") }
        }
    }

    private func refresh() async {
        guard !telegram.isInterfacePreview else { return }
        do { try await telegram.loadChats() }
        catch { errorText = error.localizedDescription }
    }
}

private struct AgentRow: View {
    let chat: TelegramChat
    let avatar: String

    var body: some View {
        HStack(spacing: 16) {
            AgentPortrait(name: avatar, size: 68)
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text(chat.title).font(.system(size: 17, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 0)
                    if chat.unreadCount > 0 {
                        Text(chat.unreadCount > 99 ? "99+" : "\(chat.unreadCount)")
                            .font(.system(size: 10, weight: .bold)).foregroundStyle(WorkspaceTheme.background)
                            .padding(.horizontal, 6).padding(.vertical, 3).background(WorkspaceTheme.mint, in: Capsule())
                    }
                }
                Text(chat.lastMessagePreview.isEmpty ? "Pick up your conversation" : chat.lastMessagePreview)
                    .font(.system(size: 13)).foregroundStyle(WorkspaceTheme.secondary).lineLimit(2).lineSpacing(3)
            }
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(WorkspaceTheme.secondary)
        }
        .padding(16)
        .background(WorkspaceTheme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 23))
        .overlay(RoundedRectangle(cornerRadius: 23).stroke(WorkspaceTheme.line, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
}

struct WorkspaceSettingsView: View {
    @Environment(TelegramStore.self) private var telegram
    @Environment(\.dismiss) private var dismiss
    @State private var confirmLogOut = false
    @State private var errorText: String?
    @State private var diagnosticsReport: URL?
    @State private var diagnosticsCount = 0

    var body: some View {
        NavigationStack {
            List {
                Section("Your workspace") {
                    Label("Existing Telegram conversations", systemImage: "bubble.left.and.bubble.right")
                    Label("Calls stay in the foreground", systemImage: "waveform")
                    Label("Computer access is set per agent", systemImage: "desktopcomputer")
                }.listRowBackground(WorkspaceTheme.surface)
                Section {
                    Link("Telegram privacy policy", destination: URL(string: "https://telegram.org/privacy")!)
                    Link("Alan’s Workspace source", destination: URL(string: "https://github.com/capthvnsen/alans-way")!)
                    NavigationLink("Open source licenses") { LicenseNoticesView() }
                }.listRowBackground(WorkspaceTheme.surface)
                Section {
                    Button("Sign out of this device", role: .destructive) { confirmLogOut = true }
                } footer: {
                    Text("Signing out removes this device’s Telegram session. Your account and conversations remain in Telegram.")
                }.listRowBackground(WorkspaceTheme.surface)
                Section {
                    if let diagnosticsReport {
                        ShareLink(item: diagnosticsReport) { Label("Share crash and hang reports (\(diagnosticsCount))", systemImage: "square.and.arrow.up") }
                        Button("Delete reports", role: .destructive) {
                            DiagnosticsStore.shared.clear()
                            self.diagnosticsReport = nil
                        }
                    } else {
                        Text("No crash or hang reports on this device").foregroundStyle(WorkspaceTheme.secondary)
                    }
                } header: {
                    Text("Diagnostics")
                } footer: {
                    Text("Apple’s MetricKit delivers crash and hang reports to the app. They stay on this device until you share them; nothing is uploaded automatically.")
                }.listRowBackground(WorkspaceTheme.surface)
                Section { Text("Alan’s Workspace · \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")").font(.footnote).foregroundStyle(WorkspaceTheme.secondary) }
                    .listRowBackground(WorkspaceTheme.surface)
            }
            .scrollContentBackground(.hidden).background(WorkspaceTheme.background)
            .navigationTitle("Workspace").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                diagnosticsCount = DiagnosticsStore.shared.reportFiles().count
                diagnosticsReport = diagnosticsCount > 0 ? try? DiagnosticsStore.shared.exportReport() : nil
            }
            .confirmationDialog("Sign out of Telegram on this device?", isPresented: $confirmLogOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        do { try await telegram.logOut(); dismiss() }
                        catch { errorText = error.localizedDescription }
                    }
                }
            }
            .alert("Could not sign out", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK") { errorText = nil }
            } message: { Text(errorText ?? "") }
        }
    }
}

private struct LicenseNoticesView: View {
    private var notices: String {
        guard let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "License notices are unavailable in this build." }
        return text
    }
    var body: some View {
        ScrollView {
            Text(notices).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).padding(20)
        }.background(WorkspaceTheme.background).navigationTitle("Licenses").navigationBarTitleDisplayMode(.inline)
    }
}
