# ScreenTinker for Vega OS

Installed player for the two Fire TV sticks that are not Android:

| Stick | Model | Output |
|---|---|---|
| Fire TV Stick 4K Select (2025) | `AFTCA002` | up to 4K |
| Fire TV Stick HD (2026) | `AFTCL001` | 1080p |

Both have 1 GB of RAM and run Vega OS. The Android APK does not install.

The app loads `/player?host=vega` from your server. Content features are the web player's. See [docs/vega-player.md](../docs/vega-player.md) for the parity table, the build steps, and what is deliberately not claimed (reboot, kiosk, RTSP, a second video decoder, shader transitions).

```bash
source ~/vega/env
cd vega && npm install && npm run build:release && npm run install:release && npm run launch
```
