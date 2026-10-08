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

    /// `url` with `host=ios` (and no other `host`), the rest of its query — `k=` on a move — kept.
    public static func tagged(_ url: URL) -> URL? {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let items = parts.queryItems ?? []
        parts.queryItems = items.filter { $0.name != "host" } + [URLQueryItem(name: "host", value: "ios")]
        return parts.url
    }

    public static func isTagged(_ url: URL) -> Bool {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        return items.contains(where: { $0.name == "host" && $0.value == "ios" })
    }

    /// What the top-level page may do (PlayerScreen's decidePolicyFor).
    public enum Navigation: Equatable {
        case allow
        case cancel
        /// Cancel, and load this instead: the same address with our host tag.
        case retag(URL)
        /// Allow, and remember this as the server from now on.
        case adopt(URL)
    }

    /// ⚠️ Another origin's /player is NOT a server move by itself: any frame that can navigate the top
    /// window (a web overlay, a widget) could send the sign to a server of its choosing, which would then
    /// be handed the pairing. A move arrives as the page's `move-server` command, and the shell loads it
    /// (`moveTarget`); the only other cross-origin /player accepted is a server redirect of a load the
    /// shell itself started (`shellLoadInFlight`: http → https, a renamed host).
    public static func decide(_ url: URL, current origin: URL, shellLoadInFlight: Bool) -> Navigation {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { return .allow }
        let same = isSameOrigin(url, as: origin)
        guard url.path.hasPrefix("/player") else { return same ? .allow : .cancel }
        if !same && !shellLoadInFlight { return .cancel }
        if !isTagged(url) {
            // Without our tag the page would no longer know it is inside this app.
            guard let t = tagged(url) else { return .cancel }
            return .retag(t)
        }
        if same { return .allow }
        guard case .success(let moved) = PlayerURL.origin(from: url.absoluteString) else { return .cancel }
        return .adopt(moved)
    }

    /// The page's `move-server` address, checked and tagged: an http(s) `/player` page on a host.
    public static func moveTarget(from text: String) -> URL? {
        guard let url = URL(string: text), case .success = PlayerURL.origin(from: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.path.hasPrefix("/player") else { return nil }
        return tagged(url)
    }

    /// The origin a WKSecurityOrigin describes, as a URL (port 0 = the scheme's default).
    public static func origin(scheme: String, host: String, port: Int) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme.lowercased()
        parts.host = host.lowercased()
        if port > 0 { parts.port = port }
        return parts.url
    }

    /// Whether the pairing stored for `boundOrigin` may go to a page on `page`, the shell being on
    /// `origin`. Only the server that issued it gets it back: a page anywhere else — or a pairing that
    /// says nothing about where it came from — gets none and pairs (or enrols with its `k=`) itself.
    public static func releasesIdentity(boundTo boundOrigin: String?, page: URL?, shell origin: URL) -> Bool {
        guard let page, isSameOrigin(page, as: origin),
              let boundOrigin, let bound = URL(string: boundOrigin) else { return false }
        return isSameOrigin(bound, as: origin)
    }
}
