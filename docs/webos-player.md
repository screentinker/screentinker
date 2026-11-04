# LG webOS Signage player

The webOS player is the browser player in an installed shell. `webos/` builds an `.ipk` that LG
signage panels install from a USB stick or an SI server; the app launches on boot, asks for the
server address once, then runs `https://<your-instance>/player` in a frame and hands it what a
page cannot do on its own through LG's SCAP library: reboot, screen off and on, and installing
its own updates.

## Install

Two builds of the same app are published, because a panel identifies an app by its id:

- **`com.lg.app.signage.ipk`** (id `com.lg.app.signage`), for panels in **Local** application
  launch mode, the usual way to run one signage app from USB. The panel installs only a package
  with that id and that file name, from the `application/` folder at the root of a FAT32 USB stick.
- **`ScreenTinker.ipk`** (id `com.screentinker.player`), for the panel's app menu. A panel in Local
  mode refuses it, from USB and from an SI server alike.

They are separate apps to the panel. Each updates itself from its own file, so a panel never
switches from one to the other by updating.

### Local application mode (USB)

1. Get `com.lg.app.signage.ipk` from `https://<your-instance>/webos` or the release page. Do not
   rename it.
2. On a FAT32 USB stick, make a folder named `application` at the root and put the file in it.
3. On the panel, open **Server Settings**: set **Application Launch Mode** to **Local** and the
   application type to **IPK**, then run **Local Application Upgrade** from **USB**.
4. Restart the panel when it finishes, enter the server address, and claim the pairing code.

Reported working on real panels by a customer evaluating ScreenTinker (2026-10). An "unknown
error" during the install is most often the panel's clock.

### Local application mode from an SI server

The panel can download the same `com.lg.app.signage.ipk` straight from your instance instead of a
USB stick. In **Server Settings → SI Server Settings**:

1. **Application Launch Mode**: Local. **Application Type**: IPK.
2. **Fully Qualified Domain Name**: On, and the address of the file itself:
   `https://<your-instance>/webos/com.lg.app.signage.ipk`. Use the `https://` address. The plain
   `http://` one answers with a redirect, which a panel's downloader may not follow.
3. **Auto Set**: Off, where the panel has it. **Local Application Upgrade**: Remote, then Confirm.
4. Restart the panel when it finishes.

⚠️ **Not `ScreenTinker.ipk`.** In Local mode the panel upgrades its one Local app, id
`com.lg.app.signage`, from that address, and refuses a package with any other id with "failed to
upgrade IPK". Earlier versions of the `/webos` page pointed SI servers at `ScreenTinker.ipk`.

### App menu

1. Get `ScreenTinker.ipk` from the release page or from `https://<your-instance>/webos`.
2. Copy it to a USB stick, plug it into the panel, and install it from the panel's settings
   (the menu path varies by webOS version; on most it is under General, Install App).
3. Launch ScreenTinker. Enter the server address with the remote and press Save. The pairing
   code appears; claim it in the dashboard.
4. Press Back on the remote at any time to return to the server screen.

Fleets can ship the address in the package instead: a `config.json` next to `appinfo.json`
with `{ "serverUrl": "https://signage.example.com" }` is used when nothing has been typed in.

## Self-update

The app fetches `/webos/version.json` on start and every six hours. When the server publishes a
newer version and the panel has the SCAP library, it downloads the file it was installed as
(`/webos/ScreenTinker.ipk` or `/webos/com.lg.app.signage.ipk`; `files` in `version.json` says which
the server has, and `versions` what version each one is) and asks the panel to upgrade itself. One
attempt is made per published version. Without SCAP the app stays at its installed version and a
new `.ipk` is installed the way the first one was.

The version in `version.json` is read out of the `.ipk` file the server serves, never assumed from
the server's own version. The server looks in its data directory, then the checkout root, then
`webos/`, and serves the newest file of the right app id it finds; an older copy left in the data
directory no longer wins (it used to, and was then published under the server's version, so panels
downloaded a package older than the one they ran). A file carrying the other build's id - say
`ScreenTinker.ipk` copied to `com.lg.app.signage.ipk` - is ignored with a warning in the server
log, because a panel in Local mode refuses it.

## Building

```
cd webos && ./build-ipk.sh                                # ScreenTinker.ipk
cd webos && ./build-ipk.sh --app-id com.lg.app.signage    # com.lg.app.signage.ipk
```

`--app-id` changes only the packaged copy of `appinfo.json`, and stamps the file name into the
shell so the build updates itself from the right file.

Releases are packaged with LG's own `ares-package` (`npm i -g @webos-tools/cli`, pinned in the
release workflow), without minifying, so the `.ipk` is the archive LG's tooling writes. On a
machine without the tool the script assembles the same archive itself, in the same shape. Either
way the script unpacks and checks the result - app id and version in the control record,
`appinfo.json` and `packageinfo.json`, the `usr/palm/...` layout, the stamps in `js/app.js` - and
fails instead of writing a package that would not install. The build stamps the app version from
`appinfo.json`, which `scripts/bump-version.sh` keeps in step with the server.

## When an install fails

Work through these in order; each one has produced "failed to install" or "failed to upgrade IPK"
on a real panel.

1. **Which build, which mode.** A panel in **Local** application launch mode installs only
   `com.lg.app.signage.ipk` (id `com.lg.app.signage`), from USB and from an SI server alike, and
   refuses `ScreenTinker.ipk`. `ScreenTinker.ipk` is for the panel's app menu only.
2. **Check what the server is serving.** Open `https://<your-instance>/webos/version.json` in a
   browser. `files` must list the file you are installing as `true`, and `versions` must show the
   version you expect for it. If it is older than the server, the server has an old copy in its
   data directory; delete it (or replace it with the release file) and restart.
3. **Check the file itself.** Download it on a computer and run `ares-package -i <file>`
   (from `@webos-tools/cli`), or `ar t <file>` - it must list `debian-binary`, `control.tar.gz`,
   `data.tar.gz`, in that order. A file that is HTML (a login page, an error page) or a few hundred
   bytes is not a package: the panel downloaded the wrong thing.
4. **SI server address.** Fully Qualified Domain Name **On**, and the address is the full `https://`
   path to the file, not the `/webos` page and not the plain `http://` address (which redirects).
   Local Application Upgrade: **Remote**, then Confirm, then restart the panel.
5. **Clock.** A panel with the wrong date fails TLS and reports an unknown error. Set the time
   automatically under General, Time & Date, and retry.
6. **A panel that will not take a remote download at all** (older firmware and a current TLS
   chain, a proxy, a captive network): install from USB. Put the file, unrenamed, in an
   `application/` folder at the root of a FAT32 stick, Local Application Upgrade: **USB**, Confirm,
   restart. The app then updates itself from the server once it is running, SCAP permitting.
7. **The same version again.** Re-offering the version a panel already runs can report a failure on
   some firmware. Install a newer build, or remove the app first.

If none of that explains it, the panel's model and webOS version (General, System Information) and
the exact error text are what to send with a report.

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
