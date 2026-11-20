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

/// One Telegram formatting entity. `offset` and `length` count UTF-16 code units, as Telegram sends them.
public struct TelegramTextEntity: Equatable {
    public enum Kind: Equatable { case bold, italic, underline, strikethrough, code, link(URL) }
    public let offset: Int
    public let length: Int
    public let kind: Kind

    public init(offset: Int, length: Int, kind: Kind) {
        self.offset = offset
        self.length = length
        self.kind = kind
    }
}

enum TelegramText {
    /// Plain text plus Telegram's own entities. Never parsed as Markdown, so a stray `*` stays a `*`.
    static func attributed(_ text: String, entities: [TelegramTextEntity]) -> AttributedString {
        var result = AttributedString(text)
        let whole = NSRange(location: 0, length: (text as NSString).length)
        for entity in entities {
            let range = NSRange(location: entity.offset, length: entity.length)
            guard entity.length > 0, NSIntersectionRange(range, whole) == range,
                  let stringRange = Range(range, in: text),
                  let target = Range(stringRange, in: result) else { continue }
            switch entity.kind {
            case .bold: addIntent(.stronglyEmphasized, to: target, in: &result)
            case .italic: addIntent(.emphasized, to: target, in: &result)
            case .code: addIntent(.code, to: target, in: &result)
            case .strikethrough: addIntent(.strikethrough, to: target, in: &result)
            case .underline: result[target].underlineStyle = .single
            case .link(let url): result[target].link = url
            }
        }
        return result
    }

    private static func addIntent(_ intent: InlinePresentationIntent, to range: Range<AttributedString.Index>,
                                  in text: inout AttributedString) {
        for run in text[range].runs {
            text[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(intent)
        }
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
    public var entities: [TelegramTextEntity]

    public init(id: Int64, chatID: Int64, senderID: Int64? = nil, senderName: String, isOutgoing: Bool,
                date: Date, text: String, attachment: TelegramAttachment? = nil,
                buttonRows: [[TelegramButton]] = [], entities: [TelegramTextEntity] = []) {
        self.id = id
        self.chatID = chatID
        self.senderID = senderID
        self.senderName = senderName
        self.isOutgoing = isOutgoing
        self.date = date
        self.text = text
        self.attachment = attachment
        self.buttonRows = buttonRows
        self.entities = entities
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
