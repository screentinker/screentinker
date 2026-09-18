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
js/device-control.js Samsung B2B/system fleet control (device:command) — #125
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

### Samsung Apps TV (Seller Office) package
```bash
./build-wgt.sh --store    # -> ScreenTinker-store.wgt
```
Same app, one difference: the manifest inside is rewritten for the **consumer** store. The
Seller Office pre-test (2026-09-18) refuses the SSSP manifest on four counts that are all one thing —
`background-support="enable"` and every `developer.samsung.com` privilege other than
`network.public` (`b2bcontrol`, `systemcontrol`, and the `b2b*` family) are **partner-only**. On a
consumer TV those APIs are absent anyway and `device-control.js` reports `unsupported`, so nothing
is lost. `config.xml` itself is never edited; the copy in the staging dir is, so the SSSP build keeps
its fleet-control surface. Never tick extra privileges in a Tizen Studio project for the store
upload — that is how the rejected 2.0.8 package got fifteen of them.

The store also requires a **Samsung** author + distributor certificate (Tizen Studio → Certificate
Manager → Samsung, signed in with the seller account). A package signed with the SDK's default
*Tizen Public Distributor Signer* (test CA) will not be accepted. Re-sign on the machine that holds
that profile:
```bash
tizen package -t wgt -s <SamsungProfile> -- ScreenTinker-store.wgt
```
Bump `version` in `config.xml` before each upload — Seller Office rejects a version it has seen.

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

### C) SSSP URL-Launcher native install (one URL, like Fusion `fus.app/tizen`)
The slick "add the screen to Wi-Fi → **URL Launcher / Custom App** → type a URL → you're in"
flow. The panel fetches `<url>/sssp_config.xml`, reads the version + byte size, downloads
`ScreenTinker.wgt` from the same folder, and **installs it as a native app** — auto-reinstalling
whenever `<ver>` bumps on the next release.

**The ScreenTinker server hosts this for you.** Drop a signed build at `/data/ScreenTinker.wgt`
(same convention as `/data/ScreenTinker.apk`) and it's served at:
- `GET /tizen/sssp_config.xml` — manifest, generated dynamically so `<size>` always matches the
  exact `.wgt` bytes (a mismatch fails the install).
- `GET /tizen/ScreenTinker.wgt` — the package.
- `GET /tizen` — a human landing page with the install steps.

On the panel, under **URL Launcher / Custom App**, enter: `https://<your-instance>/tizen`

To host on a **CDN/bucket** instead (not the ST server), `./build-wgt.sh` also drops a static
`sssp_config.xml` next to the `.wgt`; upload both to one folder and point the panel at that folder.
Env `TIZEN_WGT_VER` overrides the reported version; the default is the app version.

> **Signing (the one real prerequisite):** the URL-Launcher / `sssp_config.xml` path **always**
> requires a **Samsung Partner distributor certificate** — a public/self-signed build fails here
> with `error -3: invalid certificate chain`, `error -4: invalid signature`, or
> `install failed[118012]`, and a normal distributor cert is DUID-locked. Get the Partner cert via
> **TV Seller Office** (developer side; your Samsung **Ascend** channel/B2B contact is the fastest
> route to approval), re-sign `build-wgt.sh` with that profile, and one URL installs on every panel.
>
> **Developer Mode does NOT bypass this.** Dev Mode only enables the **SDB** install path
> (`sdb connect` + `tizen install`), which *does* accept a self-signed build on the panel's DUID —
> a separate, manual path, not the URL flow. So without the Partner cert you can (a) SDB-install
> the self-signed `.wgt` on a dev-mode panel to prove the app runs on real Tizen hardware, or
> (b) use URL-Launcher **web** mode (Path A → `/player`) for the type-a-URL feel without a native
> install. The `sssp_config.xml` native install specifically waits on the Partner cert.

## Validated (2026-06-09)
- **Protocol**: headless test against the live server passed end-to-end —
  `register(pairing_code) → device:registered → pair → reconnect(device_id+token)
  → device:playlist-update(2 items) → GET /api/content/{id}/file = 200`.
- **Runtime**: loads + renders in Chromium with no JS errors (setup screen verified).
- Not yet on real Tizen hardware — needs signing + a TV (or URL Launcher).

## Remote control & preview (#120 / #121 / #125)
The Tizen player listens for the same dashboard events as the web/Android player.
`device:command` is handled by `js/device-control.js`, which drives the real Samsung
fleet-control surface (`webapis.systemcontrol` on Tizen 6.5/7, else `b2bapis.b2bcontrol`
on SSSP/Tizen 4) and reports each outcome back via `device:log` (tag `command`, shown
live on the device-detail screen) plus a structured `device:command-result`:

| Command (`device:command` type)   | Tizen behaviour                                                        |
|-----------------------------------|------------------------------------------------------------------------|
| `refresh` / `reload`              | `location.reload()`                                                    |
| `launch` / `screen_on`            | clears the screen-off overlay + re-asserts wake; `setPanelMute("OFF")` when the B2B surface is present |
| `screen_off`                      | `setPanelMute("ON")` (backlight off) on a B2B panel; **black overlay fallback** otherwise |
| `update`                          | reload to re-pull URL-Launcher content (no in-app OTA — see **Updates**) |
| `reboot`                          | `rebootDevice()` on a B2B panel; `unsupported` otherwise               |
| `shutdown`                        | `setPanelMute("ON")` + note (SSSP web API has no true power-off)        |
| _unknown_                         | reported as `unsupported`                                              |
| `device:screenshot-request`       | best-effort capture (see note)                                         |
| `device:remote-start` / `-stop`   | start/stop ~1 fps preview streaming                                    |

> **Partner-signing caveat (#125):** the `b2bcontrol` / `systemcontrol` privileges in
> `config.xml` only take effect on a **partner-signed `.wgt` on a real SSSP panel**. On
> the dev/URL-Launcher/web build (or a consumer TV) those surfaces are absent, so reboot
> returns `unsupported`, `screen_off` uses the black overlay, and the startup capability
> log reports `backend=none`. Only a partner-signed build on real hardware fully
> validates reboot / panel power.

> **Screenshot/preview note:** the TV decodes `<video>` onto a hardware overlay plane
> and plays YouTube in a cross-origin `<iframe>`, neither of which can be read back into
> a `<canvas>`. So **images capture for real; video/YouTube fall back to a status card**
> (device + timestamp). The dashboard preview shows a truthful frame rather than a dead
> button. Full-fidelity video preview isn't feasible on the sideloaded Tizen runtime.

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
