# Samsung SSSP3 / Orsay native player

A native ScreenTinker player for legacy Samsung signage panels running the
SSSP3 platform ("legacy Orsay" — the 2015-era WebKit engine, **not** modern
Tizen). The package is a small ES5 fork of the web player core that pairs over
the standard Socket.IO protocol, caches content and schedule plans in the
panel's native local storage (`/mtd_down/common/…`), and runs media through
both the HTML compositor and the panel's own native video plane.

## Install on a panel (URL Launcher)

1. Connect the panel to the same network as the ScreenTinker server. Give the
   panel the full server URL under remote network settings if you want the
   setup screen prefilled.
2. On the panel, open Setup → `URL Generator` / URL Launcher and enter
   `http://<server>:3001/sssp3`.
3. The panel fetches `sssp_config.xml`, compares `<ver>`, downloads
   `ScreenTinkerSSSP3.zip` and installs it. The app then boots locally (the
   package declares `<network>n</network>` and `<autoUpdate>n</autoUpdate>`)
   and shows the same pair-by-server-URL setup screen as the web player.
4. Pair it with a screen/register device in ScreenTinker as usual.

Versions are integers and installs move strictly upward (a panel never
downgrades `<ver>`). The package build owns `<ver>` through `release.json`. When you mount an archive at `/data/ScreenTinkerSSSP3.zip`, set `SSSP3_WGT_VER` to the **same positive integer** before starting the server; the server refuses to advertise an external archive without that explicit match. This prevents a panel from downloading an archive whose internal and launcher versions disagree.

## Package layout

- `app/` — player source. `index.html` is the audited legacy renderer snapshot
  with native hooks elided; `prepare.js` re-injects the native bridge wiring
  (offline plan, media, screenshots, timezone table) as literal code replacements
  that fail loudly if upstream shifts under them. `native-bridge.js` is the
  Samsung-plugin layer (SAMSUNG-INFOLINK-DOWNLOAD/PLAYER, FileSystem journal,
  native gapless attempts, screenshot capture).
- `socket.io-client@4.8.3` is pinned in `package-lock.json`; `prepare.js`
  transpiles its browser distribution to ES5 and packages it locally. The
  generated vendor file is deliberately not tracked.
- `tests/` — vm-sandboxed unit tests of the bridge/schedule/offline plan, a
  legacy syntax contract (no block-level function declarations), and optional
  browser smokes via `CHROME_PATH`.
- `build-sssp3.sh` — deterministic build (`dist/ScreenTinkerSSSP3.zip` with
  fixed 1980 timestamps + `dist/sssp_config.xml` where `<size>` is BYTES — the
  Orsay manifest unit, unlike the Tizen one), then `verify.js` checks the
  artifact/manifest consistency (`network=n`, `autoUpdate=n`, frozen
  capability contract, platform string).
- `release.json` — package identity + integer version.

Build locally:

```console
$ cd samsung-sssp3 && npm install && npm run build
```

Only build-time devDependencies in this directory are needed; nothing is
added to the server's dependencies. Serve the result via the operator mount
(`/data/ScreenTinkerSSSP3.zip`) or let the dev route fall back to the built
`dist/` package.

## Server side

`/sssp3/sssp_config.xml` + `/sssp3/ScreenTinkerSSSP3.zip` mirror the `/tizen`
URL-launcher flow. A device must opt in to the offline features it consumes:
the player registers the regular capability list (`playback.*`,
`remote.screenshot`, `system.restart_player`, `sync.clock`, `clock.tz_table`,
`offline.schedule_plan`), and the server only attaches the offline plan
payload (and reconciles the returning schedule on reconnect) to players that
declared `offline.schedule_plan`. Widgets the panel is asked to render are
served through the `?compat=sssp1228` legacy path (static, script-free
snapshots; the legacy Orsay engine cannot run iframes). Media is served in
fit renditions (`<name>.<fit>-<WxH>.<ext>`) because Orsay paints video and
images at encoded pixel size and ignores CSS scaling.

The server contracts are split for independent review: safe renditions are in
#803, offline schedule plans in #804, and legacy widget output in #805. The
general recurrence changes are separately documented in #802. This native
package builds and installs without those changes; each contract enables its
corresponding optional capability after it is merged.

## Compatibility and known limits

Tested on hardware: **Samsung DB48E (SSSP3, firmware T-GFSLE2AKUC-1026.6)**,
1920×1080. Other Samsung models/firmware are **not** verified by this port.

Verified by installation on that panel: native install + boot, pairing over
the ScreenTinker Socket.IO protocol, content/image/widget clock/date
rendering, item layouts, cached-content restore after a warm disconnect,
offline schedule plan, schedule-driven playback in the panel timezone, and
screenshot diagnostics.

Hardware/software limits that remain open (see `KNOWN-ISSUES.md`):

- **Native gapless video-to-video is unresolved.** The panel's native LFD
  playlist only switches seamlessly between matching decoder characteristics
  (`st_native_gapless_signature`); distinct videos show a black/decoder
  transition gap, and one earlier gapless attempt produced an invalid solid
  framebuffer, so that path stays disabled.
- **One native video plane.** Only one native video surface is verified;
  zoned/PiP layouts keep video in the HTML compositor. Un-MP4 audio/video is
  refused with an explicit status.
- **Cold boot from deep offline state is contradictory.** The panel boots
  from a complete outage only after the URL-Launcher manifest check — an
  offline cold boot was observed to start eventually (~2 min); a controlled
  long-outage test is still pending, and no air-gap claim is made.
- Native video bypasses HTML audio controls (no mute/volume/HLS/WebRTC
  guarantees), live webpages/cloud widgets need their own providers and are
  not offline-complete, and no soak/fleet certification has been performed.
