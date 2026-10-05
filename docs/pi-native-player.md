# Raspberry Pi native player — server contract

The native Pi player (`native/`, Python + PySide6, shipped as `screentinker-pi_<ver>_all.deb`) talks to the
server exactly like the Android APK: Socket.IO on `<server>/device`, `device:register`, heartbeats,
`device:command`. This page records only what is **new or different** for it. It is not the
Chromium-kiosk install that `scripts/raspberry-pi-setup.sh` sets up — that one is a browser and
registers as the web player.

Install and run modes (`scripts/raspberry-pi-setup.sh --native URL [--native-mode lite|desktop]`):

| mode | chosen when | runs as | log |
|---|---|---|---|
| `lite` | no display manager boots (`display-manager.service` absent, or default target not `graphical.target`) | `screentinker-pi.service`, user `screentinker`, eglfs/KMS on the display; `getty@tty1` disabled | `journalctl -u screentinker-pi` |
| `desktop` | a display manager is enabled **and** the default target is `graphical.target` | `/etc/xdg/autostart` in the login session of the lightdm autologin user (else the sudo user); the service is disabled | `~/.local/state/screentinker-pi/player.log` |

⚠️ The mode is NOT taken from installed packages: the Chromium-kiosk install puts `xserver-xorg` on
Lite, and reading that as "desktop" left the service disabled while the kiosk's X server held the
screen (`Could not set DRM mode … Permission denied`). The native install removes the kiosk's
launchers (`screentinker-kiosk.service`, and `~/.config/autostart/screentinker.desktop` when it runs
`screentinker-kiosk.sh`); the All-in-One server unit is left alone.

Anything marked ❓ is a question for the device side.

## 1. Identity (`device:register`)

| field | value | server use |
|---|---|---|
| `client_type` | `'pi'` | `platformFamily()` → `'linux'` (either this **or** `platform`) |
| `platform` | `'Linux/<distro> (<model>)'`, e.g. `Linux/Debian 12 (Raspberry Pi 5 Model B Rev 1.0)` | `platformFamily()` → `'linux'` (prefix `Linux/`, case-insensitive) |
| `contract_version` | `'v4'` | liveness |
| `capabilities` | always sent | replaces the baseline (`parseDeclared`) — unknown names are dropped silently |
| `device_info.android_version` | `''` | ⚠️ must stay empty or absent; the Android fallback claims any other non-`Web/` value (the `linux` arm is matched first, so it would not misclassify today — but keep it empty) |
| `device_info.hardware_model` / `hardware_serial` / `hardware_os_version` / `hardware_edid` | model, CPU serial, `Debian GNU/Linux 12 (bookworm)`, base64 EDID | COALESCE'd into the device row (64-char cap on the strings); shown on the Info tab |
| `device_info.capture_mode` | `'view'` | the remote-view notice |
| heartbeat `telemetry.temperature_c` | SoC °C (number) | the Temperature card; RAM/CPU/storage cards render whenever their fields arrive |

`BASELINE.linux` (for a row with a NULL capability column) is deliberately the floor: playback,
audio, rotation/power/brightness, screenshot/stream/input, reboot/restart/self-update, clock sync,
offline cache. It grants **no** `system.shell`, `system.pty`, `system.kiosk`, `system.time`,
`system.install_apk`, and none of the "brand new — in no baseline" names (`playback.hls`,
`playback.rtsp`, `net.http_request`, `display.power_schedule`, `remote.set_server_url`). A Pi that can
do those must declare them.

The server tests read `native/screentinker_native/capabilities.py` when present (skipped otherwise):
`CAPABILITIES_ALWAYS = [ '...', ... ]` must contain only names in `CAPABILITIES`
(`server/lib/player-capabilities.js`), and every `BASELINE.linux` entry must be named somewhere in
that file **or** in `platform/linux/*.py` (where the privilege/hardware-dependent names —
`system.reboot`, `system.time`, `system.install_apk`, … — moved when the engine gained a Windows
backend; see [`windows-native-player.md`](windows-native-player.md)). Only quoted `group.name` strings are read, so keep them as plain literals.

## 2. Commands the dashboard now sends a Pi

Unchanged wire format (`device:command {type, payload}`), gated by capability as for every player:

| command | capability | note |
|---|---|---|
| `shell {cmd}` | `system.shell` | one-shot; answer with `device:shell-result {cmd, output, exit}` (output capped at 8000 chars server-side) |
| `install_apk {url}` | `system.install_apk` | the dashboard labels it "Install package (.deb URL)" for a Pi; the Pi hands the URL to dpkg |
| `kiosk_lock` / `kiosk_unlock` / `lock_now` / `power_menu` | `system.kiosk` (stand-in for `system.device_owner`) | the dashboard shows these for a Pi that declares `system.kiosk` |
| `set_time` / `set_timezone` | `system.time` | no dashboard control exists yet |
| `set_server_url {url}` | `remote.set_server_url` | no enrol key is minted for `client_type 'pi'` (that is for browser players only) |

## 3. Interactive terminal (PTY) — `system.pty`

A real PTY on the device, relayed byte-for-byte by `server/lib/pty-relay.js`. `data` is always
**base64 of raw bytes**, in both directions.

```
dashboard → server   dashboard:pty-open   {device_id, cols, rows}
                     dashboard:pty-input  {session_id, data}
                     dashboard:pty-resize {session_id, cols, rows}
                     dashboard:pty-close  {session_id}
server → device      device:pty-open   {session_id, cols, rows}
                     device:pty-input  {session_id, data}
                     device:pty-resize {session_id, cols, rows}
                     device:pty-close  {session_id}
device → server      device:pty-data {session_id, data}
                     device:pty-exit {session_id, code, reason?}
server → dashboard   dashboard:pty-opened {device_id, session_id}        (opener's socket only)
                     dashboard:pty-data   {device_id, session_id, data}  (opener's socket only)
                     dashboard:pty-exit   {device_id, session_id, code, reason}
                     dashboard:pty-error  {device_id, error}
```

