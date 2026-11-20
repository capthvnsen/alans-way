import SwiftUI

struct GatewayChatView: View {
    let conversationID: String
    @Environment(GatewayStore.self) private var gateway
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var atBottom = true
    @State private var errorText: String?
    @FocusState private var composerFocused: Bool
    @ScaledMetric(relativeTo: .body) private var composerSize: CGFloat = 15

    private var messages: [GatewayMessage] { gateway.messages(for: conversationID) }
    private var thread: GatewayThread { gateway.thread(conversationID) }
    private var title: String { gateway.conversations.first { $0.id == conversationID }?.title ?? "Conversation" }
    private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(WorkspaceTheme.line).frame(height: 0.5)
            GatewayBanner()
            timeline
            if let notice = thread.notice {
                Label(notice, systemImage: "info.circle").font(.footnote).foregroundStyle(WorkspaceTheme.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.vertical, 6)
                    .accessibilityIdentifier("gatewayNotice")
            }
            composer
        }
        .background(WorkspaceTheme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarBackground(WorkspaceTheme.background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 10) {
                    AgentPortrait(name: "hermes", size: 34)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                        Text("Alan’s Way").font(.caption2).foregroundStyle(WorkspaceTheme.secondary)
                    }
                }
                .accessibilityElement(children: .combine).accessibilityLabel("\(title), Alan’s Way")
            }
        }
        .task(id: conversationID) { gateway.open(conversationID) }
        .onChange(of: scenePhase) { _, phase in if phase == .active { gateway.reload(conversationID) } }
        .alert("Could not complete that", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("OK") { errorText = nil }
        } message: { Text(errorText ?? "") }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if messages.isEmpty {
                        if thread.isLoading {
                            ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 70)
                        } else if let error = thread.loadError {
                            VStack(spacing: 14) {
                                Text(error).font(.callout).foregroundStyle(WorkspaceTheme.secondary).multilineTextAlignment(.center)
                                Button("Try again") { gateway.reload(conversationID) }.frame(minHeight: 44)
                            }.frame(maxWidth: .infinity).padding(.top, 70)
                        } else {
                            VStack(spacing: 18) {
                                AgentPortrait(name: "hermes", size: 100)
                                Text("Say something to Alan.").font(.system(.title2, design: .serif, weight: .medium))
                                Text("Your message and Alan’s reply stay on your Hermes machine.")
                                    .font(.footnote).foregroundStyle(WorkspaceTheme.secondary).multilineTextAlignment(.center).lineSpacing(4)
                            }.frame(maxWidth: .infinity).padding(.top, 80)
                        }
                    }
                    ForEach(messages) { message in
                        GatewayBubble(message: message, onCancel: { gateway.cancel(message.id) }, onRetry: { gateway.retry(message.id) })
                            .id(message.id)
                    }
                    if thread.busy && messages.last?.isStreaming != true { replyingRow }
                    Color.clear.frame(height: 1).id("gateway-bottom")
                        .onAppear { atBottom = true }.onDisappear { atBottom = false }
                }.padding(.horizontal, 20).padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.id) { _, _ in scrollToBottom(proxy) }
            .onChange(of: messages.last?.text) { _, _ in if atBottom { scrollToBottom(proxy, animated: false) } }
            .onChange(of: thread.busy) { _, _ in if atBottom { scrollToBottom(proxy) } }
            .onChange(of: composerFocused) { _, focused in if focused { scrollToBottom(proxy) } }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom {
                    Button { scrollToBottom(proxy) } label: {
                        Image(systemName: "arrow.down").font(.system(size: 16, weight: .semibold)).frame(width: 44, height: 44)
                            .background(WorkspaceTheme.raised, in: Circle()).overlay(Circle().stroke(WorkspaceTheme.line))
                    }
                    .padding(16).accessibilityLabel("Scroll to the latest message").accessibilityIdentifier("gatewayScrollToBottom")
                }
            }
        }
    }

    private var replyingRow: some View {
        HStack(spacing: 10) {
            AgentPortrait(name: "hermes", size: 23)
            Text(thread.statusLine ?? "Alan is replying…").font(.footnote).foregroundStyle(WorkspaceTheme.secondary)
            Spacer(minLength: 0)
            Button("Stop") { gateway.stopReply(conversationID) }.font(.footnote.weight(.medium)).frame(minWidth: 44, minHeight: 44)
                .accessibilityLabel("Stop the reply").accessibilityIdentifier("gatewayStop")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("gatewayReplying")
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            TextField("Message Alan", text: $draft, axis: .vertical)
                .font(.system(size: composerSize)).lineLimit(1...6).focused($composerFocused)
                .padding(.vertical, 12).padding(.leading, 6)
                .accessibilityLabel("Message Alan").accessibilityIdentifier("gatewayComposer")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(WorkspaceTheme.background).frame(width: 36, height: 36)
                    .background(WorkspaceTheme.mint, in: Circle()).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .disabled(!canSend).opacity(canSend ? 1 : 0.4)
            .accessibilityLabel("Send message").accessibilityIdentifier("gatewaySend")
        }
        .padding(.horizontal, 12).padding(.vertical, 2)
        .background(WorkspaceTheme.surface, in: RoundedRectangle(cornerRadius: 26))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(WorkspaceTheme.line))
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        .background(WorkspaceTheme.background)
    }

    private func send() {
        let text = draft
        do { try gateway.send(text, to: conversationID); draft = "" }
        catch { errorText = error.localizedDescription }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated && !reduceMotion { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("gateway-bottom", anchor: .bottom) } }
        else { proxy.scrollTo("gateway-bottom", anchor: .bottom) }
    }
}

