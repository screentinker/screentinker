# ScreenTinker on BrightSign

The player is the ordinary web player (`server/player/index.html`) running in an `roHtmlWidget`.
It already runs unmodified on real hardware — a Series 5 (HD1026, BOS 9.1, Chromium 120) played
4,723 items over 12.4h averaging 9.4s against a 10s slot. So the port is not "can it run". It is
the four things a page cannot do for itself.

```
  autorun.brs      the host: owns the widget, identity, outputs, recovery
      | @brightsign/messageport  (bidirectional)
  st-bridge.js     the page's half of the same contract
      |
  server/player/index.html        the unmodified player
```

## Files

| file | role |
|---|---|
| `autorun.brs` | BrightScript host. Builds the widget, supervises it, persists identity, drives a second output, executes what the page cannot. |
| `st-bridge.js` | Loaded by the player on this platform. Registry identity, restart-instead-of-reload, heartbeat, sync-backend reporting. Degrades to no-ops everywhere else, so it is safe to load unconditionally. |
| `st-sync.js` | Native SyncManager adapter. Inert without the platform module, so the player falls back to its own group sync. |
| `probe.html` | The original capability probe. Still useful on a new model/OS build. |
| `offline.html` | Local fallback page — names the server, keeps probing it, and asks the host to restart the player the moment it answers. |

## The four things the host exists for

**1. It owns the widget lifecycle.** A page-initiated `location.reload()` does not reliably bring
an `roHtmlWidget` back. On 2026-07-28 a ScreenTinker deploy reloaded every connected player;
the BrightSign was the only one that never returned, and a browser on the same deploy reloaded and
was heartbeating minutes later. So the page never reloads itself here — it posts
`{type:"restart"}` and the host tears the widget down and builds a new one. Without this, every
deploy silently darkens every BrightSign panel until someone power-cycles it.

**2. It recovers.** `load-error` retries with backoff (5s → 15s → 30s → 60s) and after three
failures falls back to a local page, so a dead server shows something truthful instead of white.
On top of that, a watchdog: the page beats every 30s and three missed beats rebuild the widget.
That covers the case `load-error` never reports — a page that loaded fine and then wedged on a
dead socket, a JS exception, or a stalled decoder.

**3. Identity lives in the registry.** `localStorage` is tied to the page's origin and quota; the
registry survives reboots, content updates and origin changes. The hardware serial is the stable
id, so two panels imaged from the same card never collide — which is exactly how the web player's
hardware-only fingerprint once merged two identical panels into a single device row.

**4. It reaches BrightScript-only capabilities** — video mode, a second output, and native
BrightWall sync — on the page's behalf, over `@brightsign/messageport`.

## Where the files go — card OR internal flash

```
autorun.brs          the host
offline.html         local fallback, used after three failed loads
screentinker.json    optional — server URL, sync backend, output mode
```

**A player will boot `autorun.brs` from internal flash, not just from a card.** Confirmed on real
hardware (XT245, BOS 9.0.189) whose microSD interface is physically dead:

```
Loading 'FLASH:/autorun.brs'
BSPLAY: https://screentinker.com/player?platform=brightsign&serial=…&model=XT245
```

That matters far beyond one broken unit — it means a player with no card, or a failed card slot,
is still fully deployable. Push the files over SFTP to `/storage/flash` (user `brightsign`, blank
password, once SSH is enabled) and reboot.

`StorageRoot()` in `autorun.brs` therefore refuses to assume: it probes for `FLASH:/autorun.brs`
and falls back to `SD:`. Hard-coding `SD:` is exactly the bug that made the first flash boot fail —
the script loaded and then could not find its own `index.html`.

**`st-bridge.js` and `st-sync.js` do NOT go on the card.** The player pulls them from the server
(`/player/st-bridge.js`, `/player/st-sync.js`) so they can never skew from the player that uses
them. A stale copy on a card is precisely the version skew that would leave a panel unable to
restart itself.

## autorun.zip — one file instead of four

`scripts/build-autorun-zip.sh` packages the host, the fallback page and the config into a single
`autorun.zip`, attached to every GitHub release:

