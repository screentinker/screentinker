import SwiftUI

/// The first screen, and the one three fingers held for three seconds bring back: the server address
/// and an orientation lock. Everything else is configured from the dashboard.
struct SetupView: View {
    @EnvironmentObject private var model: AppModel
    @State private var typed = ""
    @State private var orientation: Settings.Orientation = .any
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://signage.example.com", text: $typed)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(connect)
                } header: {
                    Text("Server address")
                } footer: {
                    Text("The address of your ScreenTinker server. After connecting, this screen shows a pairing code: enter it under Add Display in the dashboard.")
                }
                Section("Orientation") {
                    Picker("Orientation", selection: $orientation) {
                        ForEach(Settings.Orientation.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                if let problem {
                    Section { Text(problem).foregroundColor(.red) }
                }
                Section {
                    Button("Connect", action: connect)
                        .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Section {
                    Text("For a screen people can reach, lock the device into this app with Guided Access (Settings → Accessibility) or Single App Mode from your device management. To come back here, hold three fingers on the screen for three seconds.")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("ScreenTinker")
        }
        .onAppear {
            typed = model.serverOrigin?.absoluteString ?? typed
            orientation = model.settings.orientation
        }
    }

    private func connect() {
        switch PlayerURL.origin(from: typed) {
        case .success(let origin):
            problem = nil
            model.connect(origin: origin, orientation: orientation)
        case .failure(.empty):
            problem = "Type the server address."
        case .failure(.notHTTP):
            problem = "The address must start with https:// or http://."
        case .failure(.noHost):
            problem = "That does not look like a server address."
        }
    }
}