private struct GatewayBubble: View {
    let message: GatewayMessage
    let onCancel: () -> Void
    let onRetry: () -> Void
    @ScaledMetric(relativeTo: .caption2) private var metaSize: CGFloat = 10
    @ScaledMetric(relativeTo: .body) private var textSize: CGFloat = 15
    private var isUser: Bool { message.role == .user }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 9) {
            if !isUser {
                HStack(spacing: 7) {
                    AgentPortrait(name: "hermes", size: 23)
                    Text("Alan").font(.system(size: metaSize, weight: .semibold)).foregroundStyle(WorkspaceTheme.secondary)
                }
            }
            HStack {
                if isUser { Spacer(minLength: 36) }
                VStack(alignment: .leading, spacing: 10) {
                    Group {
                        if message.text.isEmpty && message.isStreaming {
                            Text("…").foregroundStyle(WorkspaceTheme.secondary)
                        } else if isUser {
                            Text(message.text).font(.system(size: textSize)).lineSpacing(5).textSelection(.enabled)
                        } else {
                            GatewayMarkdownView(text: message.text)
                        }
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel((isUser ? "You said: " : "Alan said: ") + message.text)
                    footer
                }
                .padding(15)
                .background(isUser ? WorkspaceTheme.raised : WorkspaceTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 19))
                .overlay(RoundedRectangle(cornerRadius: 19).stroke(message.delivery == .failed ? Color.orange.opacity(0.6) : .clear))
                if !isUser { Spacer(minLength: 26) }
            }
            if message.delivery == .failed { failedActions }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 8) {
            switch message.delivery {
            case .queued:
                Text("Waiting to send").foregroundStyle(.orange)
                Button("Cancel", action: onCancel).frame(minWidth: 44, minHeight: 44).accessibilityLabel("Cancel this message").accessibilityIdentifier("gatewayCancel")
            case .sending: Text("Sending…").foregroundStyle(WorkspaceTheme.secondary)
            case .failed: Text("Not sent").foregroundStyle(.orange)
            case .sent: if message.isStreaming { Text("Replying…").foregroundStyle(WorkspaceTheme.secondary) }
            }
            Spacer(minLength: 0)
            if let date = message.date, !message.isStreaming {
                Text(GatewayFormat.stamp(date)).foregroundStyle(WorkspaceTheme.secondary)
            }
        }
        .font(.system(size: metaSize, design: .monospaced))
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var failedActions: some View {
        HStack(spacing: 12) {
            Spacer()
            Button("Retry", action: onRetry).accessibilityLabel("Send this message again").accessibilityIdentifier("gatewayRetry")
            Button("Delete", role: .destructive, action: onCancel).accessibilityLabel("Delete this message").accessibilityIdentifier("gatewayDelete")
        }
        .font(.subheadline.weight(.medium)).buttonStyle(.bordered).controlSize(.large)
    }
}