```bash
scripts/build-autorun-zip.sh --server https://your-server
```

Drop it on the root of a player's storage and power-cycle. `autozip.brs` unpacks it in place,
renames it `autorun.zip.done` so it never re-extracts, and reboots into the player.

Two rules the format imposes, both of which fail silently if broken:

- **The archive must expand to files at its ROOT**, with no wrapper directory — a player extracts
  to the storage root, so a nested folder puts `autorun.brs` somewhere the player never looks and
  the card appears to do nothing. The build script zips from *inside* the staging directory and
  then asserts the layout rather than trusting it.
- **`autorun.brs` must NOT sit next to `autorun.zip`** on the storage root; its presence stops the
  zip being processed at all. It belongs inside the archive.

The rename is what makes it idempotent. Without it the player extracts, reboots, extracts, reboots
— a loop that looks exactly like a hardware fault. An extraction *failure* deliberately does not
rename, so a truncated copy is retried after someone replaces it rather than skipped forever.

Requires BrightSignOS 7.0.60+ (`roUnzip`).

## Provisioning

Config resolves `screentinker.json` on the card **>** registry **>** built-in default. The JSON
file is how a batch gets imaged without touching each box:

```json
{ "server_url": "https://screentinker.com", "sync_backend": "auto", "output_mode": "single" }
```

## Dual output

`output_mode` is `single` | `dual` | `clone`.

- **dual** — a second widget loads the same player with `&screen=2`, so the server can hand it its
  own playlist. Two independent displays from one player.
- **clone** — the second widget loads `&screen=1`: the same content on both outputs.

Confirmed multi-output: **XC2055** (dual HDMI) and **XC4055** (quad).

⚠️ **Do not trust the series-level spec blurb.** It credits the whole XT5 family — XT245, XT1145,
XT2145 — with "dual HDMI outputs", but an **XT245 in hand is single-output**; that phrase appears
to cover HDMI *in* plus *out*. Verify the individual model before enabling `dual`.

Every other model is single-output, so the second widget is only ever created when the config asks
for it — an unsupported model keeps working as a normal single-screen player rather than failing to
start.

## Synchronisation — ours or theirs

Both, chosen per group. `server/lib/sync-backend.js` decides and `resolveSyncBackend()` is pure,
so the decision is tested without a fleet (`server/test/sync-backend.test.js`).

| backend | reach | accuracy |
|---|---|---|
| `screentinker` | Android, web, Tizen, BrightSign — any mix | to the second; clock-derived, no leader, survives a server outage |
| `brightsign` | BrightSign only | frame-accurate (BrightWall) |

`auto` picks native sync when **every** member is a BrightSign and ours otherwise. Explicit
settings are honoured, with one refusal: native sync selected for a group containing a
non-BrightSign display **downgrades and reports why**. A group that half-syncs is worse than one
that syncs to the second everywhere — and the failure would be invisible from the dashboard,
because the BrightSigns would look perfectly synchronised while the odd panel drifted alone.

A player paired before this port is still recognised, by its BrightSign user agent.

### How the choice reaches a screen

`device_groups.sync_backend` (`auto` | `screentinker` | `brightsign`) is the operator's **request**.
The server resolves it per push through `resolveSyncBackend()` and sends the answer — plus the
reason and a `downgraded` flag — in the `group_sync` payload, so the players, the dashboard and the
stored setting can never disagree about which protocol is running.

Three things force a fallback to our protocol, and each is reported rather than applied silently:

| condition | why native sync cannot run |
|---|---|
| any non-BrightSign member | BrightWall cannot include a foreign screen |
| members on different subnets | it is multicast; it does not cross networks |
| the elected leader is offline | it is leader/follower — nobody would broadcast |

That last one has no equivalent in our protocol, which is leaderless and carries on regardless.
Leadership uses the existing election (`resolveGroupLeader`): the pinned leader if it is an online
member on the shared playlist, else the first online member, else the first member by id.

