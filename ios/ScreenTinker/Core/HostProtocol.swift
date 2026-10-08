import Foundation

/// The host protocol between this shell and the web player — the same one the Vega and webOS shells
/// speak (server/player/index.html, "Host bridge").
///
///   page  -> shell   {source:"screentinker-player", type:"host:hello"}
///                    {source:"screentinker-player", type:"host:command", action, payload}
///   shell -> page    {source:"screentinker-host",   type:"host:ready", capabilities, info}
///                    {source:"screentinker-host",   type:"host:result", action, ok, error?}
///
/// ⚠️ host:ready carries the pairing (deviceId + deviceToken) so a page whose web storage was cleared
/// gets its identity back instead of pairing as a new screen. That is the ONE secret on this channel:
/// never log a message whole.
public enum HostProtocol {
    public enum Incoming: Equatable {
        case hello
        case restart
        case setIdentity(deviceId: String, deviceToken: String)
        case clearIdentity
        case unknown(String)
    }

    /// Parses what the page posted (a JSON string, or a dictionary from WKScriptMessage.body).
    public static func parse(_ body: Any) -> Incoming? {
        var object: Any = body
        if let text = body as? String {
            guard let data = text.data(using: .utf8),
                  let decoded = try? JSONSerialization.jsonObject(with: data) else { return nil }
            object = decoded
        }
        guard let msg = object as? [String: Any],
              msg["source"] as? String == "screentinker-player",
              let type = msg["type"] as? String else { return nil }
        if type == "host:hello" { return .hello }
        guard type == "host:command", let action = msg["action"] as? String else { return .unknown(type) }
        switch action {
        case "restart":
            return .restart
        case "set-identity":
            let p = msg["payload"] as? [String: Any] ?? [:]
            guard let id = p["deviceId"] as? String, let token = p["deviceToken"] as? String,
                  !id.isEmpty, !token.isEmpty, id.count <= 200, token.count <= 4096 else {
                return .unknown(action)
            }
            return .setIdentity(deviceId: id, deviceToken: token)
        case "clear-identity":
            return .clearIdentity
        default:
            return .unknown(action)
        }
    }

    public struct Info: Equatable {
        public var version: String
        public var model: String
        public var os: String
        public var deviceId: String?
        public var deviceToken: String?
        public init(version: String, model: String, os: String, deviceId: String? = nil, deviceToken: String? = nil) {
            self.version = version; self.model = model; self.os = os
            self.deviceId = deviceId; self.deviceToken = deviceToken
        }
    }

    /// The shell announces NO extra capabilities: iOS gives an app no reboot, no panel power and no
    /// media volume, and a declared capability is a promise the dashboard turns into a button.
    public static let capabilities: [String] = []

    public static func ready(_ info: Info) -> [String: Any] {
        var i: [String: Any] = ["version": info.version, "model": info.model, "os": info.os]
        // Both halves or neither: an id without its token is the duplicate-row bug.
        if let id = info.deviceId, let token = info.deviceToken, !id.isEmpty, !token.isEmpty {
            i["deviceId"] = id
            i["deviceToken"] = token
        }
        return ["source": "screentinker-host", "type": "host:ready", "capabilities": capabilities, "info": i]
    }

    public static func result(action: String, ok: Bool, error: String? = nil) -> [String: Any] {
        var r: [String: Any] = ["source": "screentinker-host", "type": "host:result", "action": action, "ok": ok]
        if let error { r["error"] = error }
        return r
    }

    /// JavaScript that delivers `message` to the page: `window.postMessage(<json string>, '*')` on the
    /// page's own window, which is what the player's top-level listener accepts. The JSON is passed as
    /// a JS string literal produced by JSONSerialization, so nothing in it can break out of the call.
    public static func deliveryScript(_ message: [String: Any]) -> String? {
        guard let json = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]),
              let text = String(data: json, encoding: .utf8),
              let literal = try? JSONSerialization.data(withJSONObject: [text], options: []),
              var arrayText = String(data: literal, encoding: .utf8) else { return nil }
        // [ "..." ] -> "..."
        arrayText.removeFirst()
        arrayText.removeLast()
        return "window.postMessage(\(arrayText), '*');"
    }
}
