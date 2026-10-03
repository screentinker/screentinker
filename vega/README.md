# ScreenTinker for Vega OS

Installed player for the two Fire TV sticks that are not Android:

| Stick | Model | Output |
|---|---|---|
| Fire TV Stick 4K Select (2025) | `AFTCA002` | up to 4K |
| Fire TV Stick HD (2026) | `AFTCL001` | 1080p |

Both have 1 GB of RAM and run Vega OS. The limit that mattered on an AFTCA002 was CMA (about 236 MB), not that RAM figure. The Android APK does not install.

The app loads `/player?host=vega` from your server. Content features are the web player's. See [docs/vega-player.md](../docs/vega-player.md) for the parity table, the build steps, and what is deliberately not claimed (reboot, kiosk, RTSP, a panel wake lock, a second video decoder). The shell does ask Vega to suppress the screensaver; that is not the same as keeping the panel powered.

```bash
source ~/vega/env
cd vega && npm install && npm run build:release && npm run install:release && npm run launch
```

`build:release` is `react-native build-vega --target armv7`. These sticks are armv7, not aarch64 — aarch64 is the simulator on an Apple Silicon host. Do not run `vega build` on its own. That packages native artifacts only and will emit a `.vpkg` with no JavaScript. The `build-vega` command comes from `@amazon-devices/kepler-cli-platform`; `react-native-kepler` does not register it.

Stay on React Native 0.72 and `@amazon-devices/react-native-kepler` 2.x. The stick's runtime is KeplerScript 2 (`loader_2`). A 0.83 / kepler 4 package looks for system bundles that OS does not have. `@amazon-devices/kepler-file-system` is `~0.0.7`. There is no 2.x.