**Item selection stays clock-derived under both backends.** Native sync only replaces the
seek/nudge drift correction, because `setSyncParams` has the video element hold its own alignment —
and correcting it ourselves would fight the platform. That also keeps images and widgets, which have
no `setSyncParams`, advancing with the videos instead of drifting off on their own.

## Command parity

The web player handles four of the ~20 fleet commands — `launch`, `refresh`, `screen_on`,
`screen_off` — because a browser tab genuinely cannot do more. A BrightSign can, through the host
and the platform APIs:

| command | web player | BrightSign |
|---|---|---|
| `screen_on` / `screen_off` | black overlay; panel stays lit | **CEC** Image View On / Standby — the display actually sleeps |
| `reboot` | ignored | **real reboot** via `RebootSystem` in the host |
| `set_volume` | — | applied to current and future media |
| `refresh` | `location.reload()` | widget rebuilt by the host (reload is unreliable here) |

### ⚠️ Nothing in the DOM can cover video

With `hwz_default: "on"` the widget decodes video onto a **hardware plane**, and the graphics plane
— everything in the DOM — sits behind it. Blanking the screen took three attempts on real hardware,
and each failure taught the same lesson from a different angle:

1. **Black overlay** → the video played straight *through* it. A `z-index: 9999` div cannot cover a
   hardware plane.
2. **Pause + hide the element** → playback stopped, but the **last decoded frame stayed on screen**.
   Hiding a DOM element does nothing to the plane; the plane is not part of the DOM.
3. **Pause + `removeAttribute('src')` + `load()`** → releases the plane. Black at last.

Coming back out re-mounts through `nextItem()`, because a torn-down element cannot be resurrected.
The playlist keeps advancing while the screen is off, so each newly started item is torn down too,
caught on the `play` event in the capture phase — otherwise the next video lights the panel back up.

Any feature that assumes an overlay can hide video needs rethinking here: screen blanking, masking,
fades over video.

`displayPower()` (CEC) is best effort and deliberately **not** load-bearing — it returns false when
CEC is unavailable and the media teardown does the real work. Our XT245 reports
`failed to get cec clock` in the kernel log and does not respond to CEC at all, which is exactly why
blanking must not depend on it. Plenty of displays ignore broadcast CEC or need direct addressing. Volume is re-applied on every `play` event in the capture phase, because
media elements are created per item across several code paths and setting it once would otherwise
last only until the playlist advanced.

Still Android-only, and correctly inert here: the Tier-2 device-owner commands (`kiosk_lock`,
`install_apk`, `shell`, `block_uninstall`, …) and `set_brightness` / `set_screen_timeout`, which
have no BrightSign equivalent — a signage player has no per-window brightness or screen timeout.

## Declared capabilities

The table above says what a BrightSign *can* do. What the dashboard actually offers comes from
`BS.capabilities()`, computed fresh on every call and sent with the device registration, where
`server/lib/player-capabilities.js` turns it into rendered controls.

It is computed rather than tabulated because **the same model differs from unit to unit**. Our
XT245 supports remote screenshots with an SSD fitted and not without — the DWS snapshot endpoint
writes the full-size capture to disk before returning a thumbnail, so a unit booting from internal
flash is answered `No primary storage found`. No static per-platform table can know that, and a
table that guessed would put a button in the dashboard that cannot work.

### How each one is decided

| capability | condition | why |
|---|---|---|
| `playback.video` `.image` `.widget` `.youtube` `.zones` | always | properties of the renderer, not the hardware |
| `audio.mute` `audio.volume` | always | media-element level, re-applied per `play` |
| `sync.clock` | always | pure JS, needs no host |
| `remote.input` | always | synthesised DOM events; needs no `mouse_enabled` |
| `playback.transitions` `playback.pip` | always, **with a caveat** | see below |
| `offline.cache` | `navigator.serviceWorker` exists | no SW, no offline story |
| `system.restart_player` `system.reboot` `display.rotation` `display.resolution` | host bridge is live | each is a BrightScript call |
| `remote.screenshot` `remote.stream` `system.self_update` | host reports a mounted volume | DWS needs primary storage; the updater needs somewhere to stage `autorun.zip` |
| `display.power` | `@brightsign/cec` resolves | weak signal — see below |
| `sync.native` | `@brightsign/syncmanager` **and** OS ≥ 8.2.10 | below the floor the module can exist and silently do nothing |

