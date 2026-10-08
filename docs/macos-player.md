# macOS native player (beta)

The Raspberry Pi and Windows native player, running on a Mac: the same engine
(`native/screentinker_native/`) with a third OS backend, `platform/macos/`. macOS 12 or later, Apple
Silicon (the CI build) or Intel (built on an Intel Mac).

> **Status: beta.** Everything below that says *verified in CI* ran on GitHub's macOS runner. Nothing
> here has run on a Mac attached to a real display, so the first real install is still a test — see
> [What only a real Mac can confirm](#what-only-a-real-mac-can-confirm).

## Install

1. Build it, or download `ScreenTinker-<version>.dmg` from your instance's `/download/` page (served at
   `/download/mac` when a .dmg sits in `DATA_DIR` or `native/dist/`).
2. Drag **ScreenTinker** to Applications. An ad-hoc-signed build needs Control-click → **Open** on first
   launch (or `xattr -dr com.apple.quarantine /Applications/ScreenTinker.app`); a notarized build does not.
3. Start it at login, pointed at your server:

   ```sh
   /Applications/ScreenTinker.app/Contents/MacOS/ScreenTinker --install-autostart --server https://your-server
   ```

   That writes `~/Library/LaunchAgents/com.screentinker.player.plist` (a per-user LaunchAgent — a player
   draws on the user's display, which a LaunchDaemon cannot) and loads it. `--remove-autostart` undoes it.
4. Pair: the code appears full screen; enter it under **Displays → Add display**.

Fleet pre-configuration: an admin (or an MDM profile) can drop `/Library/Application Support/ScreenTinker/config.json`
— the same keys as the Pi's `/etc/screentinker-pi/config.json` — and the player seeds from it on first run.

## Unattended

- **Keep-awake** is the player's own: a `caffeinate -dimsu -w <pid>` child holds display, idle and system
  sleep off for exactly as long as the player runs. `NSAppSleepDisabled` keeps App Nap off.
- **Restart**: the LaunchAgent has `KeepAlive.SuccessfulExit = false`, so launchd restarts the player
  after a crash (exit 1). The on-screen **Exit player** exits 0 on macOS, so it stays down until the
  next login — launchd cannot tell exit codes apart beyond "clean or not", which is why this backend
  sets `EXIT_BY_OPERATOR = 0` instead of the 42 Windows uses.
- **Power cut**: turn on automatic login for the player account and *Start up automatically after a
  power failure*. Without automatic login, a Mac that reboots waits at the login window.
- **One player per user**: an `flock` on `<state>/player.lock`. A second copy exits immediately.
- **Display**: `--display N` (or `ST_DISPLAY=N`) puts the full-screen window on that output (0 = the
  first screen Qt lists); a missing index falls back to the primary display. The cursor is hidden in
  kiosk mode.
- **macOS 15 Local Network**: the first connection to a server or trigger sender on the LAN shows
  macOS's Local Network prompt; it must be allowed once. MDM cannot pre-approve it.

## What it does, and what it does not

Everything the shared engine does: images, video, HLS/RTSP, widgets, YouTube, HTML bundles, zones,
transitions, video walls and group sync, LAN triggers and the local API, offline cache and cold start,
proof-of-play, screenshots and the live view, remote input, the intercom, the one-shot shell and the
**interactive terminal** (as the signed-in user).

macOS backend specifics:

| | how | declared |
|---|---|---|
| screen off/on | `pmset displaysleepnow` / `caffeinate -u` + the black overlay | `display.power` |
| volume | AppleScript `set volume output volume` (the menu-bar control) | `audio.volume` |
| system brightness | not offered — no supported unprivileged control | — |
| reboot, shutdown, clock, timezone, install | not offered — no privileged helper | — |
| self-update | **not offered** — withdrawn from the shared list | — |
| identity | `IOPlatformSerialNumber` + model + `IOPlatformUUID` (`ioreg`) | |

The player declares exactly what it can do (`capabilities.py` minus `ops.UNSUPPORTED_CAPABILITIES`,
plus `ops.extra_capabilities`), so the dashboard shows no button for the rest. On the wire it is
`client_type: 'mac'`, `platform: 'macOS/<version> (<model>)'` — the server's `platformFamily()` keys
the `macos` family on either.

### Updates

A Mac **does not update itself**. Replacing a signed .app in `/Applications` is an admin action on a
managed Mac and MDM's job on a fleet, and an unverified self-replacing bundle is not something to
ship before it has run on real hardware. So there is no `/api/mac/update/check`, the player makes no
update request, and no OTA rollout ever includes a Mac (`routes/mac-update.js` is the download-only
mode of the shared native-update factory). Update by installing the new .dmg, or push the .app with
your MDM.

### The remote terminal on macOS

Linux starts the interactive shell with `setsid -c` so it gets the pty as its controlling terminal;
macOS has no `setsid(1)`. The Mac backend starts the shell through `screentinker_native/ptyexec.py` —
the player's own binary run with `--st-pty-exec`, a fresh process that calls `setsid()` and
`ioctl(TIOCSCTTY)` and execs the shell. It is never Python code running in a forked child of the
threaded player, which is the deadlock the Linux backend avoids for the same reason. CI checks, inside
the built .app, that the shell is the foreground process group of its terminal.

## Build

```sh
native/packaging/macos/build.sh [VERSION]     # -> native/dist/ScreenTinker-<VERSION>.dmg
```

Needs Python 3.12 and the Xcode command line tools. It builds `ScreenTinker.app` with PyInstaller
(the same tool and pins as the Windows build), writes `Contents/Resources/THIRD-PARTY-NOTICES.txt`,
signs, and packs a .dmg.

| environment | result |
|---|---|
| (none) | ad-hoc signature — fine for testing; Gatekeeper asks on other Macs |
| `ST_CODESIGN_IDENTITY="Developer ID Application: …"` | hardened runtime + `entitlements.plist` |
| `+ ST_NOTARY_PROFILE=<profile>` | also notarizes the .dmg and staples it (`xcrun notarytool store-credentials` first) |
| `ST_TARGET_ARCH=universal2` | only with a universal2 Python and universal2 wheels for every pin |

The entitlements are what QtWebEngine (Chromium) needs under the hardened runtime: JIT, unsigned
executable memory, library validation off for Qt's plugins, and audio input for the intercom.

## Licences

The bundle carries Qt 6 and PySide6 (LGPL-3.0, dynamically linked — separate libraries inside the .app
that can be replaced), FFmpeg from Qt Multimedia (LGPL-2.1+), and MIT/BSD/Apache Python packages.
**Never PyQt6** (GPL-3.0). The PyInstaller bootloader is GPL-2.0 with the PyInstaller exception, which
permits distributing it with programs under any licence — the same position as the Windows build.

## What CI verifies (`.github/workflows/apple.yml`, macOS runner)

- the whole native test suite, on macOS;
- the player starting headless from source (`QT_QPA_PLATFORM=offscreen`): QML loads, the scene graph
  comes up, the socket starts connecting, no traceback;
- `build.sh` producing the .app and .dmg, `codesign --verify --deep --strict`, the Info.plist keys;
- the **built** .app starting headless the same way, logging to `<state>/player.log`;
- the remote terminal's shell starter inside the frozen app;
- the notices file in the bundle.

## What only a real Mac can confirm

- playback on a real display: Qt Multimedia's FFmpeg backend with VideoToolbox decoding — H.264 is
  expected everywhere, **HEVC** on Apple Silicon and recent Intel; check 4K60 on the model you deploy;
- shader transitions on Metal (the runner has no GPU, so CI runs the software scene graph);
- the LaunchAgent under launchd, the operator exit staying down, automatic login after a power cut;
- `pmset displaysleepnow` actually putting your TV into standby over HDMI;
- the Local Network prompt, the intercom's microphone prompt;
- a Developer ID signature and notarization (no credentials exist in this repository).
