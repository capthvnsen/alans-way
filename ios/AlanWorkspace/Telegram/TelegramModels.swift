import Foundation

public enum TelegramAuthState: Equatable {
    case configuring
    case waitPhoneNumber
    case waitCode
    case waitPassword
    case waitEmailAddress
    case waitEmailCode
    case ready
    case error(String)
    case closed
}

public struct TelegramChat: Identifiable, Equatable {
    public let id: Int64
    public var title: String
    public var username: String?
    public var isBot: Bool
    /// Presentation asset slug used when no Hermes-specific avatar choice is stored locally.
    public var avatarName: String { "hermes" }
    public var lastMessagePreview: String
    public var unreadCount: Int
    public var photoPath: String?

    public init(id: Int64, title: String, username: String? = nil, isBot: Bool = false,
                lastMessagePreview: String = "", unreadCount: Int = 0, photoPath: String? = nil) {
        self.id = id
        self.title = title
        self.username = username
        self.isBot = isBot
        self.lastMessagePreview = lastMessagePreview
        self.unreadCount = unreadCount
        self.photoPath = photoPath
    }
}

public enum TelegramAttachmentKind: Equatable {
    case photo, video, voice, audio, document, sticker, animation, other
}

public struct TelegramAttachment: Equatable {
    public let kind: TelegramAttachmentKind
    public let fileID: Int?
    public var localPath: String?
    public let caption: String?

    public init(kind: TelegramAttachmentKind, fileID: Int?, localPath: String? = nil, caption: String? = nil) {
        self.kind = kind
        self.fileID = fileID
        self.localPath = localPath
        self.caption = caption
    }
}

public enum TelegramButtonKind: Equatable {
    case text
    case url(URL)
    case webApp(URL)
    case callback(Data)
    case unsupported
}

public struct TelegramButton: Identifiable, Equatable {
    public let id: String
    public let title: String
    public let kind: TelegramButtonKind

    public init(id: String, title: String, kind: TelegramButtonKind) {
        self.id = id
        self.title = title
        self.kind = kind
    }
}

public struct TelegramMessage: Identifiable, Equatable {
    public let id: Int64
    public let chatID: Int64
    public let senderID: Int64?
    public var senderName: String
    public let isOutgoing: Bool
    public let date: Date
    public var text: String
    public var attachment: TelegramAttachment?
    public var buttonRows: [[TelegramButton]]

    public init(id: Int64, chatID: Int64, senderID: Int64? = nil, senderName: String, isOutgoing: Bool,
                date: Date, text: String, attachment: TelegramAttachment? = nil,
                buttonRows: [[TelegramButton]] = []) {
        self.id = id
        self.chatID = chatID
        self.senderID = senderID
        self.senderName = senderName
        self.isOutgoing = isOutgoing
        self.date = date
        self.text = text
        self.attachment = attachment
        self.buttonRows = buttonRows
    }
}

public struct TelegramMiniAppLaunch: Identifiable, Equatable {
    public var id: Int64 { launchID }
    public let url: URL
    public let launchID: Int64
    public let requireSameOrigin: Bool

    public init(url: URL, launchID: Int64, requireSameOrigin: Bool) {
        self.url = url
        self.launchID = launchID
        self.requireSameOrigin = requireSameOrigin
    }
}

public enum TelegramStoreError: LocalizedError {
    case notConfigured
    case notAuthorized
    case chatNotFound
    case botNotFound
    case miniAppUnavailable
    case callNotConfigured
    case invalidMiniAppURL
    case unsupportedButton
    case attachmentUnavailable

    public var errorDescription: String? {
        switch self {
        case .notConfigured: "Enter your Telegram API ID and API hash first."
        case .notAuthorized: "Sign in to Telegram to continue."
        case .chatNotFound: "This Telegram conversation is no longer available."
        case .botNotFound: "This conversation is not with a Telegram bot."
        case .miniAppUnavailable: "No Mini App is configured for this bot. Ask this bot to enable a /call Mini App."
        case .callNotConfigured: "This bot did not return a fresh call link. Check that the Hermes plugin has calls enabled, then try again."
        case .invalidMiniAppURL: "Telegram returned an invalid Mini App link."
        case .unsupportedButton: "This bot button is not supported yet."
        case .attachmentUnavailable: "Telegram has not downloaded this attachment yet."
        }
    }
}
