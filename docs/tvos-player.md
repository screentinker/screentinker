# Apple TV: why there is no player, and what would have to change

This is a decision record, not a plan. It exists so the question is answered once.

## The wall

**tvOS ships no web view.** `WKWebView` is not in the public tvOS SDK and Apple's Human Interface
Guidelines state plainly that web views are not supported on tvOS. Every other ScreenTinker player is
`server/player/index.html` inside a shell — a WebView on Android, Fire TV and Vega, an iframe on webOS,
a `.wgt` on Tizen, an `roHtmlWidget` on BrightSign, a kiosk browser on Pi, Windows and ChromeOS. None
of that exists here.

The app cannot bring its own engine either. tvOS grants no JIT entitlement, so a bundled WebKit or
Chromium would interpret its JavaScript, and App Store guideline 2.5.6 requires web-browsing apps to
use Apple's WebKit — which tvOS does not offer to third parties. Private `UIWebView` is what gets apps
rejected, so it is a review risk rather than a rendering technique.

## What that costs, concretely

A native tvOS player could do images, video, HLS via `AVPlayer`, zones, schedules, proof-of-play,
volume, mute and offline cache. It could not do:

| gap | why |
| --- | --- |
| widgets | `/api/widgets/:id/render` returns HTML |
| HTML bundles | a bundle is a web page by definition |
| YouTube | see below |
| web PiP | the same iframe branch |
| shader transitions | the 15 GLSL files would need a Metal port |

⚠️ **YouTube is not recoverable.** The YouTube app on Apple TV is Google's own native client against
their private backend — they are allowed to fetch their own streams, and they do not publish that
player. What Google offers third parties is the iframe embed, which their own terms require to run in
a web view, and whose supported platforms are iOS, iPadOS and macOS. Not tvOS. Scraping a stream URL
out of a watch page breaks their terms and breaks in practice whenever they change the client. Opening
`youtube://` hands the screen to their app, which in Single App Mode means the sign stops being a sign.

## The part that is not about rendering at all

Even with every gap closed, an Apple TV is a poor signage player:

- **No sideloading.** App Store, TestFlight (90-day builds), or the Enterprise Program.
- **App Review sits in the release path.** The cadence stops being ours.
- ⚠️ **Unattended operation requires MDM.** Without Single App Mode on a supervised device, an Apple TV
  sleeps and does not relaunch the app after a power cut. A player that needs someone to pick up a
  remote is not a player.

A Raspberry Pi costs a fraction of an Apple TV, sideloads freely, survives a power cut, outputs
arbitrary resolutions — which is what LED walls need — and runs the real web player with every feature
in it. There is no customer for whom the Apple TV is the better answer.

## What would change this

One thing: **Apple shipping a public web view on tvOS.** Then it is a Vega-shaped port — a shell around
the existing player — and a week of work rather than a second implementation. Nothing else on this
page is the blocker; they are all downstream of that one.

## What was built and then removed

A `tvos` platform family and capability baseline briefly existed and were removed with this document.
A baseline for a platform with no player is dead code describing a product that does not exist, and the
next person to read it would reasonably assume an app was coming.

⚠️ If that work is ever restored, the ordering matters: the family check must sit **before** the
`android_version` test, because a tvOS client sends none and would otherwise be classified as a browser
— inheriting `playback.widget`, `playback.youtube` and `playback.bundle`, which is three controls with
nothing behind them.

The public-facing version of this page is
[`frontend/guides/apple-tv-digital-signage.html`](../frontend/guides/apple-tv-digital-signage.html).