The storage answer comes from a `probe` message the bridge posts to the host during boot, before
the player registers. `StorageProbe()` in `autorun.brs` walks `SSD:`, `SD:` and `USB1:` through
`roStorageHotplug.GetStorageStatus().mounted` and reads real capacity via `roStorageInfo`. There is
no JS equivalent for either, which is also why device telemetry now reports the **disk** rather than
the widget's cache quota — the previous numbers were the `storage_quota` from `autorun.brs`
presented as if they were the drive.

`FLASH:` is deliberately excluded from that walk. Internal flash is where the player boots from, not
a volume the DWS will accept a snapshot on; counting it would re-introduce exactly the button that
does nothing.

**Unknown is treated as NO.** If the probe never answers — a widget built without `nodejs_enabled`
has no host at all — nothing storage-gated is declared. A control that appears later, once a disk is
fitted and the player reconnects, is a much smaller problem than one that silently fails today.

### Never declared

| | |
|---|---|
| `system.kiosk` | no lock-task or device-owner concept. The player is the only application on the box, so kiosk is not a mode to enter — it is the permanent state |
| `system.brightness` | no per-window or system brightness control |
| `system.screen_timeout` | no OS screen timeout; blanking is scheduled content, not a setting |
| `system.install_apk` | not Android |
| `system.shell` | no remote shell exposed to the player |
| `system.time` | BrightScript **can** set time and timezone — this host does not implement it. Declaring an unimplemented capability is the same lie in the other direction |

Only the last one is a gap rather than a platform limit. The other five have no BrightSign
equivalent and should stay undeclared permanently.

### The two caveated declarations

**`playback.transitions` / `playback.pip`** both composite DOM content over video, and with `hwz`
the video is on a hardware plane the DOM sits *behind* (see above). They work over images and
widgets and may be invisible over video. Declared anyway: the failure is benign — a transition
degrades to a hard cut, which the engine already does on any failure — and withholding them would
remove a feature that genuinely works for the non-video majority of content.

The likely fix is `roVideoMode.SetGraphicsZOrder("front")`, **deliberately not applied**. Changing
the z-order blind risks hiding video entirely on a player that currently works, and the trade is not
obvious: putting graphics in front may mean video is only visible through a colour key. This wants a
hardware experiment on a unit that is not in service — set the z-order in `autorun.brs` before
`FullScreenRect()`, play a video, and check that (a) video is still visible and (b) a DOM overlay
now covers it. Until someone runs it, the honest state is "transitions work except over video".

**`display.power`** is declared on module presence, which we know is a weak signal: our XT245
resolves `@brightsign/cec` perfectly while the kernel logs `failed to get cec clock` and the display
never responds. There is no way to distinguish "sent" from "received" without a cooperating display.
Blanking does not depend on it — the player tears the media down, which is what actually works — so
a display that ignores CEC still goes dark. The capability being optimistic here costs an
already-working feature nothing.

### Needs hardware to verify

Everything below was implemented against the documented APIs and the dev-cookbook, and reasoned
through, but has not run on a unit in the state that exercises it:

- **The storage probe returning `present: true`.** Our XT245 has a dead microSD interface and boots
  from flash, so it has only ever been observed answering `false`. The false path is verified on
  hardware; the true path is verified only in tests.
- **`remote.screenshot` / `remote.stream` end to end** with a disk fitted — the DWS snapshot call
  has never succeeded on our unit for that reason.
- **`system.self_update`** staging `autorun.zip` onto a real volume.
- **`sync.native`** on two or more units on one L2 network. Requires `networking/ptp_domain="0"`
  and a reboot.
- **The `SetGraphicsZOrder` experiment** above.

## Interactive web pages (#473) — top-level, not framed