Server rules:

- **Authorisation** is exactly the `shell` command's: write tier on the device's workspace
  (`canActOnDevice(…, 'write')`), plus `supports(device, 'system.pty')`, plus a device socket
  attached to **this** process. `pty-error` values: `invalid`, `forbidden` (also for an unknown
  device), `unsupported`, `offline`, `replica` (copied workspace — never tunnelled),
  `too_many_sessions_device`, `too_many_sessions_user`.
- **Session ids** are 128-bit random hex. Input/resize/close are honoured only from the dashboard
  socket that opened the session; `device:pty-data`/`-exit` only from the socket-authenticated
  device the session is on. Everything else is dropped **silently**.
- **Caps:** ≤ 2 open sessions per device, ≤ 4 per user, frames ≤ 64 KiB of base64 (larger frames
  are dropped, the session survives — the dashboard sends ≤ 32 KiB raw per frame). `cols` ≤ 500,
  `rows` ≤ 300; invalid values become 80×24.
- **Lifetime:** 30 min without input or output closes both sides (`reason: 'idle_timeout'`). The
  dashboard socket disconnecting sends `device:pty-close` for its sessions. The device socket
  disconnecting ends its sessions with `dashboard:pty-exit {reason: 'device_offline'}` and also
  emits `device:pty-close` to the device room, in case the PTY survived a reconnect.
  Server-originated `pty-exit` reasons: `closed_by_user`, `idle_timeout`, `device_offline`; a
  device-originated one carries the device's `reason` (default `'exited'`).
- **Audit:** `activity_log` rows `device_pty_open` / `device_pty_close` (user, device, ip, duration,
  reason). Keystrokes are **not** recorded.
- **Never a mesh command** and never relayed across one.

Device side (what the server expects): spawn the PTY on `device:pty-open`, stream output as
`device:pty-data`, send `device:pty-exit` when the child exits, and kill the child on
`device:pty-close` **and** when its own socket disconnects.

## 4. Self-update

```
GET /api/pi/update/check?version=<current>&device_id=<id>[&forced=1]
→ { update_available, latest_version, current_version, download_url: '/download/pi',
    sha256, size, reason, retry_after_seconds? }
GET /download/pi   → the .deb (Content-Disposition carries the real filename; X-Package-Sha256, X-Package-Version)
```

- Package source: the newest `screentinker-pi_<ver>_all.deb` in `DATA_DIR`, else `<repo>/native/dist/`
  (first directory with any match wins). `<ver>` is `X.Y.Z` or `X.Y.Z~pre` / `X.Y.Z-pre`; `~` is
  normalised to `-` in `latest_version`.
- ⚠️ A release always beats a prerelease in the same directory (there is no Pi beta channel yet), so
  a test build beside a release is never offered to the fleet.
- Same rules as the Android check: `OTA_ENABLED=false` → `ota_disabled_global`;
  `devices.ota_enabled = 0` → `ota_disabled_device`; then `otaBreaker.decide()` (reasons
  `up-to-date`, `client-newer`, `superseded-prerelease`, `rate-backoff`, `no-progress`,
  `forced-override`, `unrecognized-version`, `no-version`, `offer`). Also `deb-missing` (nothing
  hosted) and `deb-hashing` (hash not computed yet — retry). `sha256`/`size` are only set on an offer.
- The download shares the global OTA admission guard with `/download/apk` (503 + `Retry-After` under
  load).
- The device should verify `sha256` before installing and report the new version on its next
  register; the no-progress breaker stops offering a version the device keeps failing to install.

## ❓ Open questions for the device side

1. **Version string.** The check compares with semver (`ota-breaker`). A Debian revision
   (`1.2.0-1`) would parse as a *prerelease* of 1.2.0. Report and name builds as `X.Y.Z` (or
   `X.Y.Z~rcN`), and send exactly that as `version`.
2. **`install_apk` for a .deb** — is the Pi declaring `system.install_apk`? Without it the server
   refuses the command and the dashboard hides the field.
3. **`system.kiosk`** — the dashboard now sends `lock_now` and `power_menu` to a Pi that declares it
   (they share its gate). Does the Pi handle both, or should it not declare `system.kiosk`?
4. **Settings PIN** — the Info tab shows the settings PIN card for a Pi. Does the Pi have an on-device
   settings menu behind that PIN?

## Self-update trust model (st-helper `install-deb`)

The player downloads the .deb (size + sha256 checked against the update check), but the root helper
does not trust that: it copies the file to a root-only directory, and installs a `screentinker-pi`
package only if its sha256 equals what `GET <server_url>/api/pi/update/check?version=0.0.0&forced=1`
returns, with `server_url` read from the ROOT-owned `/etc/screentinker-pi/config.json` (written by
`screentinker-pi setup`). The package name alone proves nothing — the player user can build a .deb
called screentinker-pi. Any other package still needs `allow_package_install`. The check route answers
a device-less lookup for this (`anonymousLookup` in routes/pi-update.js), never charged to the OTA
breaker. A package held by `block_uninstall` is un-held for the upgrade and held again afterwards.

⚠️ After `set_server_url`, the helper still verifies against the server in `/etc` (by design — the
player's own state is not trusted); re-run `screentinker-pi setup <new-url>` on panels that move.
