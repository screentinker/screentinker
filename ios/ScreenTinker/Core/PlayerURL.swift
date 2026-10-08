import Foundation

/// The address the app opens: `<server>/player?host=ios`.
///
/// `host=ios` is what the web player checks, together with the message handler this app installs,
/// before it treats the page as running inside this shell (server/player/index.html `onIOS()`).
/// The query string alone is not enough — a Safari tab with the same URL stays a browser.
public enum PlayerURL {
    public enum Problem: Error, Equatable {
        case empty
        case notHTTP
        case noHost
    }

    /// Normalises what someone typed into a server origin: adds https:// when no scheme was given,
    /// drops any path, query or fragment, and refuses anything that is not http(s).
    public static func origin(from typed: String) -> Result<URL, Problem> {
        var text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .failure(.empty) }
        if !text.contains("://") { text = "https://" + text }
        guard var parts = URLComponents(string: text) else { return .failure(.noHost) }
        guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return .failure(.notHTTP)
        }
        guard let host = parts.host, !host.isEmpty else { return .failure(.noHost) }
        parts.scheme = scheme
        parts.host = host.lowercased()
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        parts.user = nil
        parts.password = nil
        guard let url = parts.url else { return .failure(.noHost) }
        return .success(url)
    }

    /// The player page on that server, tagged for this shell.
    public static func player(for origin: URL) -> URL {
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false) ?? URLComponents()
        parts.path = "/player"
        parts.queryItems = [URLQueryItem(name: "host", value: "ios")]
        return parts.url ?? origin
    }

    /// True when `url` is on the same origin as the player — the only place the shell lets the
    /// top-level page navigate. Widgets and YouTube run in iframes and are unaffected.
    public static func isSameOrigin(_ url: URL, as origin: URL) -> Bool {
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme == "https" ? 443 : (u.scheme == "http" ? 80 : nil)) }
        return url.scheme?.lowercased() == origin.scheme?.lowercased()
            && url.host?.lowercased() == origin.host?.lowercased()
            && port(url) == port(origin)
    }
}