A webpage widget marked interactive is a walk-up kiosk page: the first touch holds the playlist,
an idle countdown resets it, and the visitor's cookies and storage are wiped before the next one.
The web player can only do a best-effort version of that in a browser — the site sits in an
`<iframe>` of the player's own page, which can neither wipe a cross-origin site's storage nor see
its navigation — so it declares `playback.web_interactive_framed` there.

On this platform the host can do it properly — **but only when opted in, and it is OFF by
default** until the wipe has been proven on a bench unit (the test plan below is what turns it on):

```json
{ "kiosk_toplevel": true }
```

in `screentinker.json` (only a JSON `true` counts), or registry `screentinker/kiosk_toplevel = "1"`.
Without it the host does not announce `kiosk_toplevel`, and the player uses the framed mode and
declares `playback.web_interactive_framed`.

Opted in, the page posts `kiosk-open`, and `autorun.brs` opens a **second `roHtmlWidget` pointed at
the site top-level**, over the player's widget:

| what | how | source |
|---|---|---|
| fresh storage per session | `storage_path` = `<root>/st-kiosk/s<n>`, `DeleteDirectory`'d on close; the whole `st-kiosk` tree is deleted at boot (a power cut mid-session is wiped too) | `storage_path` "creates a Local Storage subfolder"; `DeleteDirectory` "will recursively delete" |
| touches, media, navigation, consent cookies | a script built by the player, injected with `javascript_injection.document_creation` (base64 `data:` URL) into every document, posting over `BSMessagePort` | roHtmlWidget `javascript_injection`; BSMessagePort |
| the allowlist | the injected script leaves a document outside it (back, or the start page), and stops off-site links, form posts and `window.open` before the request; `new-window-request` loads in place only if allowed | — |
| zoom | `SetZoomLevel(zoom/100)` (Chromium page zoom reflows, like the passive render) | ifHtmlWidget `SetZoomLevel` |
| Home button, "Still there?" | drawn by the injected script inside the site (the player's widget is underneath); driven by a DOM `CustomEvent` sent with `InjectJavaScript`, which crosses JS worlds | ifHtmlWidget `InjectJavaScript` |
| consent cookies | the injected script reports the consent cookies it can read (`document.cookie`, by NAME via the shared patterns), the player keeps them, and the next session's script writes them back before the site's banner runs | — |

The kiosk widget has **its own message port** and **no `nodejs_enabled`**. Only `kiosk-*` messages
are relayed to the player, copied field by field as strings; nothing a website posts can reach the
restart, reboot or identity handlers. `brightsign_js_objects_enabled` is on only for
`BSMessagePort`: the injected script takes the one instance the widget allows, then deletes every
`BS*` global before the site's own scripts run.

⚠️ **The risk the opt-in accepts.** That deletion only protects anything if the injected script runs
in the SAME JavaScript world as the site's scripts. The docs give `javascript_injection` a `world`
of `application` (the default), `user` or `main` and do not say in which world the BS* objects are
exposed. If they are visible to the site and our script cannot remove them, a third-party page
(and every ad or analytics script it loads) can reach `BSDeviceInfo`, `BSControlPort`,
`BSSerialPort` and the rest. No other page→host channel was found that avoids exposing them (an
`roHttpServer` on localhost would open a LAN-reachable listener instead). **Step 6 of the plan is
therefore a must-pass before anyone enables this.**

The player keeps an open kiosk page alive (`kiosk-keepalive` every 5 s); the host closes the page
by itself after 20 s of silence, so a wedged or reloaded player, or page→host messages that stop
arriving, can never leave a site over the screen. `kiosk-close` names its session and is retried
until the host answers `kiosk-closed`; a close for a page that is already gone is answered without
touching a newer one. The page is also closed whenever the player shows something over or instead
of it — a trigger, a PiP, the status card, screen off, re-pairing or an unpair — because the
player's own DOM is underneath the kiosk widget and could not be seen.

The idle clock, the session record, the playlist hold, the incidents and the usage counts all stay
in the player (`server/player/kiosk-player.js`, the same engine as the framed mode). The host only
opens, relays and closes.

**Falls back to the framed mode** — and re-registers with the downgraded capability — when the host
did not announce `kiosk_toplevel` in its probe answer (an older `autorun.brs`, a dual-output player),
when `kiosk-open` gets no `kiosk-opened` within 4 s (page→host messaging has been seen to stop
after load on an XT245), or when the injected script never reports in within 15 s (a firmware that
ignores `javascript_injection`).

### Not verified on hardware — test plan

Written against docs.brightsign.biz and checked with a BrightScript parser and an interpreter run
of the relay logic, **not on a player**. On a bench unit (never one in service):

1. Deploy `autorun.brs` with `screentinker.self_update = "0"` first, or the package update
   replaces it within minutes, and opt in with `"kiosk_toplevel": true`. Assign a playlist with an interactive webpage widget (idle 15 s,
   warning 5 s, a page with a link to a second page of the same site and one to another site).
2. The player log should show `[Kiosk] kiosk page opened top-level by the host`, NOT `falling
   back to the framed mode`. If it falls back: page→host messaging is the suspect (the probe is the
   only round trip known to work after boot); `[st-kiosk] opened` on the serial console tells which half failed.
3. **Z-order:** the site must be visible ABOVE the player. If the dark backdrop shows instead, the
   second widget is composited below the first.
4. Tap: `session started — playlist held`; the item must outlive its duration.
5. Tap the off-site link: `navigation blocked: …`, and the page stays. Follow the same-site link:
   the Home button appears bottom-left; tapping it returns to the start page.
6. **MUST PASS.** In the inspector (`inspector: true`), in the SITE's console (its own world, not
   an extension/isolated context): `typeof BSMessagePort`, `typeof BSDeviceInfo`,
   `typeof BSControlPort` must all be `"undefined"`. If any is a function the site can reach the
   player's hardware objects: do not enable this mode.
