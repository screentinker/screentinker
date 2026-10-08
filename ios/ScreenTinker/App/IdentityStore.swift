import Foundation
import Security

/// The pairing (deviceId + deviceToken), kept by the shell so it survives the web view's storage
/// being cleared — the same job Vega's /data file does (vega/src/storage.ts). In the Keychain rather
/// than UserDefaults because the token is a credential; AfterFirstUnlock so a kiosk iPad that
/// restarts can still read it once it has been unlocked once.
final class IdentityStore {
    private let service = "com.screentinker.player.pairing"
    private let account = "device"

    func load() -> (deviceId: String, deviceToken: String)? {
        var query = base()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let id = obj["deviceId"], let token = obj["deviceToken"], !id.isEmpty, !token.isEmpty else { return nil }
        return (id, token)
    }

    func save(deviceId: String, deviceToken: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "deviceToken": deviceToken]) else { return }
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(base() as CFDictionary, attrs as CFDictionary) == errSecItemNotFound {
            var add = base()
            add.merge(attrs) { $1 }
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    func clear() {
        SecItemDelete(base() as CFDictionary)
    }

    private func base() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}
