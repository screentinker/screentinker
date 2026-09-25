# Apple TV player

## The constraint that decides everything

**tvOS ships no web view.** `WKWebView` is not part of the public tvOS SDK and there is no browser on
the device. Every other ScreenTinker player is `server/player/index.html` inside a shell — a WebView on
Android, Fire TV and Vega, an iframe on webOS, a `.wgt` on Tizen, an `roHtmlWidget` on BrightSign, a
kiosk browser on Pi, Windows and ChromeOS. None of that is available here.

Nor can the app carry its own engine:

- tvOS grants no JIT entitlement, so a bundled WebKit, Chromium or Servo would run its JavaScript in an
  interpreter — one to two orders of magnitude slower than the JIT the web player assumes.
- App Store Review Guideline 2.5.6 requires apps that browse the web to use the appropriate WebKit
  framework, which tvOS does not offer to third parties.

So the page cannot run on an Apple TV at any price. This player is native.

## What it is NOT: a second implementation

The expensive failure here would be rewriting the whole player in Swift and letting the two drift —
two schedule evaluators disagreeing about what should be on screen at 17:59 on a Sunday, discovered by
a customer.

**`JavaScriptCore` is public on tvOS.** The player's decision-making is already factored into modules
with almost no DOM in them, because the Tizen port needed the same separation:

| module | lines | DOM references |
| --- | --- | --- |
| `media-cache.js` | 434 | 0 |
| `schedule-eval.js` | 220 | 3 |
| `device-control.js` | 216 | 5 |
| `play-order.js` | 134 | 1 |
| `offline-play-queue.js` | 134 | 1 |
| `capabilities.js` | 129 | 4 |
| `player.js` (rendering) | 1766 | 76 |

The first six run unmodified in JavaScriptCore. They are tested against `shared/schedule-vectors.json`
and the other shared vector files, which the server and the Tizen player are also tested against — so
"does the Apple TV agree with the server about what should be playing" is answered by a test rather
than by hope. Only `player.js` is replaced, and that is the part tvOS is better at.

⚠️ JSC on tvOS runs **interpreted**, without JIT. That is irrelevant here: this code makes a decision
roughly once a second, not sixty times.

## The host shims

JavaScriptCore is a JavaScript engine, not a browser: no DOM, no CSS, no layout. The logic modules do
not need those, but they do use a small set of non-DOM web APIs. The whole surface, measured from
`server/player/index.html`:

| API | uses | native backing |
| --- | --- | --- |
| `localStorage` | 51 | `UserDefaults`, or a plist for anything large |
| `URL` | 47 | `Foundation.URL`, or a small JS polyfill |
| `setTimeout` / `setInterval` | 57 | `DispatchQueue` timers |
| `fetch` | 17 | `URLSession` |
| `WebSocket` | 3 | `URLSessionWebSocketTask` |
| `performance.now`, `crypto`, `Intl` | 4 | `CACurrentMediaTime`, `SecRandomCopyBytes`; JSC has Intl |
| `navigator.*` | 10 | constants |
| `caches`, `serviceWorker` | 10 | not shimmed — offline caching is native (see below) |

That is roughly twenty host objects. It is a bounded, testable list, and it is not a browser.

## Rendering

- **Video and HLS** — `AVPlayer`. AVFoundation is a stronger HLS client than any `<video>` element,
  and this is the platform that most deserves live channels. ⚠️ But `playback.hls` is in **no**
  baseline, here or anywhere, by design: a live channel is a URL the *player* opens on its own LAN, so
  an undeclared or legacy device must be refused rather than handed a stream it renders as a black
  screen. The shipped app declares it, and a declared set wins over the baseline — which is the right
  way round, because then the capability tracks the build rather than the server's opinion of it.
- **Images, zones, transitions, picture-in-picture** — UIKit / SwiftUI and Core Animation.
- **Offline cache** — native file cache, replacing the service worker.

## Widgets, without costing the server anything

Of the nine builtin widget types, **eight are data plus layout**: `clock`, `weather`, `rss`, `text`,
`social`, `directory-board`, `directory-search`, `diag-smoothness`. Each is a SwiftUI view fed by the
widget data endpoints that already exist. No HTML is involved and nothing is rendered on the server.

The ninth, `webpage`, is arbitrary HTML and cannot be rendered without a browser.

⚠️ **Server-side rasterisation was considered and rejected.** `server/lib/embedded-render.js` already
drives Puppeteer to turn a layout — widgets and web pages included — into an image, and it would work.
It is how e-paper renders. But e-paper wakes every few minutes and a television does not: a fleet of
Apple TVs each refreshing a clock widget every few seconds is a Puppeteer page render per screen per
refresh, and the cost lands on the server rather than on the device that has a perfectly good GPU. The
native widget is cheaper everywhere.

`playback.widget` is therefore **not** in the tvOS baseline, even though eight of nine types work. A
capability that is true for eight and false for one is a capability that lies, and a control that
silently does nothing on one widget type is worse than a control that is absent. It goes in when the
dashboard can express "widgets, except that one".

## What is permanently absent

| capability | why |
| --- | --- |
| `playback.widget` | see above — eight of nine, which is not the same as yes |
| `playback.bundle` | an HTML bundle is a web page by definition |
| `playback.youtube` | no embed without a web view; proxying breaks YouTube's terms |
| `playback.rtsp` | AVPlayer does not speak RTSP |
| `display.rotation` | tvOS is landscape-only |
| `display.power`, `display.brightness` | no public API to drive the panel |
| `system.reboot` | an app cannot restart the box |
| `system.self_update` | App Store only |
| `system.kiosk` | Single App Mode requires MDM supervision |
| `remote.input` | no input injection on tvOS |

`remote.screenshot` IS present, on the same terms as Android's fallback path: a snapshot of the
player's own view hierarchy. A real picture of the content, not a dead button.

## Distribution, which is a product decision and not a technical one

- **No sideloading.** The App Store, TestFlight (builds expire after 90 days), or the Apple Developer
  Enterprise Program ($299/year, internal-use only, and Apple enforces that).
- **App Review sits between you and every release.** An app that points at a customer-supplied server
  is ordinary and reviewable, but the cadence is no longer ours.
- **Unattended operation needs MDM.** Without Single App Mode an Apple TV sleeps and does not relaunch
  the app on power-up. ⚠️ A signage player that needs someone to pick up a remote after a power cut is
  not a signage player. This should be stated on the hardware page before anyone buys one.

## Building it

The repository is public, so GitHub Actions provides **free macOS runners**. `xcodebuild` with a tvOS
simulator destination builds and tests on every push, with no Mac and no virtual machine in the loop.
Signing and upload to App Store Connect can run on the same runner with an App Store Connect API key.

## Status

The server side landed first: `platformFamily()` recognises tvOS by `platform` or `client_type`, and
`BASELINE.tvos` carries the twelve capabilities above. ⚠️ The family check sits **before** the
`android_version` test — a tvOS client sends none, so without that ordering it would be classified as a
browser and inherit `playback.widget`, `playback.youtube` and `playback.bundle`: three controls with
nothing behind them. `server/test/player-capabilities-tvos.test.js` asserts it.

The app itself is not written.
