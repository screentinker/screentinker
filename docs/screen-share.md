# Share your screen to a screen

Present your laptop on a ScreenTinker screen from a web browser — in a meeting room, a classroom,
a lobby — and the screen goes back to its normal content the moment you stop.

- **Editors and admins** share from the dashboard: **Share my screen** on a screen's page
  (Advanced), or on a screen card / the **Share my screen** task in the Simple view.
- **Guests** (no account) share in a meeting room with the **code the screen shows**: they open
  `/share` on their laptop (or scan the QR next to the code), type the code, and present. This is
  off by default and switched on per screen by a workspace admin.
- **Phones** present too: their **camera** from the `/share` page (any phone browser), or — on
  Android — their **screen** through the **ScreenTinker Manager** app, with no account
  ([below](#phones-camera-and-the-android-app)).
- **Several people at once** (up to 4) when a workspace admin allows it on that screen: the screen
  tiles them ([below](#several-people-at-once)).

While a share is running the screen shows it **fullscreen**, with a small *"Shared by &lt;name&gt;"*
badge (*"· guest"* for a guest). Sound is optional (tick **Include sound**). The playlist underneath
is paused and muted, and comes back when the share ends — whether the sharer pressed Stop, closed
the tab or lost their connection, an editor stopped it, or the time limit (60 minutes by default)
was reached.

Nothing is recorded. The video goes **directly from the sharer's browser to the screen**; the
ScreenTinker server never sees it.

---

## Which screens can show a share

| Player | Screen share | How | Remote viewer while a share is up | Verified here |
|---|---|---|---|---|
| **Web player** (`/player` in Chrome, Edge, Firefox, Safari; ChromeOS; a Pi or PC running a browser kiosk; the desktop/Electron shell) | **Yes** | `/player/screen-share.js` (the receiver), declared when the browser has `RTCPeerConnection` with `addTransceiver` (Chromium 69+). | The shared picture with its badge (`drawScreenShare` in the capture). | End to end in headless Chrome: guest, editor, remote-viewer screenshot, multi share. |
| Native **Android** player (APK) | **Yes** | `ScreenShareReceiver` on the libwebrtc Talk already bundles (`io.getstream:stream-webrtc-android`); `ScreenShareOverlay` draws the share into a `TextureView` over the ducked content, with the badge and the meeting-room code + QR. Receive-only, needs no permission, so it is declared unconditionally. | The shared picture with its badge: the TextureView is readable (and turns with a portrait/wall transform, unlike Talk's SurfaceView), and the capture redraws the overlay on top so the paused content video never shows through. MediaProjection/accessibility tiers capture the display as it is. | JVM unit tests for the wire handling (`ScreenShareProtocolTest`) and a full Kotlin compile. **Not run on a device here** (no device/emulator; `assembleDebug` stops at the missing release key). |
| Native **Raspberry Pi**, **Windows** and **macOS** players | **Yes** | They already run the server's WebRTC modules in a QtWebEngine page (Talk, live video); that page now loads `/player/screen-share.js`, so the receiver, overlay and badge are the web player's own, in Chromium. The meeting-room code is a QML badge (`ShareCode.qml`) so it never sits a web layer over a touch screen. | The shared picture: `grabWindow()` reads the WebEngine layer. | That exact page (built by the native code) run in Chromium against a real server, driven like `app.py` drives it: plays fullscreen with the badge, reports per session, stops clean. pytest for the event handling; the QML badge rendered offscreen. **Not run on a Pi/Windows/Mac here.** QtWebEngine has no H.264 in its official builds, so the share negotiates VP8/VP9 — a Pi decodes that in software (fine for slides, heavy for 1080p video). |
| **iPad / iPhone** app (iOS 16+) | **Yes** | The web player in `WKWebView` (WebRTC since iOS 14.3; the app plays inline media without a gesture). | As the web player. | Capability unit test only. **Not run on an iPad here.** |
| **Samsung Tizen** (TV and SSSP signage) | **Tizen 10+ only** (2026 models) | The web player's receiver copied into the .wgt (`build-wgt.sh`) + `js/screen-share-tizen.js`; declared only on Tizen ≥ 10 **and** when the receiver's probe passes. The content steps aside as for screen-off (AVPlay torn down — its plane composites above the DOM). | An honest card: *"A screen share is on screen — it can't be captured on this TV"* and the sharer's name. Tizen decodes `<video>` onto a hardware plane a canvas cannot read. | Unit tests (version gate, wiring, card). **Not run on a Samsung display here.** Tizen 9.0 is "partially" supported per Samsung and deliberately not claimed until tested. |
| **LG webOS** (TV and signage) | No | LG: *"WebRTC is only available on contracted partner apps."* The web player withholds the capability inside the webOS shell. | — | — |
| **BrightSign** | No | WebRTC in `roHtmlWidget` sits behind `security_params.camera_enabled`, documented for USB cameras, which the player does not set; receive-only is not documented. Withheld. | — | — |
| **Amazon Vega** (Fire TV) | No | The Vega WebView does not document WebRTC either way. Withheld until tested on a stick. | — | — |
| **Apple TV (tvOS)** | No | tvOS has no WebKit/WKWebView; would need a native WebRTC SDK. There is no tvOS player. | — | — |
| **Roku** | No | Roku OS has no web engine and no WebRTC. | — | — |
| **e-ink** | No | — | — | — |

Sources (checked 2026-10): Samsung web engine specifications, "Real-time communication" —
<https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html> and
<https://developer.samsung.com/signage/develop/specifications/web-engine-specifications.html>;
LG webOS TV web engine — <https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine>
and the LG developer forum answer <https://forum.webostv.developer.lge.com/t/inquiry-regarding-webrtc-support-on-webos-tv/28059>;
BrightSign `roHtmlWidget` — <https://docs.brightsign.biz/develop/rohtmlwidget>;
Apple `WKWebView` availability — <https://developer.apple.com/documentation/webkit/wkwebview> and
<https://webkit.org/blog/11353/mediarecorder-api/>;
Amazon Vega WebView — <https://developer.amazon.com/docs/vega/0.24/develop-your-app-with-webview.html>;
Qt WebEngine features — <https://doc.qt.io/qt-6/qtwebengine-features.html>;
Roku — <https://partnersuccess.roku.com/hc/en-us/articles/360060167853-Does-Roku-support-WebRTC-and-Play-WebRTC-streams>.

The dashboard only offers screens that declare `remote.screen_share` (`lib/player-capabilities.js`;
it is in no platform baseline, so an older player is never assumed able). A screen that cannot show
a share says so on its page and in the Simple view, naming its player — *"This screen can't show a
screen share (Roku)"*, *"… yet (Android). Update the ScreenTinker app on it and it can."*, or for
Tizen *"It needs a Samsung display with Tizen 10 (2026 models) or newer"* — instead of offering a
button that would do nothing, and the meeting-room code is never shown on such a screen. Every
receiver gives up after 45 seconds without a picture and tells the sharer, so even a screen that
claims the capability wrongly is never left black.

### Several people at once: which screens can tile

A screen shows more than one presenter only if its player declares `remote.screen_share_tiles`
(in no baseline). Every other screen shows **one presenter at a time** — the spotlighted one, else
the first — and the server tells the others *"This screen shows one presenter at a time"*.

| Player | Tiles (up to 4) | Notes |
|---|---|---|
| Web player (browsers, ChromeOS, Pi/PC kiosk browser, desktop shell), legacy build | **Yes** | `/player/screen-share.js` tiles; verified end to end in headless Chrome (two guests + a phone camera). |
| iPad / iPhone app | **Yes** | The web player in WKWebView. Not run on an iPad here. |
| Samsung Tizen 10+ | No (one at a time) | Same receiver file (it could tile), not claimed: several WebRTC `<video>` decoders at once on a TV are unverified. |
| Native Raspberry Pi / Windows / macOS | No (one at a time) | The QtWebEngine page loads the same receiver, but the QML code badge has no compact mode and a Pi decodes VP8/VP9 in software — four at once is not something to promise untested. |
| Native Android player | **Yes**, up to 4 | One `ScreenShareReceiver` per presenter (`ScreenShareSessions`, oldest replaced by a 5th), tiled by `ScreenShareProtocol.rects` exactly as the web player (2 side by side or stacked in portrait, 3 with the third centred below, 2x2); `device:screenshare-layout` spotlights one (the others stay connected, hidden) and enables only the chosen presenter's audio track; the playlist resumes when the last presenter leaves. Each receiver keeps its own PeerConnectionFactory and hardware decoder: four shares need four decoders, which a low-end TV SoC may not have. JVM tests for the layout rules (`ScreenShareProtocolTest`, `ScreenShareSessionsTest`); not yet run with four presenters on a device. |
| webOS, BrightSign, Vega, Roku, tvOS, e-ink | — | No screen share at all (above). |

The **display** must tile for its switch to mean anything: a display that cannot shows one presenter
however the switch is set (its card says so). Its mirrors that cannot tile follow it as above.

## Which browsers can share

Sharing a **screen** needs `getDisplayMedia()`: current **Chrome, Edge, Firefox and Safari on a
computer**. Phones and tablets cannot share their screen from a browser (iOS Safari and Android
Chrome do not offer `getDisplayMedia`). The `/share` page only offers what the device can do:
a phone gets **Share my camera** (`getUserMedia`, Android and iPhone browsers) and, on Android,
**Share my screen with the ScreenTinker app**.

> ⚠️ **The sharer's page must be served over HTTPS** (or `localhost`). Browsers only allow screen
> capture in a secure context. A self-hosted dashboard reached as `http://192.168.1.10:3001` can
> *show* shares on its screens but cannot *start* one from that address — the dashboard and the
> `/share` page say *"Screen sharing needs a secure (https) address"*. Put the server behind your
> usual TLS reverse proxy (Caddy, nginx, Traefik, Cloudflare Tunnel). The **screen** (the receiver)
> works over plain HTTP.

Sound: Chrome and Edge can share a tab's sound (and on Windows/ChromeOS the whole system's); Firefox
and Safari share video only. Without sound the share still works.

---

## Using it

### From the dashboard (editors and admins)

**Advanced → Screens → a screen.** The *Now Playing* tab has a **Screen sharing** card, and the
header has **🖥️ Share my screen** when this screen can take one. Press it, choose a screen, window or
tab in the browser's picker, and a bar appears at the bottom of the dashboard: *Sharing to
&lt;screen&gt; — Stop sharing*. The bar follows you around the dashboard; closing the tab stops the
share.

The card also shows who is sharing right now (*"Gail (guest) is sharing (since 14:05)"*) with
**Stop this share** — any editor can stop any share on a screen they can edit.

**Simple view.** Screens that can take a share get a **Share my screen** button under their card,
and the home page gets a **Share my screen** task: *Which screen? → Choose what to share → you're
live → Stop sharing*.

View-only members see the card (and who is sharing) but get no Share or Stop buttons, and the server
refuses them (403).

### Several screens at once (multi share)

One capture, shown on several screens at the same time — a town hall on every screen of a floor,
the same slides in two meeting rooms:

- **A screen's page:** under **Share my screen**, open **Also show on…** and tick the other screens
  (only screens that can show a share are listed; offline ones are greyed out).
- **A device group** (Advanced → Screens, the group's header): **Share my screen to this group**.
- **Simple view:** the *Share my screen* task lets you tap several screens before **Next**.

The bar says *"Sharing to 4 screens"* and *"Showing on 3 of 4 screens"* while they connect. Each
screen shows the share with its own *"Shared by …"* badge, and each screen's remote viewer shows it.

- Screens that **cannot** take the share right now (a player without a receiver, offline, already
  showing someone else's share) are **skipped and named** after you pick what to share — *"Not shared
  to Lobby TV, Kiosk 3: they can't show a screen share right now."* The rest start.
- **Stop** on the bar ends it on every screen. A screen that disconnects drops out on its own and the
  others keep going (you get a note). On a screen's card, another editor can **Stop on this screen**
  or **Stop on all N screens**.
- **Limit:** one share reaches at most `SCREEN_SHARE_MAX_TARGETS` screens (default **6**). Each screen
  is a separate peer-to-peer upload *from the sharer's computer* (roughly 1–3 Mbit/s each for a
  screen of slides, more for video), so the limit protects the sharer's uplink, not the server. Asking
  for more is refused with that reason; nothing starts.
- **Mirror displays** (the same display link open in another place, [web-player.md](web-player.md)):
  every way of sharing to a display also reaches its mirrors: **Share my screen** on the display's
  page, its screen card or the Simple view, a multi share naming it, and a guest's meeting-room code.
  The one-screen start (`POST /api/screen-share/devices/:id`) and the guest join (`POST
  /api/share/join`) answer with the display's own leg in their usual fields plus, added, `share_id`
  and `legs` (display first, then each mirror; the sharer's page sends the one capture to each) and,
  for the signed-in start only, `skipped`. A mirror that is offline, busy, cannot show a share or is
  past the target limit is left out, never a reason to refuse; the display itself unavailable refuses
  as before. **Stop** on the display (sharer or owner) ends it on its mirrors; a mirror that drops
  off or is removed loses only its own leg. The card counts the display once ("+ mirrors" apart).
  Mirrors are never a choice: the card says "Also shows on its mirrors (n): …", and **Also show
  on…** offers displays only (picking one brings its mirrors).
- **A mirror that appears during a share joins it.** When a mirror of a display being shared to
  connects (opened for the first time, or back after a drop), the server mints a leg for it in the
  same share and hands it to the sharer's page over a signalling socket that page already has open
  (`{type:'add_leg', share_id, leg}`; a guest's leg carries no device id). The page sends the same
  capture to it, and the bar updates ("Showing on 3 of 3 screens"). Only the server chooses: a
  mirror of a display the share was started for, in its workspace, that can take a share; nothing
  the sharer sends can add a screen. The target limit holds: a full share skips the mirror and the
  sharer is told (`{type:'leg_skipped', screen_name, reason}`). A sharer page from before this
  ignores the message; the unused leg expires after a minute.
  `withMirrors()` / `expandShareTargets()` in `lib/screen-share.js` decide.
- **The meeting-room code on mirrors:** the code belongs to the display; its mirrors show the same
  code (a mirror that connects while it is live gets it at once) and a guest who types it at a
  mirror presents to the display and all its mirrors. Redeeming it spends it everywhere; no screen of
  the family shows a code while the display is busy (nor a mirror busy with its own share); when the
  share ends they all get the same new code. A share to one mirror alone replaces the display's code
  when it starts and again when it ends. The switch is on the display (a mirror's page has none).

#### Sharing to many screens (beyond the limit)

For a whole building, one upload has to go to a **restreamer** that fans out to every screen — the
[go2rtc](live-video.md) sidecar live video already uses. That path is **not implemented** in this
release: it would put the media through a server (so *"the server never sees the video"*, below, no
longer holds), needs an H.264 capture (go2rtc's WebRTC engine is H.264-only), and every
receiver would need a pull mode. Until it lands, raise `SCREEN_SHARE_MAX_TARGETS` only for sharers on
a wired uplink, and use several shares (or a playlist with a stream) for anything larger.

### Several people at once

A workspace admin ticks **Let several people share at once (up to 4)** next to **Meeting-room code**
on the screen's card (the display; a mirror follows its display). How many is the platform's
setting (**Admin → System → Screen sharing: people at once**, 1–4, default 4, or
`SCREEN_SHARE_MAX_PRESENTERS`).

- **Slots.** Guests and editors take slots alike: an editor's **Share my screen** joins a meeting in
  progress, and a guest can join an editor's share. A full screen refuses the next one (`busy`).
- **The code** stays on screen while a slot is free — shrunk to a small card in the top-right corner
  so it does not cover the shares — and **every join spends it**: a new code appears at once. Full:
  no code. Someone leaves: a fresh code comes back. Everyone leaves: normal content and a new code.
- **Layout.** 1 → full screen; 2 → side by side (stacked on a portrait screen); 3–4 → a 2×2 grid.
  Each share is letterboxed in its tile with its own label (*"Shared by Ann"*, *"Shared by Guest 2 ·
  guest"* — guests who give no name are numbered). The remote viewer's capture draws the tiles.
- **Sound:** one presenter at a time — the spotlighted one if they share sound, else the most recent
  presenter who joined with sound.
- **Spotlight ("Make full screen")** fills the screen with one presenter; the others stay connected
  but hidden (no thumbnails: they would cover the presenter's content), and **Show everyone** puts
  the tiles back. **Remove** takes one presenter off the screen and its mirrors (their page says *"You
  were removed"*); the code they joined with was spent, so it cannot bring them back.
- **Who controls:** the screen's owners (editors and admins of its workspace — on the card, or from
  the sharer bar when they are presenting) and the **first presenter** (the one in the room longest)
  from their `/share` page. Anyone else, guests included, is refused by the server.
- **Mirrors:** every presenter reaches the display and each mirror that can take them — one leg per
  presenter per screen, within `SCREEN_SHARE_MAX_TARGETS` per presenter (each leg is an upload from
  that presenter's device). Skipped screens are reported as before.
- **Turning it off mid-share** keeps everyone presenting and admits nobody new (no code) until the
  room is empty.

### Phones: camera and the Android app

**Camera (any phone browser).** On `/share`, **Share my camera** sends the back camera (or the front
one) with optional sound; **Switch camera** flips it during the share without reconnecting. It uses
the same code, slots and pipeline as a screen. Point it at a whiteboard, a printout, a product.

**The QR** on the screen opens `/share?code=<the code>` (it changes with the code), so scanning it
fills the code in. Opening `/share` with a code shows the options that device actually has.

**Android: the phone's own screen** goes through the **ScreenTinker Manager** app
([manager-app.md](manager-app.md)), **without an account** and for **any** ScreenTinker server
(hosted or self-hosted, any domain or IP, plain http on a LAN too):

- On Android, `/share` offers **Share my screen with the ScreenTinker app**: an `intent://` link
  carrying the server and the code (`screentinker://share?server=<origin>&code=<code>`); Android opens
  the app, or the Play Store if it is not installed.
- The app also handles `http(s)://<any host>/share` links (not verified App Links — a self-hosted
  domain cannot be — so Android may simply open the browser, whose page then offers the button), and
  its first screen and launcher shortcut have **Share my screen to a meeting-room screen**: scan the
  QR (Google's code scanner, no camera permission) or type the address and code.
- Before anything is captured the app shows **"Share your screen to <host>?"** — the host in ASCII
  (punycode for international names), http/https only, never a `user@host` trick — then Android's own
  capture prompt. The code is spent only after both.
- While sharing, a notification says where the screen is going and has **Stop** (Android 15+'s
  status-bar chip stops it too). The picture only — no sound. Turning the phone keeps the share going.
- Signed in, the Simple view's **Share my screen** in the app uses the same capture for the screens
  picked there.

### The meeting-room code (guests)

A workspace admin switches on **Meeting-room code** in the screen's *Screen sharing* card. The screen
then shows, in its bottom-right corner:

```
[QR]  Share your screen here
      Go to signage.example.com/share and enter
      K7QM-3XHP
```

A guest opens that address (or scans the QR), types the code and an optional name, presses
**Share my screen** (or **Share my camera**), picks what to share — and is live. The code is hidden
while the screen is full (one sharer, unless several are allowed) and a new one appears afterwards.

The QR encodes `<address>/share?code=<code>`. The address is `APP_URL` when set, otherwise the
address the screen itself reaches the server on (the same rule as emailed links,
`lib/public-origin.js`). Set `APP_URL` if the screens and the people in the room reach the server by
different names.

---

## Admin settings

| Where | Setting | Default |
|---|---|---|
| Server env | `SCREEN_SHARE_ENABLED=false` removes the feature from the whole server (routes 404, no buttons, codes gone). | on |
| Server env | `SCREEN_SHARE_MAX_MINUTES` — the longest a single share may run (1–480). | `60` |
| Server env | `SCREEN_SHARE_MAX_TARGETS` — how many screens one share may reach at once (1–50). Each is an upload from the sharer's computer. | `6` |
| Members page (workspace admin) | **Allow screen sharing in this workspace.** Turning it off ends any share in progress and hides every code. | on |
| A screen's page (workspace admin) | **Meeting-room code** on this screen. | **off** |
| A screen's page (workspace admin) | **Let several people share at once** on this display. | **off** |
| Server env / Admin → System (platform admin) | `SCREEN_SHARE_MAX_PRESENTERS` — how many at once where allowed (1–4); the Admin setting overrides it. | `4` |
| Admin → Organizations (platform admin) | The org's **ICE servers** (STUN/TURN) — the same per-org override live video and Talk use. | — |

There is no separate permission: starting a share needs the same edit rights as changing what the
screen plays.

## Networking: why it works out of the box on a LAN, and when you need TURN

The browser and the screen connect **peer to peer** with WebRTC. On the same network they find each
other directly (host candidates) and need nothing else. Across networks — a guest on the visitor
Wi-Fi, a screen behind a different NAT — they need help:

- **STUN** lets each side discover its public address. ScreenTinker hands out the org's ICE servers,
  or, if none are set, the server-wide `GO2RTC_STUN_URLS` (default `stun:stun.l.google.com:19302`).
  Set `GO2RTC_STUN_URLS` to your own STUN server if you do not want the browsers to contact Google's.
- **TURN** relays the media when no direct path exists (strict firewalls, symmetric NAT, a guest
  network isolated from the screens' VLAN). Set the org's ICE servers (Admin → Organizations) or
  `GO2RTC_TURN_URL` / `GO2RTC_TURN_USER` / `GO2RTC_TURN_PASS`. **These are the same settings live video
  and Talk use; go2rtc itself does not need to be running for screen share.**

If a share starts but never appears ("Your computer could not connect to the screen"), the two sides
could not find a path: put them on the same network, or add a TURN server.

> TURN credentials are given to whoever starts a share — including a guest who entered a valid
> code — exactly as they are given to the screens and the dashboard for live video and Talk. So
> prefer **short-lived credentials**: set `GO2RTC_TURN_SECRET` to the same secret as your TURN
> server's `static-auth-secret` (coturn: `use-auth-secret`), and every hand-out gets its own
> username/password that expires after `GO2RTC_TURN_TTL` seconds (default 6 hours). The secret
> never leaves the server, and it takes precedence over `GO2RTC_TURN_USER` / `GO2RTC_TURN_PASS`.
> `GO2RTC_TURN_URL` may list several URLs separated by commas, e.g.
> `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp`.
>
> A minimal coturn for this: `use-auth-secret`, `static-auth-secret=<secret>`, `realm=<your domain>`,
> `listening-port=3478`, a relay port range (`min-port`/`max-port`) open in the firewall, and
> `no-multicast-peers` plus `denied-peer-ip` for private ranges so the relay cannot be used to reach
> your internal network. The TURN host must be reachable directly — not through a proxy such as
> Cloudflare's orange cloud.

## Why peer-to-peer and not the go2rtc sidecar

Live video and Talk route media through an optional [go2rtc](live-video.md) sidecar. Screen share
does not, deliberately:

- **It works on a plain install.** go2rtc is optional and off by default; a feature that needed it
  would not work for most self-hosters. Peer-to-peer needs no extra container, port or config on a LAN.
- **There is exactly one viewer.** A restreamer pays off when many viewers watch one source (a
  dashboard wall watching a screen). A share has one sender and one screen, so a relay in the middle
  only adds latency, a codec constraint (go2rtc's WebRTC engine is H.264-only for video) and a hop.
- **Privacy.** The media never passes through any server we run — not even a sidecar on the same box.
- **NAT is the same problem either way.** go2rtc needs reachable candidates or TURN just the same; the
  org's ICE settings already exist and cover both.

The trade-off: every screen is its own upload from the sharer. A multi share to a handful of screens
is still peer to peer (one RTCPeerConnection per screen, one capture); showing one laptop on a whole
building is where a restreamer pays off — see *Sharing to many screens* above.

---

## Security and privacy

- **Media is never stored or relayed by the server.** It flows browser → screen over DTLS-SRTP.
  The server holds only the signalling (SDP offer/answer and ICE candidates) in memory, for the
  length of the share.
- **Signalling is authenticated on both legs.**
  - The sharer gets a **single-use ticket** from an authenticated start (or a valid code), valid for
    60 seconds, sent as the *first WebSocket message* (`/api/screen-share/ws`) — never in a URL.
  - The screen authenticates its leg (`/api/devices/:id/screen-share/ws`) with its own
    `device_token` in the first message, and the session must have been minted **for that screen**:
    another screen's valid token cannot attach to it.
  - The relay carries only `webrtc/offer`, `webrtc/answer`, `webrtc/candidate` and a few state
    words, each **rebuilt from validated fields** (size-limited SDP, candidate lines only, a capped
    number per leg). Nothing else crosses.
- **Tenancy.** Every route resolves the screen's *own* workspace and checks the caller's access to it
  (`resourceAccess`), so a screen id from another workspace is a 403 whichever workspace you are in.
  The screen-share routes are JWT-only — API tokens cannot start shares.
- **Viewers cannot start or stop.** `workspace_viewer` gets 403 on every write. The meeting-room code
  and the workspace switch need a workspace admin.
- **Audit log** (`activity_log`): `screen_share.start` (who, which screen), `screen_share.guest_join`
  (the name the guest typed, their address, and `source`: screen / camera / app), `screen_share.stop`
  (why: stopped by sharer / owner, removed, time limit, screen offline, connection failed …, who
  stopped it, and how long it ran), `screen_share.presenter_remove` and `screen_share.spotlight` (who
  did it: an owner, or the first presenter by name), `screen_share.guest_toggle`,
  `screen_share.multi_toggle`, `screen_share.workspace_toggle`. The ticket and the code are never
  logged.
- **The Android app's no-account share** acts on a link from anywhere, so it validates the server
  (http/https, a host, no userinfo) and shows it — in ASCII — before Android's capture prompt; it sends
  the code only to that server. Unit tests: `android-admin/app/src/test/.../share/ShareLinkTest.kt`.
- **XSS.** The sharer's name is cleaned (control and bidi-override characters removed, 40 characters)
  and is only ever rendered as text — on the screen with `textContent`, on the dashboard with `esc()`.
- **No WebRTC, no breakage.** If the sharer's browser cannot capture, the page says why (not HTTPS,
  no `getDisplayMedia`, no WebRTC). If the screen cannot connect, the share ends with a clear reason
  and the screen just keeps playing its content; it is never left on a black frame (the screen gives
  up after 45 seconds without a picture).

### Abuse: the meeting-room code

The code is the only credential a guest needs, so it is designed to be usable only by someone who
can **see the screen**:

| Control | How |
|---|---|
| Only on the screen | The code lives in server memory and on the screen. No API returns it — not even to an admin. The QR carries it as `/share?code=…` so phones and the Android app can read it; this server logs no request URLs, the `/share` page strips it from the address bar and sends no `Referer`, and a code is single-use and dead within ten minutes. (Before 3.0's phone support it rode in the fragment; `/share` still accepts that.) |
| Hard to guess | 8 characters from a 32-symbol alphabet without look-alikes (Crockford: no I, L, O, U) — 40 bits. |
| Rotates | Every 10 minutes even if unused, and **after every successful join** (a photographed code is useless afterwards). |
| Rate-limited | `POST /api/share/join` allows 10 tries a minute per address. A wrong, expired or spent code all get the same answer. |
| Off by default | Per screen, switched on by a workspace admin; the workspace switch and `SCREEN_SHARE_ENABLED` override it. |
| Slots | A screen takes one share, or up to 4 where an admin allows several; the code is hidden while it is full and spent by every join. |
| Owner can kick | Any editor can stop a share (**Stop this share** / **Stop all**) or **Remove** one presenter. The first presenter can remove others from `/share`; other guests cannot (server-enforced). A removed guest's code is already spent. |
| Bounded | Every share ends at `SCREEN_SHARE_MAX_MINUTES`. |
| Accountable | Each guest join is audited with the name they gave and their address. |

The guest's name is shown as *"Shared by &lt;name&gt; · guest"*, so a guest cannot pass as a colleague.

---

## Protocol (for player authors)

```
sharer browser                 ScreenTinker server                     screen (player)
──────────────                 ───────────────────                     ───────────────
POST /api/screen-share/devices/:id   (or POST /api/share/join {code})
  ◀── { ticket, ws_path, ice_servers, max_seconds }
WS /api/screen-share/ws
  {type:auth, ticket} ─────────▶  ── socket.io device:screenshare-start ──▶
  ◀── {type:ready}                   {session_id, shared_by, guest, audio,
                                      max_seconds, ice_servers}
                                                       ◀── WS /api/devices/:id/screen-share/ws
                                                           {type:auth, device_token, session_id}
  ◀── {type:screen_joined}                                 ──▶ {type:ready}
  ◀── {type:webrtc/offer, value}  ◀─────────────────────── {type:webrtc/offer}  (recvonly video+audio)
  {type:webrtc/answer, value} ───────────────────────────▶ (sharer's tracks on those transceivers)
  ◀──── {type:webrtc/candidate, value, mid?, mline?} ────▶  (both ways, trickled)
  ◀── {type:screen_playing}  ◀──────────────────────────── {type:state, value:playing}
  {type:stop}  ──▶  both legs get {type:ended, reason}; device:screenshare-stop {session_id, reason}
```

- The **screen offers** (recvonly video + audio) and the sharer answers; the screen drives
  negotiation because it is the side that is always there.
- Messages use go2rtc's own WebSocket shape (`webrtc/offer|answer|candidate`, `value`), so a native
  player can reuse the Talk leg it already has (Android `AudioTalker`), adding the first-message
  `auth`.
- `device:screenshare-code` `{code, url, qr, expires_at}` (or `{code: null}`) tells a screen what to
  show in its corner; `qr` is a PNG data URL of `url?code=<code>`.
- **Several presenters** are several ordinary sessions on one screen, each with its own
  `device:screenshare-start` and screen leg. Only a player that declares `remote.screen_share_tiles`
  is ever sent a second one. `device:screenshare-layout` `{spotlight, audio, count}` names (in that
  screen's session ids) the session that fills the screen (null: tiles) and the ONE session whose
  sound plays. The sharer's socket gets `{type:'room', room, screen_name, slots, you, first,
  can_control, presenters:[{id, name, guest, first, spotlight, audio, you}]}` (opaque ids) and may send
  `{type:'room', action:'spotlight'|'remove', target:<id>|null}`; the server answers
  `{type:'room_refused'}` to anyone but the first presenter or a signed-in editor. A one-at-a-time
  mirror switched to the spotlighted presenter ends the old leg with `spotlight_changed` and hands
  the new presenter `add_leg`.
- A player declares `remote.screen_share` only when it implements the receiver.
- **Multi share** changes nothing on this wire: it is N ordinary sessions with the same `share_id`,
  one per screen, each with its own single-use ticket, sharer socket and screen leg. A screen only
  ever sees its own session, and the relay's ticket ↔ session ↔ device binding keeps the legs apart.
- **Reference receivers:** the web player (`server/lib/screen-share-player.js`, also copied into the
  Tizen .wgt and loaded by the native player's QtWebEngine page) and Android
  (`android/.../remote/ScreenShareReceiver.kt`, wire handling in `ScreenShareProtocol.kt`).
- While a share is on screen, the player's screenshot / live-view capture must show the share (or,
  where the platform cannot read the video back, an honest card naming the sharer), never the paused
  content underneath.

## API

JWT only (`/api/screen-share`, not reachable with an API token):

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/api/screen-share/devices/:id` | any member | `{feature, workspace_enabled, supported, available, reason, can_share, can_admin, guest_enabled, max_seconds, session, max_targets, platform, multi, presenters}`; `session` (the oldest presenter) carries `share_id` and `screens` (how many screens that share is on); `multi` is `{enabled, supported, this_screen_tiles, slots, max_presenters}`; `presenters` is `[{share_id, shared_by, guest, audio, started_at, first, spotlight, live}]`. |
| `POST` | `/api/screen-share/shares` | editor+ on every screen | Multi share. Body `{device_ids?, group_id?, audio}`. → `{share_id, ws_path, max_seconds, legs: [{device_id, screen_name, session_id, ticket, ice_servers}], skipped: [{id, name, reason, platform}]}`. A screen the caller cannot edit (or another tenant's) refuses the whole request (403/404) and creates nothing; screens that cannot take it are `skipped`; `409 {reason:"too_many_targets", max_targets}` above the limit; `409 {reason:"none_available", skipped}` when none can. |
| `DELETE` | `/api/screen-share/shares/:shareId` | editor+ on every screen | Stop it everywhere. → `{stopped: n}`; 404 for an unknown share or another tenant's. |
| `GET` | `/api/screen-share/groups/:groupId` | any member | `{feature, workspace_enabled, can_share, max_targets, screens: [{id, name, ok, reason, platform}]}` — which of a group's screens can take a share. |
| `POST` | `/api/screen-share/devices/:id` | editor+ | Start. Body `{audio}`. → `{session_id, ticket, ws_path, ice_servers, max_seconds, screen_name}`; `409 {reason}` when `disabled`, `workspace_disabled`, `unsupported`, `offline` or `busy`. |
| `DELETE` | `/api/screen-share/devices/:id` | editor+ | Stop whoever is sharing. → `{stopped}` |
| `PUT` | `/api/screen-share/devices/:id/guest` | workspace admin | `{enabled}` — the meeting-room code. |
| `PUT` | `/api/screen-share/devices/:id/multi` | workspace admin | `{enabled}` — several people at once (display only; `409 {reason:"mirror"}` on a mirror). → `{multi_enabled, slots}` |
| `PUT` | `/api/screen-share/devices/:id/spotlight` | editor+ | `{share_id \| null}` — one presenter full screen, or tiles again. `404` for a presenter not on the screen. |
| `DELETE` | `/api/screen-share/devices/:id/presenters/:shareId` | editor+ | Remove one presenter from the display and its mirrors. → `{removed}` |
| `GET`/`PUT` | `/api/admin/screen-share` | platform admin | `{max_presenters}` (1–4). |
| `GET`/`PUT` | `/api/screen-share/workspace/:wsId` | member / workspace admin | `{enabled}` — the workspace switch. |

Public, rate-limited (10/min per address):

| Method | Path | What |
|---|---|---|
| `POST` | `/api/share/join` | `{code, name?, audio?, source?}` → same as a start; `404 {reason:"invalid_code"}` for any bad code. `source` (`screen`/`camera`/`app`) is only recorded in the activity log. |
| `GET` | `/share` | The meeting-room page. |

`GET /api/status` reports `features.screen_share`.

## Limits

- One share per screen (up to 4 where allowed, on players that tile); one share reaches up to
  `SCREEN_SHARE_MAX_TARGETS` screens (see *Several screens at once*).
- The Android app shares the picture only (no sound). Phone browsers share their camera, not their
  screen.
- **State is in memory** in the server process the screen is connected to. A restart ends running
  shares (both sides are told) and issues new codes. On a [scale-out](scale-out.md) replica, screens
  connect to the primary, so share from the primary's address.
- Sharing needs HTTPS on the sharer's side (see above).
- LG webOS, BrightSign, Amazon Vega, tvOS, Roku and e-ink screens cannot show a share, and Samsung
  displays need Tizen 10+ (see the table).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No **Share my screen** button | The screen's player does not declare `remote.screen_share` (see the card's note), the workspace switch is off, you are a viewer, or `SCREEN_SHARE_ENABLED=false`. |
| *"needs a secure (https) address"* | Open the dashboard / `/share` over HTTPS. |
| *"This browser cannot share its screen"* | A phone, or an old browser. Share the camera, use the Android app, or a computer. |
| No code while someone shares, though several are allowed | The screen is full, or its player cannot tile (the card says so), or the switch was turned off mid-share. |
| *"… shows one presenter at a time"* | That screen's player cannot tile; it shows the spotlighted presenter, else the first. |
| The Android app shares but nothing appears | Same as any share: no network path (add TURN). An emulator behind its own NAT cannot reach a browser that hides its address behind mDNS. |
| *"The screen did not answer"* | The screen is offline or not connected to this server process. |
| *"could not connect to the screen"* | No network path between the two. Same network, or add TURN. |
| The code on the screen is not accepted | It changes after each use and every 10 minutes — use the one showing now. After 10 wrong tries wait a minute. |
| No code on the screen | The code is off for this screen, the workspace switch is off, someone is sharing, or the screen's player cannot show a share (see the table). |
| *"One share can reach at most N screens"* | Pick fewer screens, or raise `SCREEN_SHARE_MAX_TARGETS` for sharers on a wired uplink. |
| Some screens of a group were skipped | They cannot take a share now (player without a receiver, offline, busy); the toast names them. |
| A Raspberry Pi share stutters with video | The Pi decodes the share in software (QtWebEngine has no H.264, so it is VP8/VP9). Slides are fine; share a lower resolution or a window for video. |
| No sound | Tick **Include sound** *and* choose "Share tab audio"/"Share system audio" in the browser's picker (Chrome/Edge). |

## Tests

- `server/test/screen-share.test.js` — the relay and codes in process: ticket single-use, the screen
  leg needs its own token and a session for that screen, message validation/stripping, cleanup on
  either side leaving / the screen going offline / owner stop / time limit / workspace switch,
  audit rows, code alphabet, single use, expiry and rotation, capability gating of codes.
- `server/test/screen-share-routes.test.js` — the real server with a real Socket.IO screen: editor
  vs viewer vs another tenant vs anonymous, capability gating, one-at-a-time, kick, the meeting-room
  code switch (admin-only), the code pushed to the screen and never returned by the API, single use,
  rate limit, Socket.IO disconnect cleanup, the workspace switch, the `/share` page under the strict CSP.
- `server/test/screen-share-player.test.js` — the web player declares `remote.screen_share` only in
  a real browser with WebRTC (not in the BrightSign / host shells), and wires start/stop/code.
- `server/test/screen-share-e2e.test.js` — **real end to end**: headless Chrome with fake capture
  (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
  --auto-select-desktop-capture-source=…`) and the real web player page. A guest reads the code off
  the player, presents through `/share`, and the test asserts the player renders a **playing,
  fullscreen `<video>` whose time advances**, with the badge; Stop removes it and a new code appears.
  A second test does the same for an editor's API start and the owner's stop. Then: the remote
  viewer's screenshot is the share; **multi share** — one sharer, two web-player screens (separate
  browser contexts) both playing, stop one (the other keeps playing), stop all (capture ended); and
  the **native player's RTC page**, generated by `native/…/ui/rtc_page.py` and run in Chromium (the
  engine QtWebEngine embeds) the way `app.py` drives it, receiving a share. Skips cleanly without
  Chrome (and the native test without `python3`).
- `server/test/screen-share-multi.test.js` — multi share against the real server: one leg per screen
  with one share id, per-leg isolation (one screen cannot attach to another's leg, tickets single-use,
  signalling never crosses), viewers and any other-tenant id refuse the whole request with nothing
  left behind, skipped screens named, the limit, groups, one screen disconnecting alone, stop one /
  stop all, and the one-screen API unchanged.
- `server/test/screen-share-presenters.test.js` — several people at once against the real server:
  off is today's behaviour; the switch (admin-only, display-only, tiling players only); slots, the
  code staying while a slot is free, spent and replaced by every join (guests and editors), gone when
  full, back on leave, new when empty; numbered guests; sound and spotlight in the layout event;
  control by the owner and the first presenter, refused for another guest, viewers and other
  tenants, removed guests cannot rejoin; the switch off mid-share; the platform limit; mirrors that
  cannot tile showing one presenter and following the spotlight; target limits per presenter; a full
  display not joinable through its mirror in a multi share.
- `server/test/screen-share-presenters-e2e.test.js` — **headless Chrome, real media**: the QR encodes
  `/share?code=` of the code on screen and fills it in; two guests (the second reading the new code off
  the screen) → two playing tiles side by side; full → no code; the first presenter's page spotlights
  and removes the other (whose code is then refused); a mobile-emulated page without screen capture is
  offered the camera and the app link, and its camera share plays next to the first presenter, also
  after switching cameras; everyone leaves → a fresh full code.
- `android-admin/app/src/test/.../share/` (JUnit) — the app's link validation and signalling. Manually
  on the Android 16 emulator: guest link, QR link and signed-in starts playing on a web player,
  rotation, Stop from the notification, a bad link refused, the code scanner opening.
- `server/test/screen-share-players.test.js` — every other player: Tizen (receiver copy byte-identical,
  Tizen 10+ gate, wiring, the remote-viewer card), Android and native declarations and wiring, no
  baseline ever granting the capability, and this table's sources.
- `android/app/src/test/.../remote/ScreenShareProtocolTest.kt` (JUnit) and
  `native/tests/test_screen_share.py` (pytest) — each native receiver's wire handling.
