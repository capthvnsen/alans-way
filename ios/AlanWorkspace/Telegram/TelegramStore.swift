import Foundation
import Network
import Observation
import TDLibKit
import UIKit

@MainActor
@Observable
public final class TelegramStore {
    public private(set) var authState: TelegramAuthState = .configuring
    public private(set) var chats: [TelegramChat] = []
    public var selectedChatID: Int64?
    public private(set) var messagesByChat: [Int64: [TelegramMessage]] = [:]
    public private(set) var loadingChatIDs: Set<Int64> = []
    public private(set) var hasMoreMessages: Set<Int64> = []
    public private(set) var isLoadingChats = false
    public private(set) var isSending = false
    public private(set) var errorMessage: String?
    public private(set) var isInterfacePreview = false
    /// Shown while Telegram is offline or catching up; nil once the connection works.
    public private(set) var connectionStatus: String?
    public var currentUserID: Int64? { userID }

    @ObservationIgnored private var manager: TDLibClientManager?
    @ObservationIgnored private var client: TDLibClient?
    @ObservationIgnored private var waitingForParameters = false
    @ObservationIgnored private var parametersRequestInFlight = false
    @ObservationIgnored private var apiID: Int32?
    @ObservationIgnored private var apiHash: String?
    @ObservationIgnored private var userID: Int64?
    @ObservationIgnored private var usersByID: [Int64: User] = [:]
    @ObservationIgnored private var tdChatsByID: [Int64: Chat] = [:]
    @ObservationIgnored private var botIDByChatID: [Int64: Int64] = [:]
    @ObservationIgnored private var chatOrderByID: [Int64: Int64] = [:]
    @ObservationIgnored private var pendingUploads: [Int64: URL] = [:]
    @ObservationIgnored private var completedUploadBeforeResponse: Set<Int64> = []
    @ObservationIgnored private var activeFileSends = 0
    @ObservationIgnored private let fileManager = FileManager.default
    @ObservationIgnored private var pathMonitor: NWPathMonitor?

    public init() {}

    #if DEBUG
    /// Safe simulator-only fixtures for reviewing the interface without a Telegram account.
    public static func interfacePreview() -> TelegramStore {
        let store = TelegramStore()
        store.isInterfacePreview = true
        store.authState = .ready
        store.chats = [
            TelegramChat(id: 101, title: "Hermes", username: "hermes_preview", isBot: true,
                         lastMessagePreview: "Ready when you are.", unreadCount: 0),
            TelegramChat(id: 102, title: "Athena", username: "athena_preview", isBot: true,
                         lastMessagePreview: "I’ve gathered the latest context.", unreadCount: 1)
        ]
        store.selectedChatID = 101
        if ProcessInfo.processInfo.arguments.contains("--preview-offline") {
            store.connectionStatus = TelegramModelMapper.connectionStatus(.connectionStateWaitingForNetwork)
        }
        store.messagesByChat[101] = [
            TelegramMessage(id: 1, chatID: 101, senderName: "Hermes", isOutgoing: false,
                            date: Date().addingTimeInterval(-90), text: "Ready when you are."),
            TelegramMessage(id: 2, chatID: 101, senderName: "You", isOutgoing: true,
                            date: Date().addingTimeInterval(-45), text: "Pick up where we left off."),
            TelegramMessage(id: 3, chatID: 101, senderName: "Hermes", isOutgoing: false,
                            date: Date(), text: "Of course. I have the conversation context.")
        ]
        return store
    }
    #endif

    /// Loads credentials from Keychain and resumes the existing encrypted TDLib session when configured.
    public func restoreSession() async {
        do {
            let credentials = try TelegramKeychain.credentials() ?? bundledCredentials()
            guard let credentials else {
                authState = .configuring
                return
            }
            apiID = credentials.apiID
            apiHash = credentials.apiHash
            try startClient()
        } catch {
            fail(error)
        }
    }

