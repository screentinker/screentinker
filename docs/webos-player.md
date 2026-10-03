# LG webOS Signage player

The webOS player is the browser player in an installed shell. `webos/` builds an `.ipk` that LG
signage panels install from a USB stick or an SI server; the app launches on boot, asks for the
server address once, then runs `https://<your-instance>/player` in a frame and hands it what a
page cannot do on its own through LG's SCAP library: reboot, screen off and on, and installing
its own updates.

## Install

1. Get `ScreenTinker.ipk` from the release page or from `https://<your-instance>/webos`.
2. Copy it to a USB stick, plug it into the panel, and install it from the panel's settings
   (the menu path varies by webOS version; on most it is under General, Install App). An SI
   server can push the same file to a fleet.
3. Launch ScreenTinker. Enter the server address with the remote and press Save. The pairing
   code appears; claim it in the dashboard.
4. Press Back on the remote at any time to return to the server screen.

Fleets can ship the address in the package instead: a `config.json` next to `appinfo.json`
with `{ "serverUrl": "https://signage.example.com" }` is used when nothing has been typed in.

## Self-update

The app fetches `/webos/version.json` on start and every six hours. When the server publishes a
newer version and the panel has the SCAP library, it downloads `/webos/ScreenTinker.ipk` and asks
the panel to upgrade itself. One attempt is made per published version. Without SCAP the app
stays at its installed version and a new `.ipk` is installed the way the first one was.

## Building

```
cd webos && ./build-ipk.sh
```

LG's `ares-package` is used when it is on `PATH` (`npm i -g @webos-tools/cli`); otherwise the
script assembles the same archive itself, which is what CI does for releases. The build stamps
the app version from `appinfo.json`, which `scripts/bump-version.sh` keeps in step with the
server.

**SCAP is not in the repository.** LG's licence does not allow redistributing the library, so
`webos/vendor/` is empty in the source tree and in the CI-built `.ipk`. Copy the SDK files
listed in `webos/vendor/README.md` into that directory before building to get power and update
controls; the dashboard hides those buttons for a panel whose app reports it cannot do them.

## What the panel has to support

The shell selects a Chrome 53-compatible player build for webOS 4.x, 5.x and 6.x panels, while
webOS Signage 22 and later use the modern player. webOS 3.x browsers are older than that build's
baseline and show a clear compatibility message instead of loading a blank player frame.

## Not verified on hardware

Everything here was built against the SCAP 1.2 method names and the `ares-package` archive
layout, and packaged and unpacked on the build machine. No LG panel was available. The exact
local path `upgradeApplication` installs from, and the install menu path, are the two things
most likely to need adjusting after a first run on a real display.
