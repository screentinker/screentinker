import Network
import SwiftUI
import UIKit
import WebKit

/// The sign: the web player, full screen, in a WKWebView this app keeps alive.
struct PlayerScreen: View {
    let origin: URL
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        PlayerWebView(origin: origin, onSetupRequested: { model.showingSetup = true },
                      onOriginChanged: { model.settings.serverOrigin = $0 })
            .ignoresSafeArea()
            .background(Color.black)
            .onChange(of: scenePhase) { phase in
                // iOS hands the idle timer back whenever the app leaves the foreground.
                if phase == .active { UIApplication.shared.isIdleTimerDisabled = true }
            }
    }
}

struct PlayerWebView: UIViewRepresentable {
    let origin: URL
    let onSetupRequested: () -> Void
    let onOriginChanged: (URL) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(origin: origin, onSetupRequested: onSetupRequested, onOriginChanged: onOriginChanged)
    }

    func makeUIView(context: Context) -> WKWebView {
        let c = context.coordinator
        let config = WKWebViewConfiguration()
        // Autoplay with sound, inline: nobody ever taps a sign to start its video.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsPictureInPictureMediaPlayback = false
        config.allowsAirPlayForMediaPlayback = false
        // The default (persistent) store: the page's own localStorage pairing survives app restarts.
        config.websiteDataStore = .default()
        config.userContentController.add(WeakScriptHandler(c), name: Coordinator.handlerName)

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.allowsLinkPreview = false
        web.navigationDelegate = c
        web.uiDelegate = c
        if #available(iOS 16.4, *) {
            #if DEBUG
            web.isInspectable = true
            #endif
        }

        // Three fingers held for three seconds: back to setup. Recognised alongside the page's own
        // touches, so an interactive sign keeps working.
        let hold = UILongPressGestureRecognizer(target: c, action: #selector(Coordinator.held(_:)))
        hold.numberOfTouchesRequired = 3
        hold.minimumPressDuration = 3
        hold.delegate = c
        web.addGestureRecognizer(hold)

        c.webView = web
        c.startMonitoring()
        c.load()
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    static func dismantleUIView(_ uiView: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        uiView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.handlerName)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                             UIGestureRecognizerDelegate {
        static let handlerName = "screentinker"
        weak var webView: WKWebView?
        private(set) var origin: URL
        private let onSetupRequested: () -> Void
        private let onOriginChanged: (URL) -> Void
        private let identity = IdentityStore()
        private let monitor = NWPathMonitor()
        private var lastLoadFailed = false
        private var retryDelay: TimeInterval = 5
        private var retryTimer: Timer?
        /// A load this shell started is still provisional: its server redirects may change the origin.
        private var shellLoadInFlight = false

        init(origin: URL, onSetupRequested: @escaping () -> Void, onOriginChanged: @escaping (URL) -> Void) {
            self.origin = origin
            self.onSetupRequested = onSetupRequested
            self.onOriginChanged = onOriginChanged
            super.init()
            // A pairing stored before it was bound to an origin belongs to the server this app is set to.
            if let pair = identity.load(), pair.origin == nil {
                identity.save(deviceId: pair.deviceId, deviceToken: pair.deviceToken, origin: origin)
            }
        }

        func load() {
            retryTimer?.invalidate()
            shellLoad(PlayerURL.player(for: origin))
        }

        private func shellLoad(_ url: URL) {
            shellLoadInFlight = true
            webView?.load(URLRequest(url: url))
        }

        // MARK: network — the page reconnects its own socket; this only covers a load that never happened.
        func startMonitoring() {
            monitor.pathUpdateHandler = { [weak self] path in
                guard path.status == .satisfied else { return }
                DispatchQueue.main.async {
                    guard let self, self.lastLoadFailed else { return }
                    self.retryDelay = 5
                    self.load()
                }
            }
            monitor.start(queue: DispatchQueue(label: "screentinker.path"))
        }

        func stop() {
            monitor.cancel()
            retryTimer?.invalidate()
        }

        private func scheduleRetry() {
            lastLoadFailed = true
            retryTimer?.invalidate()
            let delay = retryDelay
            retryDelay = min(retryDelay * 2, 60)
            retryTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in self?.load() }
        }

        // MARK: WKNavigationDelegate
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url else {
                decisionHandler(.allow)          // iframes: widgets, YouTube, bundles
                return
            }
            // Anything top-level off the player, or to another server's player the shell did not load
            // itself (a move is the page's move-server command), would take the sign away. Stay put.
            switch PlayerURL.decide(url, current: origin, shellLoadInFlight: shellLoadInFlight) {
            case .allow:
                decisionHandler(.allow)
            case .cancel:
                decisionHandler(.cancel)
            case .retag(let tagged):
                decisionHandler(.cancel)
                shellLoad(tagged)
            case .adopt(let moved):
                origin = moved
                onOriginChanged(moved)
                decisionHandler(.allow)
            }
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            shellLoadInFlight = false
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            lastLoadFailed = false
            retryDelay = 5
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            // A navigation this shell cancelled (a retag, a refused address) is not a failed load.
            let e = error as NSError
            if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
            shellLoadInFlight = false
            scheduleRetry()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            scheduleRetry()
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // iOS kills a web content process under memory pressure; a sign must come back by itself.
            webView.reload()
        }

        // MARK: WKUIDelegate — window.open and target=_blank never leave the sign.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            nil
        }

        // MARK: the host bridge
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let incoming = HostProtocol.parse(message.body) else { return }
            // Only the player on this shell's server speaks for the sign.
            let so = message.frameInfo.securityOrigin
            guard let page = PlayerURL.origin(scheme: so.`protocol`, host: so.host, port: so.port),
                  PlayerURL.isSameOrigin(page, as: origin) else { return }
            switch incoming {
            case .hello:
                send(HostProtocol.ready(info(page: page)))
            case .restart:
                send(HostProtocol.result(action: "restart", ok: true))
                webView?.reload()
            case let .setIdentity(deviceId, deviceToken):
                identity.save(deviceId: deviceId, deviceToken: deviceToken, origin: origin)
                send(HostProtocol.result(action: "set-identity", ok: true))
            case .clearIdentity:
                identity.clear()
                send(HostProtocol.result(action: "clear-identity", ok: true))
            case .moveServer(let text):
                // set_server_url, verified by the player over its authenticated socket. The pairing stays
                // bound to the old server: the new page enrols with the k= in the address.
                guard let target = PlayerURL.moveTarget(from: text),
                      case .success(let moved) = PlayerURL.origin(from: target.absoluteString) else {
                    send(HostProtocol.result(action: "move-server", ok: false, error: "not a player address"))
                    return
                }
                send(HostProtocol.result(action: "move-server", ok: true))
                origin = moved
                onOriginChanged(moved)
                shellLoad(target)
            case .unknown(let what):
                send(HostProtocol.result(action: what, ok: false, error: "not supported on iOS"))
            }
        }

        private func send(_ message: [String: Any]) {
            guard let js = HostProtocol.deliveryScript(message) else { return }
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }

        private func info(page: URL) -> HostProtocol.Info {
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
            let d = UIDevice.current
            var pair = identity.load()
            if let p = pair, !PlayerURL.releasesIdentity(boundTo: p.origin, page: page, shell: origin) { pair = nil }
            return HostProtocol.Info(version: version, model: "\(d.model) (\(Self.machine()))",
                                     os: "\(d.systemName) \(d.systemVersion)",
                                     deviceId: pair?.deviceId, deviceToken: pair?.deviceToken)
        }

        static func machine() -> String {
            var u = utsname()
            uname(&u)
            return withUnsafeBytes(of: &u.machine) { raw in
                String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
            }
        }

        // MARK: the setup gesture
        @objc func held(_ g: UILongPressGestureRecognizer) {
            if g.state == .began { onSetupRequested() }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle with the coordinator.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}