    public func configure(apiID: Int32, apiHash: String) async throws {
        guard apiID > 0, !apiHash.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw TelegramStoreError.notConfigured
        }
        try TelegramKeychain.storeCredentials(apiID: apiID, apiHash: apiHash)
        self.apiID = apiID
        self.apiHash = apiHash
        if let client {
            if waitingForParameters && !parametersRequestInFlight {
                do { try await configureParameters(for: client) }
                catch { fail(error); throw error }
            }
            return
        }
        try startClient()
    }

    public func submitPhoneNumber(_ phone: String) async throws {
        guard let client else { throw TelegramStoreError.notConfigured }
        try await client.setAuthenticationPhoneNumber(phoneNumber: phone, settings: nil)
    }

    public func submitCode(_ code: String) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        try await client.checkAuthenticationCode(code: code)
    }

    public func submitPassword(_ password: String) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        try await client.checkAuthenticationPassword(password: password)
    }

    public func submitEmailAddress(_ email: String) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        try await client.setAuthenticationEmailAddress(emailAddress: email)
    }

    public func submitEmailCode(_ code: String) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        let authentication = EmailAddressAuthentication.emailAddressAuthenticationCode(
            EmailAddressAuthenticationCode(code: code)
        )
        try await client.checkAuthenticationEmailCode(code: authentication)
    }

    public func selectChat(_ chatID: Int64) async {
        if let previous = selectedChatID, previous != chatID, let client {
            try? await client.closeChat(chatId: previous)
        }
        selectedChatID = chatID
        errorMessage = nil
        if let client { try? await client.openChat(chatId: chatID) }
        if messagesByChat[chatID] == nil {
            do { try await loadMoreMessages(chatID: chatID) }
            catch { errorMessage = error.localizedDescription }
        }
        if let client, let ids = messagesByChat[chatID]?.map(\.id), !ids.isEmpty {
            try? await client.viewMessages(chatId: chatID, forceRead: true, messageIds: ids, source: nil)
        }
    }

    /// Closes Telegram's active chat view when the conversation leaves the screen.
    public func closeChat(chatID: Int64) async {
        if selectedChatID == chatID { selectedChatID = nil }
        if let client { try? await client.closeChat(chatId: chatID) }
    }

    public func clearError() { errorMessage = nil }

    /// Finds a public bot username using Telegram and opens the resulting private conversation.
    @discardableResult
    public func openBot(username: String) async throws -> Int64 {
        guard let client else { throw TelegramStoreError.notAuthorized }
        let normalized = username.trimmingCharacters(in: CharacterSet(charactersIn: "@ "))
        guard !normalized.isEmpty else { throw TelegramStoreError.botNotFound }
        let chat = try await client.searchPublicChat(username: normalized)
        guard case .chatTypePrivate(let privateChat) = chat.type else { throw TelegramStoreError.botNotFound }
        let bot = try await client.getUser(userId: privateChat.userId)
        guard case .userTypeBot = bot.type else { throw TelegramStoreError.botNotFound }
        usersByID[bot.id] = bot
        let openedChat = try await client.createPrivateChat(force: false, userId: privateChat.userId)
        apply(openedChat)
        return chat.id
    }

    public func logOut() async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        _ = try await client.logOut()
        chats.removeAll()
        messagesByChat.removeAll()
        selectedChatID = nil
        authState = .closed
    }

    /// Loads Telegram's main conversation list and keeps it current through TDLib updates.
    public func loadChats() async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        isLoadingChats = true
        defer { isLoadingChats = false }
        for list in [ChatList.chatListMain, .chatListArchive] {
            while true {
                do { _ = try await client.loadChats(chatList: list, limit: 100) }
                catch {
                    // TDLib returns 404 when the selected chat list is fully loaded.
                    if !String(describing: error).contains("404") { throw error }
                    break
                }
            }
        }
        for list in [ChatList.chatListMain, .chatListArchive] {
            let loaded = try await client.getChats(chatList: list, limit: 10_000)
            for chatID in loaded.chatIds {
                let chat = try await client.getChat(chatId: chatID)
                apply(chat)
            }
        }
        sortChats()
    }

    /// Retrieves an older page (or the latest page on the first call) from Telegram.
    public func loadMoreMessages(chatID: Int64) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        guard !loadingChatIDs.contains(chatID) else { return }
        loadingChatIDs.insert(chatID)
        defer { loadingChatIDs.remove(chatID) }
        let current = messagesByChat[chatID, default: []]
        let oldestID = current.first?.id ?? 0
        let result = try await client.getChatHistory(
            chatId: chatID,
            fromMessageId: oldestID,
            limit: 50,
            offset: current.isEmpty ? 0 : 0,
            onlyLocal: false
        )
        let page = result.messages ?? []
        let converted = page.map { TelegramModelMapper.message($0, users: usersByID) }
        let known = Set(current.map(\.id))
        let additions = converted.filter { !known.contains($0.id) }
        messagesByChat[chatID] = (additions + current).sorted { $0.id < $1.id }
        if page.count < 50 || additions.isEmpty { hasMoreMessages.remove(chatID) }
        else { hasMoreMessages.insert(chatID) }
        for item in converted { scheduleAttachmentDownload(item) }
    }

    public func sendText(_ text: String, chatID: Int64) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSending = true
        defer { isSending = false }
        let formatted = FormattedText(entities: [], text: trimmed)
        let content = InputMessageContent.inputMessageText(
            InputMessageText(clearDraft: true, linkPreviewOptions: nil, text: formatted)
        )
        _ = try await client.sendMessage(
            chatId: chatID,
            inputMessageContent: content,
            options: nil,
            replyMarkup: nil,
            replyTo: nil,
            topicId: nil
        )
    }

    public func sendFile(_ url: URL, chatID: Int64) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        guard url.isFileURL, fileManager.fileExists(atPath: url.path) else {
            throw TelegramStoreError.attachmentUnavailable
        }
        let outbox = try databaseDirectories().files.deletingLastPathComponent().appendingPathComponent("outbox", isDirectory: true)
        try fileManager.createDirectory(at: outbox, withIntermediateDirectories: true)
        let retainedURL = outbox.appendingPathComponent(UUID().uuidString).appendingPathExtension(url.pathExtension)
        try fileManager.copyItem(at: url, to: retainedURL)
        let inputFile = InputFile.inputFileLocal(InputFileLocal(path: retainedURL.path))
        let document = InputDocument(disableContentTypeDetection: false, document: inputFile, thumbnail: nil)
        let content = InputMessageContent.inputMessageDocument(InputMessageDocument(caption: nil, document: document))
        activeFileSends += 1
        defer { activeFileSends -= 1 }
        do {
            let pending = try await client.sendMessage(
                chatId: chatID,
                inputMessageContent: content,
                options: nil,
                replyMarkup: nil,
                replyTo: nil,
                topicId: nil
            )
            if completedUploadBeforeResponse.remove(pending.id) != nil {
                try? fileManager.removeItem(at: retainedURL)
            } else {
                pendingUploads[pending.id] = retainedURL
            }
        } catch {
            try? fileManager.removeItem(at: retainedURL)
            throw error
        }
    }

    public func downloadAttachment(for message: TelegramMessage, chatID: Int64) async throws -> URL {
        guard let client, let fileID = message.attachment?.fileID else { throw TelegramStoreError.attachmentUnavailable }
        let file = try await client.downloadFile(fileId: fileID, limit: 0, offset: 0, priority: 16, synchronous: true)
        guard file.local.isDownloadingCompleted, !file.local.path.isEmpty else { throw TelegramStoreError.attachmentUnavailable }
        updateAttachmentPath(fileID: fileID, path: file.local.path, chatID: chatID)
        return URL(fileURLWithPath: file.local.path)
    }

    /// Activates native Telegram keyboard actions. Web Apps are opened via TDLib to receive Telegram's real authenticated URL.
    public func activateButton(_ button: TelegramButton, messageID: Int64, chatID: Int64) async throws -> TelegramMiniAppLaunch? {
        guard let client else { throw TelegramStoreError.notAuthorized }
        switch button.kind {
        case .text:
            try await sendText(button.title, chatID: chatID)
            return nil
        case .url:
            return nil // The UI opens ordinary links with its system URL handler.
        case .webApp(let url):
            return try await openWebApp(chatID: chatID, url: url.absoluteString, messageID: messageID)
        case .callback(let data):
            let payload = CallbackQueryPayload.callbackQueryPayloadData(CallbackQueryPayloadData(data: data))
            _ = try await client.getCallbackQueryAnswer(chatId: chatID, messageId: messageID, payload: payload)
            return nil
        case .unsupported:
            throw TelegramStoreError.unsupportedButton
        }
    }

    /// Uses the selected bot's configured menu button, or a Web App button in recent messages, through Telegram's openWebApp API.
    public func launchMiniApp(chatID: Int64) async throws -> TelegramMiniAppLaunch {
        guard client != nil else { throw TelegramStoreError.notAuthorized }
        guard let botID = botIDByChatID[chatID] else { throw TelegramStoreError.botNotFound }
        guard let client, let bot = try? await client.getUser(userId: botID), case .userTypeBot = bot.type else {
            throw TelegramStoreError.botNotFound
        }
        usersByID[bot.id] = bot
        let beforeMessageID = messagesByChat[chatID]?.last?.id ?? 0
        try await sendText("/call", chatID: chatID)
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            try Task.checkCancellation()
            let recent = messagesByChat[chatID, default: []]
            if let message = TelegramLaunchMatcher.callMessage(in: recent, afterMessageID: beforeMessageID,
                                                               chatID: chatID, botID: botID),
               let url = TelegramLaunchMatcher.callURL(in: [message], afterMessageID: beforeMessageID,
                                                       chatID: chatID, botID: botID) {
                return try await openWebApp(chatID: chatID, url: url.absoluteString, messageID: message.id)
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        throw TelegramStoreError.callNotConfigured
    }

    public func closeWebApp(launchID: Int64) async throws {
        guard let client else { throw TelegramStoreError.notAuthorized }
        _ = try await client.closeWebApp(webAppLaunchId: TdInt64(launchID))
    }

    // MARK: TDLib lifecycle and update stream

    private func startClient() throws {
        guard let apiID, let apiHash else { throw TelegramStoreError.notConfigured }
        if client != nil { return }
        let manager = TDLibClientManager()
        self.manager = manager
        let newClient = manager.createClient { [weak self] data, client in
            guard let update = try? client.decoder.decode(Update.self, from: data) else { return }
            Task { @MainActor [weak self] in await self?.consume(update, receivedBy: client) }
        }
        client = newClient
        startNetworkMonitor()
        waitingForParameters = false
        parametersRequestInFlight = false
        self.apiID = apiID
        self.apiHash = apiHash
        authState = .configuring
    }

    /// TDLib asks to be told about every network change so it reconnects at once instead of after its retry backoff.
    private func startNetworkMonitor() {
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let wifi = path.usesInterfaceType(.wifi)
            let cellular = path.usesInterfaceType(.cellular)
            Task { @MainActor [weak self] in
                let type = TelegramModelMapper.networkType(satisfied: satisfied, wifi: wifi, cellular: cellular)
                _ = try? await self?.client?.setNetworkType(type: type)
            }
        }
        monitor.start(queue: DispatchQueue(label: "TelegramStore.network"))
        pathMonitor = monitor
    }

    private func consume(_ update: Update, receivedBy client: TDLibClient) async {
        switch update {
        case .updateAuthorizationState(let value):
            switch value.authorizationState {
            case .authorizationStateWaitTdlibParameters:
                waitingForParameters = true
                do { try await configureParameters(for: client) }
                catch { fail(error) }
            case .authorizationStateWaitPhoneNumber:
                authState = .waitPhoneNumber
            case .authorizationStateWaitCode:
                authState = .waitCode
            case .authorizationStateWaitPassword:
                authState = .waitPassword
            case .authorizationStateWaitEmailAddress:
                authState = .waitEmailAddress
            case .authorizationStateWaitEmailCode:
                authState = .waitEmailCode
            case .authorizationStateReady:
                authState = .ready
                if let me = try? await client.getMe() { userID = me.id }
                Task { try? await loadChats() }
            case .authorizationStateClosed:
                authState = .closed
                chats.removeAll()
                messagesByChat.removeAll()
                selectedChatID = nil
                self.client = nil
                self.manager = nil
                connectionStatus = nil
                waitingForParameters = false
                parametersRequestInFlight = false
            default:
                authState = .configuring
            }
        case .updateConnectionState(let value):
            connectionStatus = TelegramModelMapper.connectionStatus(value.state)
        case .updateNewChat(let value):
            apply(value.chat)
        case .updateChatTitle(let value):
            if let index = chats.firstIndex(where: { $0.id == value.chatId }) { chats[index].title = value.title }
        case .updateChatPhoto(let value):
            if let index = chats.firstIndex(where: { $0.id == value.chatId }) {
                chats[index].photoPath = value.photo?.small.local.path
            }
        case .updateChatLastMessage(let value):
            updateChatOrder(chatID: value.chatId, positions: value.positions)
            if let message = value.lastMessage { upsert(message) }
        case .updateChatPosition(let value):
            if value.position.list == .chatListMain || value.position.list == .chatListArchive {
                chatOrderByID[value.chatId] = value.position.order.rawValue == 0 ? nil : value.position.order.rawValue
            }
            sortChats()
        case .updateChatReadInbox(let value):
            if let index = chats.firstIndex(where: { $0.id == value.chatId }) {
                chats[index].unreadCount = value.unreadCount
            }
        case .updateNewMessage(let value):
            upsert(value.message)
        case .updateMessageSendSucceeded(let value):
            completeUpload(oldMessageID: value.oldMessageId, message: value.message)
            removeMessage(id: value.oldMessageId, chatID: value.message.chatId)
            upsert(value.message)
        case .updateMessageSendFailed(let value):
            completeUpload(oldMessageID: value.oldMessageId, message: value.message)
            removeMessage(id: value.oldMessageId, chatID: value.message.chatId)
            upsert(value.message)
            errorMessage = "Telegram could not send that message. You can edit it and try again."
        case .updateDeleteMessages(let value):
            var messages = messagesByChat[value.chatId, default: []]
            let deleted = Set(value.messageIds)
            messages.removeAll { deleted.contains($0.id) }
            messagesByChat[value.chatId] = messages
            if let index = chats.firstIndex(where: { $0.id == value.chatId }),
               let latest = messages.last {
                chats[index].lastMessagePreview = latest.text.isEmpty ? "Attachment" : latest.text
            }
        case .updateMessageContent(let value):
            if var messages = messagesByChat[value.chatId], let index = messages.firstIndex(where: { $0.id == value.messageId }) {
                let mapped = TelegramModelMapper.content(value.newContent)
                messages[index].text = mapped.0
                messages[index].attachment = mapped.1
                messagesByChat[value.chatId] = messages
                scheduleAttachmentDownload(messages[index])
            }
        case .updateFile(let value):
            let file = value.file
            if file.local.isDownloadingCompleted { updateAttachmentPath(fileID: file.id, path: file.local.path, chatID: nil) }
        case .updateUser(let value):
            usersByID[value.user.id] = value.user
            for (chatID, chat) in tdChatsByID where botIDByChatID[chatID] == value.user.id { apply(chat) }
        default:
            break
        }
    }

    private func configureParameters(for client: TDLibClient) async throws {
        guard let apiID, let apiHash else { throw TelegramStoreError.notConfigured }
        guard !parametersRequestInFlight else { return }
        parametersRequestInFlight = true
        defer { parametersRequestInFlight = false }
        let dirs = try databaseDirectories()
        let encryptionKey = try TelegramKeychain.databaseEncryptionKey()
        _ = try await client.setTdlibParameters(
            apiHash: apiHash,
            apiId: Int(apiID),
            applicationVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0",
            databaseDirectory: dirs.database.path,
            databaseEncryptionKey: encryptionKey,
            deviceModel: UIDevice.current.model,
            filesDirectory: dirs.files.path,
            systemLanguageCode: Locale.current.language.languageCode?.identifier ?? "en",
            systemVersion: UIDevice.current.systemVersion,
            useChatInfoDatabase: true,
            useFileDatabase: true,
            useMessageDatabase: true,
            useSecretChats: false,
            useTestDc: false
        )
        waitingForParameters = false
    }

    private func apply(_ chat: Chat) {
        tdChatsByID[chat.id] = chat
        updateChatOrder(chatID: chat.id, positions: chat.positions)
        var title = chat.title
        var username: String?
        var isBot = false
        if case .chatTypePrivate(let privateChat) = chat.type {
            if let user = usersByID[privateChat.userId], case .userTypeBot = user.type {
                botIDByChatID[chat.id] = privateChat.userId
            } else {
                botIDByChatID.removeValue(forKey: chat.id)
            }
            if let user = usersByID[privateChat.userId] {
                title = [user.firstName, user.lastName].filter { !$0.isEmpty }.joined(separator: " ")
                username = user.usernames?.activeUsernames.first
                if case .userTypeBot = user.type { isBot = true }
            } else if let client {
                Task { [weak self] in
                    guard let user = try? await client.getUser(userId: privateChat.userId) else { return }
                    await MainActor.run {
                        self?.usersByID[user.id] = user
                        self?.apply(chat)
                    }
                }
            }
        }
        let item = TelegramChat(
            id: chat.id,
            title: title.isEmpty ? chat.title : title,
            username: username,
            isBot: isBot,
            lastMessagePreview: chat.lastMessage.map(TelegramModelMapper.preview) ?? "",
            unreadCount: chat.unreadCount,
            photoPath: chat.photo?.small.local.path
        )
        if let index = chats.firstIndex(where: { $0.id == item.id }) { chats[index] = item }
        else { chats.append(item) }
        sortChats()
    }

    private func sortChats() {
        chats.sort { chatOrderByID[$0.id, default: 0] > chatOrderByID[$1.id, default: 0] }
    }

    private func updateChatOrder(chatID: Int64, positions: [ChatPosition]) {
        let relevant = positions.filter { $0.list == .chatListMain || $0.list == .chatListArchive }
        chatOrderByID[chatID] = relevant.map(\.order).max()?.rawValue
    }

    private func upsert(_ message: Message) {
        var mapped = TelegramModelMapper.message(message, users: usersByID)
        if case .messageSenderUser(let userSender) = message.senderId,
           let user = usersByID[userSender.userId] {
            mapped.senderName = [user.firstName, user.lastName].filter { !$0.isEmpty }.joined(separator: " ")
        }
        var messages = messagesByChat[message.chatId, default: []]
        if let index = messages.firstIndex(where: { $0.id == mapped.id }) { messages[index] = mapped }
        else { messages.append(mapped) }
        messages.sort { $0.id < $1.id }
        messagesByChat[message.chatId] = messages
        scheduleAttachmentDownload(mapped)
        if !message.isOutgoing, selectedChatID == message.chatId, let client {
            Task { try? await client.viewMessages(chatId: message.chatId, forceRead: true, messageIds: [message.id], source: nil) }
        }
        if let index = chats.firstIndex(where: { $0.id == message.chatId }) {
            chats[index].lastMessagePreview = TelegramModelMapper.preview(message)
        }
    }

    private func removeMessage(id: Int64, chatID: Int64) {
        guard var messages = messagesByChat[chatID] else { return }
        messages.removeAll { $0.id == id }
        messagesByChat[chatID] = messages
    }

    /// A send update can overtake the sendMessage response. Remember that terminal event only during a
    /// file send, then remove the retained picker copy as soon as TDLib returns its pending message ID.
    private func completeUpload(oldMessageID: Int64, message: Message) {
        if let url = pendingUploads.removeValue(forKey: oldMessageID) {
            try? fileManager.removeItem(at: url)
        } else if activeFileSends > 0, case .messageDocument = message.content {
            completedUploadBeforeResponse.insert(oldMessageID)
        }
    }

    private func scheduleAttachmentDownload(_ message: TelegramMessage) {
        guard message.attachment?.fileID != nil,
              message.attachment?.localPath?.isEmpty != false,
              let client else { return }
        Task { [weak self] in
            guard let fileID = message.attachment?.fileID,
                  let file = try? await client.downloadFile(fileId: fileID, limit: 0, offset: 0, priority: 16, synchronous: false),
                  file.local.isDownloadingCompleted else { return }
            await MainActor.run { self?.updateAttachmentPath(fileID: fileID, path: file.local.path, chatID: message.chatID) }
        }
    }

    private func updateAttachmentPath(fileID: Int, path: String, chatID: Int64?) {
        let targetChats = chatID.map { [$0] } ?? Array(messagesByChat.keys)
        for id in targetChats {
            guard var messages = messagesByChat[id] else { continue }
            for index in messages.indices where messages[index].attachment?.fileID == fileID {
                messages[index].attachment?.localPath = path
            }
            messagesByChat[id] = messages
        }
    }

    private func openWebApp(chatID: Int64, url: String, messageID: Int64?) async throws -> TelegramMiniAppLaunch {
        guard let client, let botID = botIDByChatID[chatID] else { throw TelegramStoreError.botNotFound }
        let replyTo = messageID.map {
            InputMessageReplyTo.inputMessageReplyToMessage(
                InputMessageReplyToMessage(checklistTaskId: 0, messageId: $0, pollOptionId: "", quote: nil)
            )
        }
        let info = try await client.openWebApp(
            botUserId: botID,
            chatId: chatID,
            parameters: WebAppOpenParameters(applicationName: "hermes_companion", mode: nil, theme: nil),
            replyTo: replyTo,
            topicId: nil,
            url: url
        )
        guard let webURL = URL(string: info.url.url), webURL.scheme == "https" else { throw TelegramStoreError.invalidMiniAppURL }
        return TelegramMiniAppLaunch(url: webURL, launchID: info.launchId.rawValue, requireSameOrigin: info.url.requireSameOrigin)
    }

    private func databaseDirectories() throws -> (database: URL, files: URL) {
        let root = try fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Telegram", isDirectory: true)
        let database = root.appendingPathComponent("database", isDirectory: true)
        let files = root.appendingPathComponent("files", isDirectory: true)
        try fileManager.createDirectory(at: database, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: files, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try? mutableRoot.setResourceValues(values)
        return (database, files)
    }

    private func bundledCredentials() -> (apiID: Int32, apiHash: String)? {
        guard let rawID = Bundle.main.object(forInfoDictionaryKey: "TELEGRAM_API_ID") as? String,
              let id = Int32(rawID), id > 0,
              let hash = Bundle.main.object(forInfoDictionaryKey: "TELEGRAM_API_HASH") as? String,
              !hash.isEmpty else { return nil }
        return (id, hash)
    }

    private func fail(_ error: Swift.Error) {
        errorMessage = error.localizedDescription
        authState = .error(error.localizedDescription)
    }
}

