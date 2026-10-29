import Foundation
import TDLibKit

/// TDLib errors carry an uppercase code such as PHONE_CODE_INVALID and no localized text.
enum TelegramErrorText {
    static func describe(_ error: Swift.Error) -> String {
        guard let error = error as? TDLibKit.Error else { return error.localizedDescription }
        return describe(code: error.code, message: error.message)
    }

    static func describe(code: Int, message: String) -> String {
        // TDLib forbids showing the text of a 406 error.
        if code == 406 { return "Telegram could not finish that request. Try again." }
        if message.hasPrefix("FLOOD_WAIT_"), let seconds = Int(message.dropFirst("FLOOD_WAIT_".count)) {
            let minutes = (seconds + 59) / 60
            return "Too many attempts. Telegram asks you to wait \(minutes == 1 ? "a minute" : "\(minutes) minutes") before trying again."
        }
        switch message {
        case "API_ID_INVALID", "API_ID_PUBLISHED_FLOOD":
            return "Telegram rejected this build’s API ID or API hash. Choose Use different app credentials and copy both again from my.telegram.org/apps."
        case "PHONE_NUMBER_INVALID":
            return "Telegram does not recognize that phone number. Include the country code, for example +1 555 123 4567."
        case "PHONE_NUMBER_BANNED":
            return "Telegram has blocked this phone number. Contact Telegram support."
        case "PHONE_CODE_INVALID", "PHONE_CODE_EMPTY":
            return "That code is not right. Enter the latest code Telegram sent you."
        case "PHONE_CODE_EXPIRED":
            return "That code expired. Sign in again to get a new one."
        case "PASSWORD_HASH_INVALID":
            return "That two-step verification password is not right."
        case "EMAIL_CODE_INVALID":
            return "That email code is not right. Enter the latest code Telegram sent."
        case "USERNAME_INVALID", "USERNAME_NOT_OCCUPIED":
            return "No Telegram account uses that username. Check your bot’s @username in BotFather."
        default:
            return "Telegram reported \(message)."
        }
    }
}
