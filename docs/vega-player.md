# Vega OS player

Fire TV Stick 4K Select (2025, model `AFTCA002`) and Fire TV Stick HD (2026, model `AFTCL001`) run **Vega OS**. That is not Fire OS and it is not Android. The ScreenTinker APK does not install on them, and sideloading it with Downloader will fail.

`vega/` is the player for those two sticks. It is an installed app that loads the same `/player` page every browser, BrightSign and webOS panel loads, inside Vega's WebView, with the media services turned on so `<video>` is hardware-decoded. Pairing, playlists, zones, widgets, YouTube, HLS, schedules, volume, mute, screenshots and the remote view are the web player's. They are not a second implementation.

## What you get, against the other players

| | Web player | Vega app | Android APK |
|---|---|---|---|
| Playlists, images, video, zones, widgets, YouTube, HLS, bundles, PiP, slide audio | yes | yes (same page) | yes (Kotlin) |
| Schedules, triggers, proof-of-play, pairing | yes | yes | yes |
| Dashboard volume and mute | yes | yes | yes |
| Screenshot and 1 fps remote view | canvas | canvas (same limit: a hardware video plane may not be readable) | view capture, full screen only with accessibility or projection |
| Offline cache | service worker, when it actually controls the page | same. A worker was in control on an AFTCA002; offline playback worked | ContentCache on disk |
| Transitions | shader wipes | shader wipes. On Vega the captured frame's long edge is capped at 960 and the bitmap is dropped after upload, because a full-frame wipe shares CMA with the decoder. An AFTCA002 ran the uncapped wipe and then the process died. The cap has not been re-measured | native compositor |
| Group-sync double buffer | warms the next clip | **does not.** A second decoder is a second CMA claim. That pool is about 236 MB on an AFTCA002 | warms the next clip |
| Boot into the app, stay there | no | installed app. Back does not quit. Vega does not offer Android lock-task, so it is not a kiosk | device-owner kiosk |
| Reboot, screen power, shell, install a package, RTSP | no | **no.** There is no API, and the app does not pretend | yes, with the privileges each one needs |
| Self-update | the server ships the page | the page updates when the server does. The `.vpkg` is installed by you | APK OTA |

Android feature parity is not available on this OS. Content parity with the web player is, minus the second decoder. That concession is in the page, gated on the Vega shell actually being present, so a browser that happens to open `?host=vega` is unchanged. The capture cap is gated the same way.

## Install

The package is not in the Amazon Appstore. Build it on a Mac or Linux machine with the Vega SDK (Windows and WSL are not supported by Amazon's installer):

```bash
curl -fsSL https://sdk-installer.vega.labcollab.net/get_vvm.sh | bash
source ~/vega/env
cd vega
npm install
npm run build:release
npm run install:release    # a stick in developer mode. Discover it with adb connect <ip>:5555 first
npm run launch
```

`build:release` targets **armv7**. Fire TV Stick 4K Select and HD (2026) report `armv7l`. `aarch64` is the simulator. The script calls `react-native build-vega`, which is registered by `@amazon-devices/kepler-cli-platform`. `vega build` by itself does not bundle JavaScript: it exits 0 and archives a package that launches and does nothing.

Stay on React Native 0.72 and Kepler 2 (`@amazon-devices/react-native-kepler` `~2.0.0`). The manifest runtime is `IKeplerScript_2_0`. Kepler 4 / React Native 0.83 is a different runtime; an OS 1.2 stick does not have its system bundles. `@amazon-devices/kepler-file-system` is `~0.0.7` — the `~2.0.0` range matches nothing on npm.

`metro.config.js` does not use Metro's stock Babel transformer. Metro 0.76 transforms an already-parsed AST with `cloneInputAst: false`, and Babel then throws `Helpers are not supported by the default hub` on the shell's `async` and array destructuring. `vega/metro-babel-transformer.js` forces the clone. Do not point the config back at the stock transformer.

`@amazon-devices/*` resolves from the SDK's npm registry, not from the public one. If a version in `package.json` does not resolve, generate a hello-world with `vega project generate` and copy the versions that template pinned. The source does not depend on a patch level.

Developer mode on the stick is under Settings, My Fire TV, Developer Options. The Vega VS Code extension lists the stick once `adb`-equivalent Vega device tools can see it. Test on a stick before trusting a virtual device: the virtual device has more CMA than an AFTCA002, and CMA is what ran out.

### Bake the server address in

Copy `vega/config.json.example` to `vega/assets/config.json` with your URL before building. A stick with nothing typed in uses that. An address entered with the remote is stored in `/data` and wins over the packaged file.

The same file holds the pairing. `deviceId` and `deviceToken` are written there when the page pairs, and `host:ready` hands them back if the WebView's `localStorage` was cleared, so the stick stays the same dashboard row. An unpair, repair mode, or `?reset=` clears that copy too — otherwise the clear would not stick. Changing the server host is a new origin and a new row, which is the same rule as a browser.

## On the stick

1. Launch ScreenTinker.
2. Enter the server URL and choose Save and start. The pairing code is the web player's.
3. Claim it in the dashboard. The display's platform is `vega` and its model is `AFTCA002` or `AFTCL001`.
4. Back on the remote opens the server card. The sign keeps playing behind it. Back does not exit the app.

There is no device-owner mode and no way for this app to set itself as the home launcher. After a reboot someone still has to launch it, unless Amazon later ships a signage launch category. Do not sell these sticks as unattended kiosks.

The shell asks LCM to treat the component as permanent (`LIFESPAN_POLICY.PERMANENT`, and `timeout-secs` in the manifest). On Vega that is the policy the idle handler logs as "Screensaver disabled by policy". It does not stop `power-service-core` from forcing the display off, and there is no privilege that does. W3C Screen Wake Lock is ignored here. A silent video loop would hold a display-keeping session and also a decoder; that is the CMA claim that crashed an AFTCA002, so the shell does not start one. While a playlist video is actually playing, the WebView already holds a `video-playback` session, which the resource manager does treat as display-keeping. Stills are the gap. Settings → Display & Sounds → Ambient Experience is the only control for those, and it has no Never.

## What one stick did

An AFTCA002 (Kepler 1.2, ScreenTinker 2.1.6) paired, reported 1920×1080, and played. Transitions ran and looked right. The process then died in-process (SIGTRAP, not an LCM kill). During playback CmaFree fell from about 236 MB to about 1 MB while MemFree stayed large: the decoder and the GPU surfaces share CMA, and a full-frame wipe uploads into that pool. The capture is now capped (long edge 960) and the bitmap is released after upload. A video wipe still warm-plays the incoming clip, but on Vega the outgoing decoder is paused once its frame is snapshotted, so that window is one decoder rather than two. Group sync still does not preload the next clip ahead of the boundary. The cap has not been run on a stick.

1920×1080 may be the panel or the HDMI link. The 4K Select can output 4K. The HD (2026) has not been run; its product output is 1080p.

The certified-hardware page stays **not supported**. One run that ended in a crash is not a certification, and this entry does not mean a unit is held as a supported sample.
