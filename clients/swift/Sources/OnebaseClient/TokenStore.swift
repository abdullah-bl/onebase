import Foundation

/// Where the client keeps the auth token between runs. Provide your own, or use
/// `KeychainTokenStore` (the default on Apple platforms) or `FileTokenStore`.
public protocol OnebaseTokenStore: AnyObject {
    func loadToken() -> String?
    func saveToken(_ token: String?)
}

#if canImport(Security)
import Security

/// Keeps the session token in the Keychain (recommended on iOS and macOS).
public final class KeychainTokenStore: OnebaseTokenStore {
    private let service: String
    private let account: String

    public init(service: String = "onebase", account: String = "session") {
        self.service = service
        self.account = account
    }

    public func loadToken() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = kCFBooleanTrue
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func saveToken(_ token: String?) {
        if let token {
            let data = Data(token.utf8)
            var update = baseQuery
            update[kSecValueData as String] = data
            if SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary) == errSecSuccess { return }
            var add = baseQuery
            add[kSecValueData as String] = data
            SecItemAdd(add as CFDictionary, nil)
        } else {
            SecItemDelete(baseQuery as CFDictionary)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
#endif

/// Keeps the token in a file with owner-only permissions (for platforms without a Keychain,
/// or when you'd rather manage it yourself).
public final class FileTokenStore: OnebaseTokenStore {
    private let url: URL
    private let queue = DispatchQueue(label: "onebase.token-file")

    public init(fileURL: URL) {
        url = fileURL
    }

    public func loadToken() -> String? {
        queue.sync { try? String(contentsOf: url, encoding: .utf8) }
    }

    public func saveToken(_ token: String?) {
        queue.async {
            if let token {
                try? Data(token.utf8).write(to: self.url, options: .atomic)
                try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: self.url.path)
            } else {
                try? FileManager.default.removeItem(at: self.url)
            }
        }
    }
}
