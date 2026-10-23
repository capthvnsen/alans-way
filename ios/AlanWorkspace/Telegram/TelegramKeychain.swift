import Foundation
import Security

/// Stores only Telegram login material and the TDLib database key. No credentials are written to defaults or logs.
enum TelegramKeychain {
    private static let service = "com.hermescompanion.telegram"
    private static let apiIDAccount = "api-id"
    private static let apiHashAccount = "api-hash"
    private static let databaseKeyAccount = "database-key"

    static func storeCredentials(apiID: Int32, apiHash: String) throws {
        try set(Data(String(apiID).utf8), account: apiIDAccount)
        try set(Data(apiHash.utf8), account: apiHashAccount)
    }

    static func credentials() throws -> (apiID: Int32, apiHash: String)? {
        guard let idData = try get(account: apiIDAccount),
              let hashData = try get(account: apiHashAccount),
              let idString = String(data: idData, encoding: .utf8),
              let apiID = Int32(idString),
              let apiHash = String(data: hashData, encoding: .utf8) else { return nil }
        return (apiID, apiHash)
    }

    static func databaseEncryptionKey() throws -> Data {
        if let key = try get(account: databaseKeyAccount) { return key }
        var key = Data(count: 32)
        let status = key.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard status == errSecSuccess else { throw TelegramKeychainError(status) }
        try set(key, account: databaseKeyAccount)
        return key
    }

    private static func get(account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw TelegramKeychainError(status) }
        return data
    }

    private static func set(_ data: Data, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw TelegramKeychainError(updateStatus) }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else { throw TelegramKeychainError(status) }
    }
}

private struct TelegramKeychainError: LocalizedError {
    let status: OSStatus
    init(_ status: OSStatus) { self.status = status }
    var errorDescription: String? { "Could not securely store Telegram credentials (Keychain status \(status))." }
}
