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
| Offline cache | service worker, when it actually controls the page | same, and only claimed when it does. Not yet seen on a stick | ContentCache on disk |
| Transitions | shader wipes | **hard cut.** These sticks have 1 GB of RAM; a 4K frame grab plus a second decode is how the browser attempt fell over | native compositor |
| Group-sync double buffer | warms the next clip | **does not.** One decoder at a time | warms the next clip |
| Boot into the app, stay there | no | installed app. Back does not quit. Vega does not offer Android lock-task, so it is not a kiosk | device-owner kiosk |
| Reboot, screen power, shell, install a package, RTSP | no | **no.** There is no API, and the app does not pretend | yes, with the privileges each one needs |
| Self-update | the server ships the page | the page updates when the server does. The `.vpkg` is installed by you | APK OTA |

Android feature parity is not available on this OS. Content parity with the web player is, minus the two memory concessions above. Both concessions are in the page, gated on the Vega shell actually being present, so a browser that happens to open `?host=vega` is unchanged.

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

Developer mode on the stick is under Settings, My Fire TV, Developer Options. The Vega VS Code extension lists the stick once `adb`-equivalent Vega device tools can see it. Test on a stick before trusting a virtual device: the virtual device has more RAM than an AFTCA002.

### Bake the server address in

Copy `vega/config.json.example` to `vega/assets/config.json` with your URL before building. A stick with nothing typed in uses that. An address entered with the remote is stored in `/data` and wins over the packaged file.

The same file holds the pairing. `deviceId` and `deviceToken` are written there when the page pairs, and `host:ready` hands them back if the WebView's `localStorage` was cleared, so the stick stays the same dashboard row. An unpair, repair mode, or `?reset=` clears that copy too — otherwise the clear would not stick. Changing the server host is a new origin and a new row, which is the same rule as a browser.

## On the stick

1. Launch ScreenTinker.
2. Enter the server URL and choose Save and start. The pairing code is the web player's.
3. Claim it in the dashboard. The display's platform is `vega` and its model is `AFTCA002` or `AFTCL001`.
4. Back on the remote opens the server card. The sign keeps playing behind it. Back does not exit the app.

There is no device-owner mode and no way for this app to set itself as the home launcher. After a reboot someone still has to launch it, unless Amazon later ships a signage launch category. Do not sell these sticks as unattended kiosks.

## Not verified on hardware

No 4K Select or HD (2026) was on the bench when this landed. The WebView props (`domStorageEnabled`, `mediaPlaybackRequiresUserAction=false`, the media services in `manifest.toml`) are the ones Amazon's WebView guide requires for video to play at all. The old "Vega is limited to 720p" note was a browser observation, not a measurement of this app, and it has not been re-measured. The 4K Select can output 4K; the HD (2026) outputs 1080p. Treat playback resolution as unknown until a stick confirms it.

The certified-hardware page stays **not supported** until that run happens. Shipping the app and calling the sticks certified would be the failure that page exists to prevent.
