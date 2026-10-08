import SwiftUI
import UIKit

@main
struct ScreenTinkerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)      // the home indicator, on a sign
                .ignoresSafeArea()
        }
    }
}

/// Which screen is up, and the settings behind it.
final class AppModel: ObservableObject {
    let settings = Settings()
    @Published var serverOrigin: URL?
    @Published var showingSetup: Bool

    init() {
        let origin = settings.serverOrigin
        serverOrigin = origin
        showingSetup = origin == nil
        AppDelegate.orientation = settings.orientation
    }

    func connect(origin: URL, orientation: Settings.Orientation) {
        settings.serverOrigin = origin
        settings.orientation = orientation
        AppDelegate.applyOrientation(orientation)
        serverOrigin = origin
        showingSetup = false
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            if model.showingSetup || model.serverOrigin == nil {
                SetupView()
            } else if let origin = model.serverOrigin {
                PlayerScreen(origin: origin)
                    .id(origin)
            }
        }
        .background(Color.black)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orientation: Settings.Orientation = .any

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // A sign never dims or locks while the app is in front. iOS restores the idle timer when the
        // app leaves the foreground, so this is set again on every activation (PlayerScreen).
        UIApplication.shared.isIdleTimerDisabled = true
        return true
    }

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        AppDelegate.mask(for: AppDelegate.orientation)
    }

    static func mask(for o: Settings.Orientation) -> UIInterfaceOrientationMask {
        switch o {
        case .any: return .all
        case .landscape: return .landscape
        case .portrait: return [.portrait, .portraitUpsideDown]
        }
    }

    static func applyOrientation(_ o: Settings.Orientation) {
        orientation = o
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            ws.windows.first?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            ws.requestGeometryUpdate(.iOS(interfaceOrientations: mask(for: o))) { _ in }
        }
    }
}
