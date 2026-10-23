import SwiftUI
import UniformTypeIdentifiers
import QuickLook

struct ConversationView: View {
    let chat: TelegramChat
    @Environment(TelegramStore.self) private var telegram
    @Environment(WorkspaceSettings.self) private var settings
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var launch: TelegramMiniAppLaunch?
    @State private var showComputer = false
    @State private var showAgentSettings = false
    @State private var showFilePicker = false
    @State private var preparingCall = false
    @State private var errorText: String?
    @State private var attachmentURL: URL?
    @State private var pendingLaunch: TelegramMiniAppLaunch?
    @State private var showCallComputer = false
    @FocusState private var composerFocused: Bool

    private var messages: [TelegramMessage] { telegram.messagesByChat[chat.id] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(WorkspaceTheme.line).frame(height: 0.5)
            timeline
            composer
        }
        .background(WorkspaceTheme.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarBackground(WorkspaceTheme.background, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showAgentSettings = true } label: {
                    HStack(spacing: 10) {
                        AgentPortrait(name: settings.avatar(for: chat.id), size: 34)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(chat.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                            Text("Telegram bot").font(.system(size: 10)).foregroundStyle(WorkspaceTheme.secondary)
                        }
                    }
                }.accessibilityLabel("\(chat.title), agent settings").accessibilityIdentifier("agentSettings")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showComputer = true } label: { Image(systemName: "desktopcomputer").font(.system(size: 16)) }
                    .accessibilityLabel("View agent computer").accessibilityIdentifier("agentComputer")
                Button { requestCall() } label: {
                    if preparingCall { ProgressView().frame(width: 21) }
                    else { Image(systemName: "phone.fill").font(.system(size: 16)) }
                }.accessibilityLabel("Call \(chat.title)").accessibilityIdentifier("agentCall").disabled(preparingCall)
            }
        }
        .task(id: chat.id) { await telegram.selectChat(chat.id) }
        .onDisappear {
            if launch == nil { Task { await telegram.closeChat(chatID: chat.id) } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { Task { await telegram.closeChat(chatID: chat.id) } }
            if phase == .active { Task { await telegram.selectChat(chat.id) } }
        }
        .onChange(of: telegram.errorMessage) { _, message in
            if let message { errorText = message; telegram.clearError() }
        }
        .sheet(isPresented: $showComputer) { ComputerView(chatID: chat.id, botName: chat.title) }
        .sheet(isPresented: $showAgentSettings) { AgentSettingsView(chat: chat) }
        .fullScreenCover(item: $launch) { call in
            CallSheet(url: call.url, botName: chat.title, avatarName: settings.avatar(for: chat.id), onClose: {
                closeCall(call)
            }, onOpenComputer: { showCallComputer = true }, onOpenExternalURL: { url in openURL(url) })
            .sheet(isPresented: $showCallComputer) { ComputerView(chatID: chat.id, botName: chat.title) }
        }
        .confirmationDialog("Call \(chat.title)?", isPresented: Binding(
            get: { pendingLaunch != nil },
            set: { if !$0, let app = pendingLaunch { pendingLaunch = nil; closeCall(app) } }
        ), titleVisibility: .visible) {
            Button("Open voice Mini App") {
                guard let app = pendingLaunch else { return }
                pendingLaunch = nil
                settings.grantMiniAppConsent(chatID: chat.id, accountID: telegram.currentUserID, host: app.url.host)
                present(app)
            }
            Button("Cancel", role: .cancel) {
                if let app = pendingLaunch { pendingLaunch = nil; closeCall(app) }
            }
        } message: {
            Text("The Mini App at \(pendingLaunch?.url.host ?? "an unknown host") receives your Telegram identity and opens a voice call for this conversation. Calls end when you leave the app.")
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item]) { result in
            switch result {
            case .success(let url):
                Task {
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    do { try await telegram.sendFile(url, chatID: chat.id) }
                    catch { errorText = error.localizedDescription }
                }
            case .failure(let error): errorText = error.localizedDescription
            }
        }
        .quickLookPreview($attachmentURL)
        .alert("Could not complete that", isPresented: Binding(get: { errorText != nil }, set: { if !$0 { errorText = nil } })) {
            Button("OK") { errorText = nil }
        } message: { Text(errorText ?? "") }
    }

    private var timeline: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if telegram.hasMoreMessages.contains(chat.id) {
                        Button {
                            Task {
                                do { try await telegram.loadMoreMessages(chatID: chat.id) }
                                catch { errorText = error.localizedDescription }
                            }
                        } label: {
                            HStack {
                                if telegram.loadingChatIDs.contains(chat.id) { ProgressView() }
                                Text("Earlier messages")
                            }.font(.caption).frame(maxWidth: .infinity).padding(10)
                        }.disabled(telegram.loadingChatIDs.contains(chat.id))
                    }
                    if messages.isEmpty {
                        if telegram.loadingChatIDs.contains(chat.id) {
                            ProgressView("Loading conversation…").frame(maxWidth: .infinity).padding(.top, 70)
                        } else {
                            VStack(spacing: 18) {
                                AgentPortrait(name: settings.avatar(for: chat.id), size: 100)
                                Text("A familiar conversation.").font(.system(size: 24, weight: .medium, design: .serif))
                                Text("Send a message to \(chat.title).\nIt appears in your Telegram chat everywhere.")
                                    .font(.system(size: 13)).foregroundStyle(WorkspaceTheme.secondary).multilineTextAlignment(.center).lineSpacing(4)
                            }.frame(maxWidth: .infinity).padding(.top, 80)
                        }
                    }
                    ForEach(messages) { message in
                        MessageBubble(message: message, avatar: settings.avatar(for: chat.id), onAttachment: {
                            Task {
                                do { attachmentURL = try await telegram.downloadAttachment(for: message, chatID: chat.id) }
                                catch { errorText = error.localizedDescription }
                            }
                        }, onButton: { button in activate(button, message: message) })
                        .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("conversation-bottom")
                }.padding(.horizontal, 20).padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
            }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            Button { showFilePicker = true } label: {
                Image(systemName: "plus").font(.system(size: 20)).frame(width: 34, height: 43)
            }.accessibilityLabel("Attach a file")
            TextField("Message \(chat.title)", text: $draft, axis: .vertical)
                .font(.system(size: 15)).lineLimit(1...6).focused($composerFocused)
                .padding(.vertical, 12)
                .accessibilityIdentifier("messageComposer")
            Button(action: send) {
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(WorkspaceTheme.background).frame(width: 36, height: 36)
                    .background(WorkspaceTheme.mint, in: Circle())
            }
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || telegram.isSending)
            .opacity(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
            .padding(.bottom, 4).accessibilityLabel("Send message")
        }
        .padding(.horizontal, 12).padding(.vertical, 5)
        .background(WorkspaceTheme.surface, in: RoundedRectangle(cornerRadius: 26))
        .overlay(RoundedRectangle(cornerRadius: 26).stroke(WorkspaceTheme.line))
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
        .background(WorkspaceTheme.background)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Task {
            do {
                try await telegram.sendText(text, chatID: chat.id)
                if draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { draft = "" }
            } catch { errorText = error.localizedDescription }
        }
    }

    private func startCall() async {
        preparingCall = true
        defer { preparingCall = false }
        do { present(try await telegram.launchMiniApp(chatID: chat.id)) }
        catch { errorText = error.localizedDescription }
    }

    // The Mini App's host is only known once Telegram returns its launch URL, and the
    // page is not loaded until the person has approved that host for this chat.
    private func present(_ app: TelegramMiniAppLaunch) {
        if settings.hasMiniAppConsent(chatID: chat.id, accountID: telegram.currentUserID, host: app.url.host) {
            launch = app
            composerFocused = false
        } else { pendingLaunch = app }
    }

    private func requestCall() {
        Task { await startCall() }
    }

    private func closeCall(_ call: TelegramMiniAppLaunch) {
        launch = nil
        Task {
            do { try await telegram.closeWebApp(launchID: call.launchID) }
            catch { errorText = error.localizedDescription }
        }
    }

    private func activate(_ button: TelegramButton, message: TelegramMessage) {
        if case .url(let url) = button.kind { openURL(url); return }
        Task {
            do {
                if let app = try await telegram.activateButton(button, messageID: message.id, chatID: chat.id) { present(app) }
            } catch { errorText = error.localizedDescription }
        }
    }
}