enum TelegramModelMapper {
    static func connectionStatus(_ state: ConnectionState) -> String? {
        switch state {
        case .connectionStateWaitingForNetwork: "Waiting for network…"
        case .connectionStateConnectingToProxy, .connectionStateConnecting: "Connecting…"
        case .connectionStateUpdating: "Updating…"
        case .connectionStateReady: nil
        }
    }

    static func networkType(satisfied: Bool, wifi: Bool, cellular: Bool) -> NetworkType {
        guard satisfied else { return .networkTypeNone }
        if wifi { return .networkTypeWiFi }
        return cellular ? .networkTypeMobile : .networkTypeOther
    }

    static func preview(_ message: Message) -> String {
        switch message.content {
        case .messageText(let text): text.text.text
        case .messagePhoto(let photo): photo.caption.text.isEmpty ? "Photo" : photo.caption.text
        case .messageVideo(let video): video.caption.text.isEmpty ? "Video" : video.caption.text
        case .messageVoiceNote(let voice): voice.caption.text.isEmpty ? "Voice message" : voice.caption.text
        case .messageAudio(let audio): audio.caption.text.isEmpty ? "Audio" : audio.caption.text
        case .messageDocument(let doc): doc.caption.text.isEmpty ? "File" : doc.caption.text
        case .messageSticker(let sticker): sticker.sticker.emoji.isEmpty ? "Sticker" : sticker.sticker.emoji
        default: "Attachment"
        }
    }

