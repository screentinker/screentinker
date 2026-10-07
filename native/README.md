# ScreenTinker native player — Raspberry Pi and Windows

One native player with Android-app parity, two operating systems. It is not the web player in a
browser: playback, zones, transitions, sync, triggers and device control are native Python/Qt code,
and QtWebEngine is used only where Android uses a WebView (widgets, YouTube, HTML bundles, and the
WebRTC intercom/live view).

- **Engine** (`screentinker_native/`, OS-neutral): socket, playback, zones, transitions, sync,
  triggers, cache, QML scene. **OS backends** (`screentinker_native/platform/linux`, `…/windows`):
  device info, screen power, mixer, brightness, shell/PTY, the privileged door, OS actions. Nothing
  above `platform/` may test the OS itself.
- **Stack:** Python + **PySide6** (Qt for Python, **LGPL-3.0**). ⚠️ Never PyQt6 — it is GPL-3.0, and
  ScreenTinker ships no GPL code. python-socketio, aiohttp.
- **Raspberry Pi:** Pi 4 / Pi 5 / Pi 400 / CM4 on **Pi OS Trixie (Debian 13)**, 64-bit, Lite or
  Desktop — the first Debian that packages PySide6. A `.deb` (`Architecture: all`) whose dependencies
  all come from the distribution. Bookworm Pis: upgrade, or use the web-kiosk installer.
- **Windows:** Windows 10 1809+ / 11, x64. An Inno Setup installer bundling everything (PyInstaller),
  plus the `ScreenTinkerHelper` service.

## Install — Raspberry Pi
On the Pi, pointing at your ScreenTinker server:

```sh
curl -sSL https://your-server/scripts/raspberry-pi-setup.sh | sudo bash -s -- --native https://your-server
```

That downloads the player from your server (`/download/pi`), installs it with apt (which pulls the
Qt/GStreamer dependencies), and runs `screentinker-pi setup`. A pairing code appears on the display;
enter it in the dashboard under **Displays → Add display**.

Manual equivalent:

```sh
curl -fLo /tmp/st.deb https://your-server/download/pi
sudo apt install /tmp/st.deb
sudo screentinker-pi setup https://your-server              # mode detected: desktop if the Pi boots to one, else lite
sudo screentinker-pi setup https://your-server --mode desktop --user pi   # force: inside the desktop
```

### Run modes

| | Lite (recommended) | Desktop |
|---|---|---|
| Draws with | KMS/eglfs, no compositor | the desktop session (labwc, wayfire or X11) |
| Runs as | dedicated `screentinker` user (no sudo) | the desktop user |
| Started by | `screentinker-pi.service` | `/etc/xdg/autostart/screentinker-pi.desktop` |
| State | `/var/lib/screentinker-pi` | `~/.local/state/screentinker-pi` |

⚠️ **Overlay filesystem:** the state directory holds the pairing. With Pi OS's read-only overlay on,
it is discarded at every boot and the panel re-pairs. Point `ST_STATE_DIR` at a persistent partition,
or pair and then enable the overlay knowing a re-pair follows any wipe.

## Install — Windows

Download `ScreenTinker-Setup-<version>.exe` from your server (`https://your-server/download/win`) and
run it, or roll it out silently:

```
ScreenTinker-Setup-X.Y.Z.exe /VERYSILENT /SERVER=https://your-server [/NAME="Lobby"] [/ALLOWPACKAGES=1]
```

It installs the player to Program Files, the **ScreenTinkerHelper** service (LocalSystem), a firewall
rule for the LAN trigger/control ports, and `%ProgramData%\ScreenTinker\config.json` (admin-only).
The helper starts the player full screen in the signed-in user's session and restarts it if it dies,
so a kiosk PC needs **automatic sign-in** (netplwiz / Autologon) and nothing else. An upgrade keeps
the configuration and the pairing. "Exit player" on the on-screen menu stops the relaunching until the
next sign-in.

## What it does (parity with the Android app)

Everything the Android player declares, plus `system.pty`. The authoritative, per-row status is
`docs/player-parity.md`; the device protocol additions are in `docs/pi-native-player.md`.

- Playback: images, video (incl. HLS/RTSP live streams), widgets, YouTube, HTML bundles, multi-zone
  layouts, GL transitions (the shared library, baked for Qt with `qsb`), PiP, slide voiceover and music.
