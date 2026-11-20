import SwiftUI

/// Alan's Way: the agent's conversations. Opens a chat, starts a new one, shows the link and the unsent messages.
struct GatewayHomeView: View {
    var onSetUpTelegram: (() -> Void)?
    @Environment(GatewayStore.self) private var gateway
    @State private var showSettings = false
    @State private var path: [String] = []
    @State private var errorText: String?
    @State private var creating = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("YOUR WORKSPACE").font(.system(.caption2, design: .monospaced, weight: .medium)).tracking(2).foregroundStyle(WorkspaceTheme.secondary)
                            Text("Alan’s Way").font(.system(.largeTitle, design: .serif, weight: .medium)).tracking(-0.7)
                        }
                        Spacer()
                        Button { showSettings = true } label: {
                            Image(systemName: "slider.horizontal.3").font(.system(size: 19)).frame(width: 46, height: 46).background(WorkspaceTheme.surface, in: Circle())
                        }.accessibilityLabel("Alan’s Way settings").accessibilityIdentifier("gatewaySettings")
                    }

                    HStack(spacing: 7) {
                        Circle().fill(WorkspaceTheme.mint).frame(width: 5, height: 5)
                        Text("Your conversations, straight from Hermes").font(.caption).foregroundStyle(WorkspaceTheme.secondary)
                    }

                    list

                    Button(action: newConversation) {
                        HStack(spacing: 10) {
                            if creating { ProgressView() } else { Image(systemName: "plus").font(.system(size: 15)) }
                            Text("New conversation").font(.subheadline.weight(.medium))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, 12)
                        .overlay(RoundedRectangle(cornerRadius: 20).stroke(WorkspaceTheme.line, style: StrokeStyle(lineWidth: 1, dash: [5, 5])))
                    }
                    .foregroundStyle(WorkspaceTheme.secondary).disabled(creating || gateway.linkState != .live)
                    .accessibilityIdentifier("gatewayNewConversation")
                }
                .padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 40)
                .frame(maxWidth: 720).frame(maxWidth: .infinity)
            }
            .background(WorkspaceTheme.background)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable { await gateway.refreshConversations() }
            .safeAreaInset(edge: .top, spacing: 0) { GatewayBanner() }
            .navigationDestination(for: String.self) { GatewayChatView(conversationID: $0) }
            .sheet(isPresented: $showSettings) {
                NavigationStack { GatewaySettingsView(showsDone: true, onSetUpTelegram: onSetUpTelegram) }
            }
            .alert("Could not complete that", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
                Button("OK") { errorText = nil }
            } message: { Text(errorText ?? "") }
        }
    }

    @ViewBuilder private var list: some View {
        if gateway.conversations.isEmpty {
            if gateway.linkState == .live && !gateway.isLoadingConversations && gateway.conversationsError == nil {
                ContentUnavailableView {
                    Label("Start your first conversation", systemImage: "bubble.left.and.bubble.right")
                } description: { Text("Alan keeps every conversation on your Hermes machine.") }.padding(.top, 25)
            } else if let error = gateway.conversationsError {
                ContentUnavailableView { Label(error, systemImage: "exclamationmark.triangle") } actions: {
                    Button("Try again") { Task { await gateway.refreshConversations() } }
                }.padding(.top, 25)
            } else {
                ProgressView(gateway.linkState == .live ? "Loading your conversations…" : "Waiting for the connection to Hermes…")
                    .frame(maxWidth: .infinity).padding(.top, 60)
            }
        } else {
            LazyVStack(spacing: 10) {
                ForEach(gateway.conversations) { conversation in
                    NavigationLink(value: conversation.id) { GatewayConversationRow(conversation: conversation) }
                        .buttonStyle(.plain).accessibilityIdentifier("gatewayConversation-\(conversation.id)")
                }
            }
        }
    }

    private func newConversation() {
        creating = true
        Task {
            defer { creating = false }
            do { path.append(try await gateway.newConversation()) }
            catch { errorText = "A new conversation could not be started. Check the connection and try again." }
        }
    }
}

struct GatewayConversationRow: View {
    let conversation: GatewayConversation

    var body: some View {
        HStack(spacing: 16) {
            AgentPortrait(name: "hermes", size: 68)
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text(conversation.title).font(.headline).lineLimit(2)
                    Spacer(minLength: 0)
                    if let date = conversation.lastActive {
                        Text(GatewayFormat.short(date)).font(.system(.caption2, design: .monospaced)).foregroundStyle(WorkspaceTheme.secondary)
                    }
                }
                Text(conversation.preview.isEmpty ? "Pick up your conversation" : conversation.preview)
                    .font(.footnote).foregroundStyle(WorkspaceTheme.secondary).lineLimit(2).lineSpacing(3)
            }
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(WorkspaceTheme.secondary)
        }
        .padding(16).frame(minHeight: 44)
        .background(WorkspaceTheme.surface).clipShape(RoundedRectangle(cornerRadius: 23))
        .overlay(RoundedRectangle(cornerRadius: 23).stroke(WorkspaceTheme.line, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the conversation")
    }
}

/// The connection line, as the Telegram tab has: say so instead of letting a waiting message look sent.
struct GatewayBanner: View {
    @Environment(GatewayStore.self) private var gateway
    var body: some View {
        if let text = gateway.banner {
            Label(text, systemImage: gateway.linkState == .signin ? "key" : "wifi.exclamationmark")
                .font(.footnote).foregroundStyle(.orange)
                .frame(maxWidth: .infinity).padding(8).background(WorkspaceTheme.surface)
                .accessibilityIdentifier("gatewayConnectionStatus")
        }
    }
}

enum GatewayFormat {
    static func short(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(.dateTime.hour().minute()) : date.formatted(.dateTime.month(.abbreviated).day())
    }
    static func stamp(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(.dateTime.hour().minute()) : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}