    static func message(_ message: Message, users: [Int64: User]) -> TelegramMessage {
        let mapped = content(message.content)
        let senderName: String
        if case .messageSenderUser(let sender) = message.senderId, let user = users[sender.userId] {
            senderName = [user.firstName, user.lastName].filter { !$0.isEmpty }.joined(separator: " ")
        } else {
            senderName = message.isOutgoing ? "You" : "Bot"
        }
        let senderID: Int64?
        if case .messageSenderUser(let sender) = message.senderId { senderID = sender.userId }
        else { senderID = nil }
        return TelegramMessage(
            id: message.id,
            chatID: message.chatId,
            senderID: senderID,
            senderName: senderName,
            isOutgoing: message.isOutgoing,
            date: Date(timeIntervalSince1970: TimeInterval(message.date)),
            text: mapped.0,
            attachment: mapped.1,
            buttonRows: buttons(message.replyMarkup)
        )
    }

    static func content(_ content: MessageContent) -> (String, TelegramAttachment?) {
        switch content {
        case .messageText(let value): return (value.text.text, nil)
        case .messagePhoto(let value): return (value.caption.text, value.photo.sizes.last.map { .init(kind: .photo, fileID: $0.photo.id, localPath: $0.photo.local.path, caption: value.caption.text) })
        case .messageVideo(let value): return (value.caption.text, .init(kind: .video, fileID: value.video.video.id, localPath: value.video.video.local.path, caption: value.caption.text))
        case .messageVoiceNote(let value): return (value.caption.text, .init(kind: .voice, fileID: value.voiceNote.voice.id, localPath: value.voiceNote.voice.local.path, caption: value.caption.text))
        case .messageAudio(let value): return (value.caption.text, .init(kind: .audio, fileID: value.audio.audio.id, localPath: value.audio.audio.local.path, caption: value.caption.text))
        case .messageDocument(let value): return (value.caption.text, .init(kind: .document, fileID: value.document.document.id, localPath: value.document.document.local.path, caption: value.caption.text))
        case .messageSticker(let value): return (value.sticker.emoji, .init(kind: .sticker, fileID: value.sticker.sticker.id, localPath: value.sticker.sticker.local.path))
        case .messageAnimation(let value): return (value.caption.text, .init(kind: .animation, fileID: value.animation.animation.id, localPath: value.animation.animation.local.path, caption: value.caption.text))
        default: return ("", nil)
        }
    }

