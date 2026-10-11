# ScreenTinker for Roku

The ScreenTinker display player for Roku streaming devices and Roku TVs. Design, limits and the
server side are in [docs/roku-player.md](../docs/roku-player.md).

> **Status:** in development. Everything here has been compiled with BrighterScript, linted, unit-
> and vector-tested, and run end to end against a real ScreenTinker server **in the BrightScript
> Simulation Engine** — not yet on a Roku. Not published to the Roku Channel Store.

## What it plays

| | |
|---|---|
| Video files, HLS/DASH streams | natively (subtitles, mute, loop) |
| Images | natively, with fades |
| Widgets, templates, slides, web pages, HTML bundles | as frames rendered by your server, refreshed when their content can change |
| Layouts | native zones; the largest zone plays video, smaller zones show the video's thumbnail |
| Schedules, play order, default content, emergency/CAP, power windows, proof of play | as every other player |

## Tooling (Node 22)

```bash
cd roku
npm ci                                      # BrighterScript, bslint, brs-node (dev only)
npx bsc --project bsconfig.json             # compile + lint
node tests/run-vectors.js                   # schedule / power-window / play-order vectors
node tests/run-protocol.js --e2e            # Engine.IO codec + a real session against server/
node tests/run-app.js --seconds 90          # the whole app in the simulator against server/
```

`run-protocol.js --e2e` and `run-app.js` start this checkout's server with a throwaway data
directory; install the server's dependencies first (`npm ci --prefix ../server`). Set `SERVER_DIR`
to test against another checkout (for example a released version).

## Trying it on a Roku (developer mode)

1. On the Roku remote: **Home ×3, Up ×2, Right, Left, Right, Left, Right**. Enable the installer and
   set a password — this reboots the Roku.
2. Build the package: `npx bsc --project bsconfig.json --createPackage --outFile ../.roku-build/screentinker-roku.zip`
3. Open `http://<roku-ip>` in a browser, sign in as `rokudev` with that password, and upload the zip.
4. On first run the player asks for your server address (★ changes it later); then it shows a
   pairing code — add it under **Displays → Add display**.

A server address can also be passed at launch, which is how an installer or a LAN helper sets a
fleet up without typing on a remote:

```bash
curl -d '' "http://<roku-ip>:8060/launch/dev?server=https://signage.example.com"
```

## Settings an operator must change on the TV (Roku OS 12+)

Roku does not let an app keep itself running. For a signage screen:

- **Settings → System → Power → Auto power savings:** turn off *Reduce power after 15 minutes* and
  *Turn off after 4 hours*.
- **Settings → Network → Bandwidth saver:** off (it exits apps after 4 hours of no input).
- **Settings → System → Advanced system settings → Control by mobile apps:** *Enabled*, if a device on
  the network should relaunch the player after a power cut.

## Remote

| Key | |
|---|---|
| ★ (options) | change the server |
| OK / info | show or hide the status strip |
| Back, twice within 3 s | exit |
