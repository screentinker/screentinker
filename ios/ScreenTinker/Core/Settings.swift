import Foundation

/// What the setup screen stores. The pairing is NOT here — it lives in the Keychain (IdentityStore).
public final class Settings {
    public enum Orientation: String, CaseIterable, Identifiable {
        case any, landscape, portrait
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .any: return "Follow the device"
            case .landscape: return "Landscape"
            case .portrait: return "Portrait"
            }
        }
    }

    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public var serverOrigin: URL? {
        get { defaults.string(forKey: "serverOrigin").flatMap(URL.init(string:)) }
        set { defaults.set(newValue?.absoluteString, forKey: "serverOrigin") }
    }

    public var orientation: Orientation {
        get { Orientation(rawValue: defaults.string(forKey: "orientation") ?? "") ?? .any }
        set { defaults.set(newValue.rawValue, forKey: "orientation") }
    }
}