private struct MessageBubble: View {
    let message: TelegramMessage
    let avatar: String
    let onAttachment: () -> Void
    let onButton: (TelegramButton) -> Void

    var body: some View {
        VStack(alignment: message.isOutgoing ? .trailing : .leading, spacing: 9) {
            if !message.isOutgoing {
                HStack(spacing: 7) {
                    AgentPortrait(name: avatar, size: 23)
                    Text(message.senderName).font(.system(size: 10, weight: .semibold)).foregroundStyle(WorkspaceTheme.secondary)
                }
            }
            HStack {
                if message.isOutgoing { Spacer(minLength: 36) }
                VStack(alignment: .leading, spacing: 10) {
                    if let attachment = message.attachment {
                        attachmentView(attachment)
                    }
                    if !message.text.isEmpty {
                        Text(LocalizedStringKey(message.text))
                            .font(.system(size: 15)).lineSpacing(5).textSelection(.enabled)
                            .tint(WorkspaceTheme.mint)
                    }
                    Text(message.date, format: .dateTime.hour().minute())
                        .font(.system(size: 9, design: .monospaced)).foregroundStyle(WorkspaceTheme.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .padding(15)
                .background(message.isOutgoing ? WorkspaceTheme.raised : WorkspaceTheme.surface)
                .clipShape(RoundedRectangle(cornerRadius: 19))
                if !message.isOutgoing { Spacer(minLength: 26) }
            }
            ForEach(Array(message.buttonRows.enumerated()), id: \.offset) { _, row in
                HStack {
                    ForEach(row) { button in
                        Button { onButton(button) } label: {
                            Text(button.title).font(.system(size: 13, weight: .medium)).frame(maxWidth: .infinity).padding(12)
                                .background(WorkspaceTheme.raised, in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                }
            }
        }.frame(maxWidth: .infinity)
    }

    @ViewBuilder private func attachmentView(_ attachment: TelegramAttachment) -> some View {
        Button(action: onAttachment) {
            if attachment.kind == .photo, let path = attachment.localPath, let image = UIImage(contentsOfFile: path) {
                Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 300).clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                Label(attachmentTitle(attachment.kind), systemImage: attachmentIcon(attachment.kind))
                    .font(.system(size: 14)).padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            }
        }.buttonStyle(.plain).accessibilityLabel("Open \(attachmentTitle(attachment.kind))")
    }

    private func attachmentTitle(_ kind: TelegramAttachmentKind) -> String {
        switch kind {
        case .photo: "Photo"
        case .video: "Video"
        case .voice: "Voice message"
        case .audio: "Audio"
        case .document: "Document"
        case .sticker: "Sticker"
        case .animation: "Animation"
        case .other: "Attachment"
        }
    }
    private func attachmentIcon(_ kind: TelegramAttachmentKind) -> String {
        switch kind {
        case .photo, .sticker: "photo"
        case .video, .animation: "play.rectangle"
        case .voice, .audio: "waveform"
        default: "doc"
        }
    }
}
