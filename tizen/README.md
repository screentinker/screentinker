# ScreenTinker — Tizen TV Player (`.wgt`)

A Samsung **Tizen TV / signage** web port of the ScreenTinker player. It speaks the
**exact same `/device` socket.io protocol** as the Android player, so a Tizen
display pairs and plays from the same dashboard with no server changes.

## What it does
- Enter a server URL → connects to `{server}/device` (socket.io v4).
- Registers, shows a **6-digit pairing code**; you claim it in the dashboard
  (Devices → Pair a display). On `device:paired` it switches to playback.
- Reconnects automatically with a stored `device_id` + `device_token`.
- Renders **multi-zone layouts** (matching the Android player) when a layout is assigned —
  each zone has its own percent geometry, `z_index`, `fit_mode`, background, and rotates its
  own assignments independently — and falls back to **fullscreen single-zone** when no
  layout is set, looping:
  - **image** → shown for `duration_sec` (min 3s)
  - **video** (`/api/content/{id}/file` or `remote_url`) → plays to end, then next; single item loops
  - **YouTube** (`mime video/youtube`) → muted autoplay `<iframe>` embed
  - **widget** → `<iframe>` of `{server}/api/widgets/{id}/render`
- Sends `device:heartbeat` every 15s (with best-effort Tizen telemetry).
- Keeps the screen awake (`tizen.power` / Samsung `appcommon` screensaver-off).
- **Video walls** (mirrors the web player): when the device is a wall member the payload
  carries `wall_config`; the stage is positioned (in vw/vh) as this screen's slice of the
  wall, the leader broadcasts `wall:sync` and followers align index + drift-correct their
  video to the leader's clock. Per-tile `rotation` is not applied yet (matches the web
  player); video walls have no Android equivalent.

## Files
```
config.xml          Tizen TV web-app manifest (privileges, profile, icon)
index.html          setup / pairing / stage screens
css/style.css
js/app.js           device protocol client (register, pair, heartbeat, state)
js/player.js        fullscreen playlist renderer
js/socket.io.min.js socket.io-client v4.7.5 (bundled)
icon.png
build-wgt.sh        package (signed if Tizen CLI present, else unsigned)
```

## Build
```bash
./build-wgt.sh            # -> ScreenTinker.wgt
```
Without the Tizen CLI this is an **unsigned** `.wgt`.

> **Why the released `.wgt` is unsigned:** Samsung **distributor** certificates
> are locked to the **DUID** of the signer's own TVs, so a `.wgt` we signed would
> not install on your TV anyway. Releases therefore ship it unsigned (for
> inspection only). To actually run it, use **path A** (no signing) or sign it
> yourself with your own certificate (**path B**).

## Deploy — two paths

### A) URL Launcher / TV browser (easiest, no signing)
No package, no Tizen Studio. Point the TV's **URL Launcher** (or just its web
browser) at your server's built-in web player: `https://<your-instance>/player`.
The TV runs it as a web app on boot, pairs with a 6-digit code, and plays - best
for Samsung B2B signage (SSSP). (You can instead self-host this `tizen/` folder
and point the URL Launcher at `…/index.html` for the Tizen-specific build.)

### B) Signed `.wgt` (installed app)
A signing profile is already set up on the build box (Tizen Studio CLI 6.1):
- **Profile `ScreenTinker`** = a self-signed **author** cert
  (`~/tizen-studio-data/keystore/author/st_author.p12`) + the default Tizen
  **distributor** cert. `./build-wgt.sh` auto-detects the CLI and signs with it,
  producing a `.wgt` with `author-signature.xml` + `signature1.xml`.
- This installs on **developer-mode** Samsung TVs and the **Tizen emulator** —
  the right path for a **self-hosted fleet you control** (enable Developer Mode
  on each TV once: Apps → enter `12345` → set the host IP).

Install onto a dev-mode TV:
```bash
sdb connect <tv-ip>
tizen install -n ScreenTinker.wgt -t <tv-device>
```

**Production / retail (no developer mode):** re-sign with a Samsung **Partner**
or **Public** distributor certificate from the Tizen **Certificate Manager**
(free Samsung account; distributor cert tied to each TV's **DUID**), then
`./build-wgt.sh <thatProfile>`. The self-signed author cert is not committed (it
lives in `~/tizen-studio-data`, password `screentinker`).

## Validated (2026-06-09)
- **Protocol**: headless test against the live server passed end-to-end —
  `register(pairing_code) → device:registered → pair → reconnect(device_id+token)
  → device:playlist-update(2 items) → GET /api/content/{id}/file = 200`.
- **Runtime**: loads + renders in Chromium with no JS errors (setup screen verified).
- Not yet on real Tizen hardware — needs signing + a TV (or URL Launcher).

## Remote control & preview (#120 / #121)
The Tizen player now listens for the same dashboard events as the web/Android player.
What it can actually do depends on what a **sideloaded web app** is allowed to do on
the TV runtime:

| Command (`device:command` type)   | Tizen behaviour                                            |
|-----------------------------------|-----------------------------------------------------------|
| `refresh`                         | `location.reload()`                                       |
| `launch` / `screen_on`            | clears the screen-off overlay + re-requests screen-awake  |
| `screen_off`                      | black full-screen overlay (content keeps running behind)  |
| `update`                          | toast: must re-install the `.wgt` (see **Updates** below) |
| `reboot` / `shutdown`             | MDM-only — not reachable from a sideloaded app (toast)    |
| `device:screenshot-request`       | best-effort capture (see note)                            |
| `device:remote-start` / `-stop`   | start/stop ~1 fps preview streaming                       |

> **Screenshot/preview note:** the TV decodes `<video>` onto a hardware overlay plane
> and plays YouTube in a cross-origin `<iframe>`, neither of which can be read back into
> a `<canvas>`. So **images capture for real; video/YouTube fall back to a status card**
> (device + timestamp). The dashboard preview shows a truthful frame rather than a dead
> button. Full-fidelity video preview isn't feasible on the sideloaded Tizen runtime.

> **`screen_off`** uses an overlay, not a real panel power-off — a sideloaded app has no
> clean panel-power API. On B2B/MDM (SSSP) firmware, true power and `reboot`/`shutdown`
> go through Samsung's device-management channel, not this app.

## Updates (#122)
There is **no in-app OTA** for a sideloaded, signed `.wgt`. Updating a screen means
**re-building and re-sideloading** the `.wgt` (path B above), or — on Samsung B2B
signage — pushing it through the **URL Launcher refresh / MDM (MagicINFO / SSSP)**
channel. The dashboard `update` command therefore just tells the screen an update is
pending; it cannot self-apply. If you run the **URL Launcher path (A)**, a plain
TV reboot re-fetches `…/player` and you're current with the server with no `.wgt` step.

## Auto-launch on boot (#122)
Boot auto-start for a **sideloaded** consumer TV web app is a **display setting, not an
app setting** — there's no `config.xml` autostart for the TV profile. Configure it on
the panel:
- **URL Launcher path (A):** set the URL Launcher as the boot app (it relaunches on
  power-up automatically) — the recommended signage setup.
- **Signed-app path (B):** use the TV's **kiosk / auto-start app** setting (B2B/SSSP
  firmware) to launch ScreenTinker on boot; on dev-mode consumer TVs there's no
  guaranteed boot-launch, so the URL Launcher path is preferred for unattended screens.

## Version reporting (#119)
`app_version` is sourced from `config.xml`'s `version=""` — read at runtime via the
Tizen application API, with a build-stamped constant fallback (`build-wgt.sh` stamps it
from `config.xml`). The dashboard always shows the version actually installed.