7. Leave it: the countdown appears IN the site, then `session idle — wiping and moving on` and
   `web storage wiped`; `SSD:/st-kiosk/` must be empty afterwards.
8. Set a cookie on the site (`document.cookie="a=1"` in the inspector), let it reset, reload: the
   cookie must be gone in the next session. With `keep_consent`, a `CookieConsent` cookie must survive
   and `a` must not.
9. Zoom 150: `innerWidth` in the site must be the screen width / 1.5.
10. Power-cycle mid-session: the next boot must delete `st-kiosk/`, and the dashboard's interactive
    sessions report must show the cut-off session as `interrupted`.
11. Fire a trigger and show a PiP during a session: the kiosk page must close and the overlay be
    visible. Send the player a `refresh`: the page must close (rebuild), or within 20 s at worst.

When all of these pass on a bench unit, turning the default on is a one-line change in
`LoadConfig()` — and the README line above should say which unit and firmware proved it.

## Offline playback

Content bytes are cached by the service worker (`server/player/sw.js`) into a dedicated
`rd-content-v1` cache, so a player that loses its server keeps playing its playlist.

This used to be left to the browser's HTTP cache — the server sends
`Cache-Control: public, max-age=2592000, immutable`. That is fine on a desktop and is **not a
documented-persistent store here**: BrightSign guarantees survival across reloads, app restarts and
reboots for **IndexedDB, localStorage and SQLite**, and their own answer for offline video is to
cache the bytes explicitly. A panel could come back from a power cut with its playlist intact (that
lives in `localStorage`) and no media to play.

The reason content was skipped originally is real, and `server/lib/player-cache-policy.js` is what
makes intercepting it safe. Video elements issue **range requests** when they seek, and naive
caching breaks playback in two ways that are worse than not caching at all:

- storing a `206` as if it were the whole file — every later full request gets a fragment, and it
  stays broken until eviction
- answering a range request with a `200` — some media stacks treat the mismatch as fatal and the
  video never starts

So only complete `200`s are ever stored, and a range request is served by slicing the stored body
into a correct `206`. The content cache is deliberately **not** dropped when the shell is
re-versioned, or every deploy would re-download the whole playlist over a link that may be exactly
what is broken.

