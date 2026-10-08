# iPad and iPhone app (beta)

`ios/` is a small SwiftUI app that shows the web player full screen in a `WKWebView`, opened as
`<server>/player?host=ios`, and keeps the device awake. iOS / iPadOS 16 or later. It is a shell, the same
shape as the Vega app: the player itself is `server/player/index.html`, served fresh by your server.

> **Status: beta.** CI compiles it and runs its unit tests on an iOS simulator. It has not run on a real
> iPad or iPhone yet.

## What the shell does

- **Setup screen**: the server address (normalised: `https://` added, any path dropped, only http(s))
  and an orientation lock (any / landscape / portrait). Three fingers held for three seconds bring it
  back.
- **Player**: inline autoplay with sound (`allowsInlineMediaPlayback`,
  `mediaTypesRequiringUserActionForPlayback = []`), no scrolling or link previews, black background, the
  status bar and home indicator hidden, `isIdleTimerDisabled` re-armed every time the app is active.
- **Staying up**: a failed load retries with backoff (5 s → 60 s) and immediately when the network
  returns (`NWPathMonitor`); a web content process iOS kills under memory pressure is reloaded.
- **Navigation**: top-level navigation stays on the player. When the dashboard moves the screen to
  another server (`set_server_url`), the player navigates to `<new>/player?k=…`; the shell re-issues it
  with `host=ios` and remembers the new server.

## The host bridge

The same protocol as the Vega and webOS shells (server/player/index.html, "Host bridge"), over
`window.webkit.messageHandlers.screentinker` one way and `window.postMessage` the other:

| page → shell | shell does |
|---|---|
| `host:hello` | answers `host:ready` with **no capabilities**, the app version, device model and OS, and the pairing if it holds one |
| `restart` | reloads the web view |
| `set-identity {deviceId, deviceToken}` | stores the pairing in the **Keychain** (`AfterFirstUnlockThisDeviceOnly`) |
| `clear-identity` | deletes it |

The page treats itself as inside the app only when `?host=ios` **and** the message handler exist
(`onIOS()`), so a Safari tab with the same URL stays a browser. It then registers as `platform: 'ios'`,
which the server's `platformFamily()` keys the `ios` family on. It shares only Vega's *shell*
behaviours — identity, restart, waiting for `host:ready` — never Vega's Fire TV rendering concessions.

## What iOS does not allow

| | why | so |
|---|---|---|
| volume | `HTMLMediaElement.volume` is read-only (always 1) on iOS | `audio.volume` withdrawn; mute works |
| offline media cache | a WKWebView runs service workers only for app-bound domains listed in Info.plist at build time — a customer's server cannot be | no `offline.cache`; the playlist and identity still survive restarts |
| screen off/on, reboot, brightness | no API for an app | none declared |
| self-update | apps update through Apple | none |

## Kiosk

- One device: **Guided Access** (Settings → Accessibility → Guided Access), started from the app.
- A fleet: **Single App Mode** (or Autonomous Single App Mode) on supervised devices from your MDM. This
  is also what brings the app back after a restart — without it, a rebooted iPad waits at the lock screen.

## Build

```sh
brew install xcodegen
cd ios && xcodegen generate          # ScreenTinker.xcodeproj (generated, not committed)
open ScreenTinker.xcodeproj           # set your team under Signing, run on a device
```

## Distribution (needs an Apple Developer account; no credentials are in this repository)

- **TestFlight**: Product → Archive, upload, invite testers. Builds expire after 90 days.
- **App Store**: the same archive, submitted for review. The app is a container for the customer's own
  server, so review notes should explain that and supply a test server and pairing.
- **MDM / Apple Business Manager**: distribute as a custom app to your organisation, then push it with
  Single App Mode.

`NSAllowsArbitraryLoadsInWebContent` (web content only) lets the player reach an http server on a LAN;
the app's own requests keep App Transport Security's defaults.

## What CI verifies (`.github/workflows/apple.yml`)

- `xcodegen generate` and `xcodebuild test` on an iOS simulator, unsigned: the app compiles, and the
  unit tests for the URL rules and the host protocol pass (including that a hostile string cannot break
  out of the `postMessage` call).
- The same core and tests also compile and pass on Linux under Swift 5.10 (how they were first checked).

## What only a real device can confirm

Autoplay with sound in practice, YouTube and widgets in the web view, the Keychain pairing surviving a
web-data clear, Guided Access / Single App Mode behaviour, the Local Network prompt, and performance of
long playlists on older iPads.