- Scheduling: per-item dayparts, date windows, `play_when` conditions, shuffle/weighted order, default
  (standby) content — all from the shared, vector-tested evaluators.
- Offline: resumable, revision-keyed media cache; cold start from the cached playlist; proof-of-play
  queued while offline and replayed on reconnect.
- Sync: video walls (leader/follower) and clock-scheduled group sync, on the server-disciplined clock.
- LAN: UDP/HTTP triggers with priority/hold/lease, and the local control API.
- Remote: screenshots, the live remote view, touch/key input, WebRTC live video and intercom.
- Device: reboot, shutdown, screen on/off (backlight, HDMI-CEC, DPMS and an always-black overlay),
  volume, per-window and system brightness (backlight / DDC-CI), time and timezone, the display power
  schedule, `set_server_url` with verify-and-rollback, `http_request` from the panel's own network,
  kiosk lock, block-uninstall, one-shot shell and an **interactive terminal**, self-update and
  package install.

## Security model

- **Windows:** everything that needs SYSTEM goes to the ScreenTinkerHelper service over a named pipe
  with a fixed verb list, and **only the installed `ScreenTinker.exe` may call it** — another program
  running as the same user (including the dashboard's own remote shell) is refused. An installer runs
  only if its sha256 matches what the ADMIN-configured server announces (the helper asks the server
  itself); anything else needs `/ALLOWPACKAGES=1`. See `docs/windows-native-player.md`.
- **Pi:** the player runs **unprivileged**. Root-only actions go through `/usr/lib/screentinker-pi/st-helper`,
  a fixed verb list with every argument re-validated, granted by `/etc/sudoers.d/screentinker-pi` to the
  `screentinker` group and nothing else. There is no generic "run as root" verb, and there must never be.
- The remote shell and the interactive terminal run as the player's user. In Lite mode that is a
  system user without sudo. In Desktop mode it is the desktop user: **if that user has sudo, so does the
  dashboard's terminal** (`setup` says so).
- `install_apk {url}` installs the player's own package freely, but any other `.deb` only when setup
  was run with `--allow-package-install` — a package's maintainer scripts run as root.
- `http_request` refuses cloud-metadata addresses before and after DNS resolution and pins the
  connection to the vetted address.

## Development

```sh
cd native
pip install PySide6-Essentials PySide6-Addons 'python-socketio[asyncio_client]' aiohttp pytest
python3 -m pytest -q                               # logic ports (shared vectors) + player units
# ⚠️ On a workstation, run players SILENT and away from the host mixer:
export ST_TEST_NO_SYSTEM_AUDIO=1 PULSE_SERVER=unix:/nonexistent PIPEWIRE_REMOTE=/nonexistent
QT_QPA_PLATFORM=offscreen python3 -m screentinker_native --server http://localhost:3001 \
    --state-dir /tmp/st-dev --windowed -v          # headless (software scene graph: transitions crossfade)
packaging/linux/build-deb.sh                       # -> native/dist/screentinker-pi_<VERSION>_all.deb
```

Windows (on a Windows machine with Python 3.12 x64 and Inno Setup 6):

```powershell
powershell -ExecutionPolicy Bypass -File native\packaging\windows\build.ps1 [-Version X.Y.Z]
# -> native\dist\ScreenTinker-Setup-<VERSION>.exe (served at /download/win, /api/win/update/check)
```

A server serves the newest `screentinker-pi_<ver>_all.deb` it finds in `DATA_DIR`, then `native/dist/`,
at `/download/pi` and to `/api/pi/update/check`. Versions are `X.Y.Z` or `X.Y.Z~rcN` — never a Debian
revision (`X.Y.Z-1` would read as a prerelease and never be offered).

Layout:

```
screentinker_native/
  app.py            process wiring: Qt thread + network thread, the single command dispatch
  net/link.py       the device socket (Android WebSocketService discipline)
  net/triggers.py   LAN triggers + local API        net/device_http.py  http_request + endpoints
  player/           engine (layouts, sync), controller (PlaylistController port), cache, transitions
  system/           display power, audio, brightness, shell + PTY, power schedule, updater, root helper door
  logic/            pure ports held to shared/*-vectors.json and the Kotlin unit tests
  ui/               Stage (QML bridge), QML scene, slide audio, trigger overlay, WebRTC page
packaging/          build-deb.sh, st-helper, systemd unit, autostart, sudoers, the CLI
```