## Self-update

The player can replace its own host package. This is the most dangerous thing it does: a truncated
or half-applied `autorun.brs` is a dark panel and a site visit, because there is no app underneath.

The safety is the **ordering**, and every step earns its place:

1. Download to `autorun.zip.part` — never straight to `autorun.zip`. A file still downloading must
   never be a candidate for extraction.
2. Verify **sha256 and size** before promoting. A captive portal answering with a login page
   produces a perfectly well-formed small file; the size floor catches that, the hash catches the
   rest. sha256 specifically, because that is what BrightScript's `roMessageDigest` can compute —
   a checksum the player cannot verify is an unverifiable package.
3. Promote: delete the `.done` marker **first**, then rename `.part` → `autorun.zip`, then reboot.
   Marker first is not stylistic — leaving it makes the next boot skip the new archive and the
   update silently never happens.
4. A failed extract renames the archive to `.bad` rather than retrying. A zip that cannot be
   unpacked will not unpack on the tenth attempt, and retrying every boot is a loop that looks
   exactly like a hardware fault.

**The decision is the server's**, in `server/lib/brightsign-update.js` — unit-tested, and the same
place the prerelease rule lives. The host only executes what it is told; re-implementing the version
comparison in BrightScript would put the prerelease trap somewhere it cannot be tested.

**The version is baked into `autorun.brs`**, stamped at build time by both
`scripts/build-autorun-zip.sh` and `server/lib/brightsign-package.js`, anchored on the
`ST_PACKAGE_VERSION` marker. A version record that can disagree with the code actually running is
the OTA-loop condition by the back door: apply, still report the old version, get offered the same
package forever.

**The manifest and the download come from one buffer**, hashed once. Advertising a version whose
checksum does not match the bytes served is the same loop from the front door.

Config: `self_update` (default **on** — a fleet that cannot be updated remotely needs a van) and
`allow_prerelease` (default off, mirroring the Android beta channel; an opted-in player also
*holds* a prerelease of its own core rather than being pulled back to the release).

## Rotation

Rotate the OUTPUT, never the DOM. The web player rotates with a CSS transform — correct in a
browser, wrong here: with `hwz` enabled the video decodes onto a hardware plane the DOM cannot
transform, so a CSS rotation turns the images and widgets and leaves the video sideways on a
portrait panel.

`roVideoMode` takes a transform (`normal` / `90` / `180` / `270`) and rotating the screen rotates
**every layer**, video included, because it happens below the compositor. The player asks the host
first; when the host succeeds it clears its own CSS transform, or the graphics would rotate twice.
If the host cannot, the CSS path stands — rotating most of the content beats rotating none.

Tizen reached the same conclusion independently and routes portrait video through AVPlay, with the
comment that a CSS-rotated `<video>` "blacks out". Any platform that composites video below the DOM
needs its rotation done at the output, and this is the second one we have found.

## What is NOT done yet

Stated plainly so nobody reads this as finished:

- **Nothing consumes the `bs_model` / `bs_serial` / `bs_screen` fields** the player reports.
  Temperature telemetry likewise has no schema to land in yet. Storage does now report the real
  drive (via the capability probe) rather than the widget's cache quota.