    static func buttons(_ markup: ReplyMarkup?) -> [[TelegramButton]] {
        switch markup {
        case .replyMarkupInlineKeyboard(let keyboard):
            return keyboard.rows.enumerated().map { rowIndex, row in row.enumerated().map { buttonIndex, button in
                let kind: TelegramButtonKind
                switch button.type {
                case .inlineKeyboardButtonTypeUrl(let value):
                    kind = URL(string: value.url).map(TelegramButtonKind.url) ?? .unsupported
                case .inlineKeyboardButtonTypeWebApp(let value):
                    kind = URL(string: value.url).map(TelegramButtonKind.webApp) ?? .unsupported
                case .inlineKeyboardButtonTypeCallback(let value): kind = .callback(value.data)
                case .inlineKeyboardButtonTypeCallbackWithPassword(let value): kind = .callback(value.data)
                default: kind = .unsupported
                }
                return TelegramButton(id: "inline-\(rowIndex)-\(buttonIndex)", title: button.text, kind: kind)
            } }
        case .replyMarkupShowKeyboard(let keyboard):
            return keyboard.rows.enumerated().map { rowIndex, row in row.enumerated().map { buttonIndex, button in
                let kind: TelegramButtonKind
                if case .keyboardButtonTypeWebApp(let webApp) = button.type,
                   let url = URL(string: webApp.url) {
                    kind = .webApp(url)
                } else {
                    kind = .text
                }
                return TelegramButton(id: "keyboard-\(rowIndex)-\(buttonIndex)", title: button.text, kind: kind)
            } }
        default: return []
        }
    }
}

enum TelegramLaunchMatcher {
    static func callMessage(in messages: [TelegramMessage], afterMessageID: Int64,
                            chatID: Int64, botID: Int64) -> TelegramMessage? {
        messages.sorted { $0.id < $1.id }.first { message in
            message.chatID == chatID && message.id > afterMessageID && !message.isOutgoing &&
                message.senderID == botID && callURL(in: [message], afterMessageID: afterMessageID,
                                                     chatID: chatID, botID: botID) != nil
        }
    }

    static func callURL(in messages: [TelegramMessage], afterMessageID: Int64,
                        chatID: Int64, botID: Int64) -> URL? {
        for message in messages where message.chatID == chatID && message.id > afterMessageID &&
            !message.isOutgoing && message.senderID == botID {
            for row in message.buttonRows {
                for button in row {
                    guard button.title.localizedCaseInsensitiveContains("call"),
                          case .webApp(let url) = button.kind,
                          url.scheme?.lowercased() == "https" else { continue }
                    return url
                }
            }
        }
        return nil
    }
}