- **Native sync is wired but UNPROVEN on hardware.** The player drives it end to end — the leader
  announces on each advance, every member (leader included) binds via `attachVideo()` on a new id,
  and the resolved backend is chosen per group and pushed down. It cannot be verified with one
  player: a single unit is trivially "in sync with itself". **Two BrightSigns on one subnet are
  needed** to confirm frame alignment, that the leader does not run ahead, and that the 1Hz repeat
  causes no visible reload.

  ```js
  const SyncManager = require('@brightsign/syncmanager');          // BrightSignOS 8.2.10+
  const sync = new SyncManager('', 'ScreenTinkerSync', '224.0.126.10', 1539);
  sync.leader = true;                                              // followers just omit this
  sync.addEventListener('syncevent', (e) => {                      // BOTH roles listen
    if (e.id === lastId) return;                                   // 1Hz rebroadcast — dedupe!
    lastId = e.id;
    video.setSyncParams(e.domain, e.id, e.iso_timestamp);          // extension on <video>
    video.load(); video.play();
  });
  sync.synchronize('item_' + Date.now(), 1000);                    // leader only; msDelay to prep
  ```

  Three properties that shaped the design: it is **leader/follower** where ours is leaderless (and
  the leader starts from its OWN broadcast, or it runs ahead of the group); it synchronises
  **video only**, so images and widgets get item-boundary alignment at best; and it is
  **multicast**, so the whole group must share one L2 network — the resolver now treats differing
  subnets as evidence against it.

  Also: MP4/MOV are fine, MPEG-TS needs its presentation timestamp starting at 0, MPEG-PS is
  unsupported. `synchronize()` rebroadcasts at 1Hz so late-powered players still join, which is
  why the dedupe above is mandatory rather than an optimisation — without it every player reloads
  its video once a second, forever.
- **Addressing a specific HDMI connector from JS is unverified.** `@brightsign/videooutput`
  documents `setMode({width,height,refreshRate})` with no output index. Dual output above assumes
  a second widget maps to the second connector; that needs hardware confirmation.
- **Registry from a remote origin is still unproven** — the original probe question. If injection
  turns out to be origin-dependent, identity moves to a local shim page that owns the registry and
  passes it to the hosted player in an iframe via `postMessage`.
- **Written against the docs first, then corrected by hardware.** The port was checked
  line-by-line against the `brightsign/dev-cookbook` examples, which corrected four config keys,
  the registry API and a hard SyncManager requirement (see below). It has since run on a real
  XT245 booting `FLASH:/autorun.brs` — playback, identity, blanking, rotation and the storage
  probe's *negative* answer are all confirmed there. What that one unit cannot exercise is listed
  under "Needs hardware to verify" above: it has no working storage and there is only one of it.

## Verified against the dev-cookbook

`autorun.brs` and `st-bridge.js` were reviewed against the real examples rather than the prose:

- **`brightsign_js_objects_enabled: true` is required** alongside `nodejs_enabled` for
  `require("@brightsign/*")` (`syncmanager-js/autorun.brs`). Without it the bridge degrades to
  no-ops and the player silently loses identity *and* restart delegation — the failure would look
  like "BrightSign just doesn't work" rather than a missing flag.
- **`storage_path` is a directory name** (`"/cache"`), not a volume, and **`storage_quota` is a
  string** (`indexeddb-caching/autorun.brs`).
- **`security_params: { websecurity: true }`** and `hwz_default: "on"` are the shapes the examples
  use; local URLs carry the volume (`file:/SD:/index.html`).
- **The registry API is asynchronous and section-oriented**: `read(section, key)` returns a
  **Promise** and writes take an object — `write(section, {k: v})`. The bridge prefetches into a
  cache and exposes `onReady()`; the player waits for it before its first connect, because
  registering early would pair the panel as a new display and strand its real row.
- **SyncManager needs `networking/ptp_domain = "0"`, applied by a reboot**
  (`syncmanager-js/autorun.brs`). Done only when this player is configured for native sync, and
  read-before-write so it reboots at most once rather than every boot.
- Confirmed correct as written: `@brightsign/messageport` (`new`, `addEventListener('bsmessage')`,
  `PostBSMessage`), the `roHtmlWidgetEvent` loop, and `RebootSystem()`.
- The notes state a widget URL may be **"an externally hosted page"** with the same access to the
  BrightSign JS APIs, which is the answer the original probe was built to get — still worth
  confirming on hardware, but the documented answer is the favourable one.

## Model notes

Target **Series 5** (Chromium 120) or newer. **Series 4 is pinned to Chromium 87**, and Series 4
and older have fixed graphics/JS memory splits (XTx43/44: 512MB/512MB; HDx23: 256MB/128MB) where
Series 5 allocates dynamically. Image size defaults to 2048x1280x32bpp (3840x2160 on XT/4K models)
and is raised with `roVideoMode.SetImageSizeThreshold()`.
