# PiP QR Rotator

Rotate **scannable QR codes** through a corner of your ScreenTinker screens via the PiP
API — Guest Wi-Fi, the lunch menu, a feedback survey, a "scan to download" link, the event
schedule, a checkout/tip link… anything a phone camera should grab.

The QR codes are generated **client-side, in the overlay itself** — no QR web service, no
image hosting, no external libraries, no network calls. That keeps it fast, private, and
compliant with the player's Content-Security-Policy (`script-src 'self'`).

```
qr.js  --(POST /api/pip, type:web)-->  player
            uri = qr-overlay.html?data=<payload>&label=<caption>
                                                  |
   qr-overlay.js encodes <payload> into a QR matrix and paints it on a <canvas>
   every rotate_interval_sec, qr.js pushes the next entry (player = last-show-wins)
```

## Files

| File | Purpose |
|------|---------|
| `qr.js` | Rotates through `config.entries`, pushing each as a PiP overlay. `--clear` removes it. |
| `qr-overlay.html` / `qr-overlay.js` | The overlay page the player loads in an iframe. **Generates the QR client-side.** Must be served by your ScreenTinker host (same-origin with the player). |
| `config.example.json` | Copy to `config.json` and fill in. |
| `test.js` | Offline unit test (`npm test`) — pure helpers + the QR encoder's Reed-Solomon core. |

## Setup

1. **Mint a token.** In the dashboard create an API token with the **`full`** scope (PiP
   is fleet-affecting and renders web content, so it requires `full`).

2. **Serve the overlay assets.** Copy `qr-overlay.html` and `qr-overlay.js` into the
   directory your ScreenTinker server serves at the web root (its `frontend/` dir), so they
   live at `https://<your-host>/qr-overlay.html`. They **must** be same-origin with the
   player — the server applies a CSP that only allows same-origin scripts, which is exactly
   why the QR is drawn by `qr-overlay.js` (no CDN).

3. **Configure.** `cp config.example.json config.json` and set `api_base`, `api_token`,
   `overlay_base_url` (the URL from step 2), `device_id` (a device **or** a group id), and
   your `entries`.

4. **Run.** `node qr.js` — it pushes the first code immediately, then rotates every
   `rotate_interval_sec`. `Ctrl-C` clears the overlay.

## Configuration

| Key | Meaning |
|-----|---------|
| `entries` | Array of `{ label, data }`. `data` is the QR payload (required); `label` is the caption shown under it. |
| `rotate_interval_sec` | Seconds between entries (default `15`). A single entry just stays up. |
| `position` | `top-left`, `top-right`, `bottom-left`, `bottom-right` (default), or `center`. |
| `width` / `height` | Overlay box px (default `360` × `420` — tall so the caption fits under the code). |
| `border_radius`, `opacity` | Optional overlay styling. |

### QR payload cookbook

| Use | `data` value |
|-----|--------------|
| Open a link | `https://example.com/menu` |
| **Join Wi-Fi** (auto-connect) | `WIFI:T:WPA;S:<ssid>;P:<password>;;` — for an open network use `WIFI:T:nopass;S:<ssid>;;` |
| Pre-filled email | `mailto:hi@example.com?subject=Feedback` |
| Phone number | `tel:+15551234567` |
| Plain text | any text |

> Wi-Fi note: special characters in the SSID/password (`\ ; , : "`) must be backslash-escaped
> per the Wi-Fi QR spec, e.g. `P:p\;w\:d`.

## Local quick-start (this repo)

The local ScreenTinker instance serves on `https://localhost:3443/` (self-signed) and the
registered player is device `DEVICE_OR_GROUP_ID`.

```bash
# from the repo root: serve the overlay assets same-origin with the player
cp Examples/PIP-QR-Rotator/qr-overlay.html Examples/PIP-QR-Rotator/qr-overlay.js frontend/

# then in this dir:
cp config.example.json config.json
# edit config.json:
#   "api_base": "https://localhost:3443/"
#   "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN"
#   "overlay_base_url": "https://localhost:3443/qr-overlay.html"
#   "device_id": "DEVICE_OR_GROUP_ID"

# self-signed cert -> let Node accept it for this run
NODE_TLS_REJECT_UNAUTHORIZED=0 node qr.js
```

## Testing

```bash
npm test
```

Runs offline (no network, no player): validates the rotation/URL helpers and verifies the
embedded QR encoder's Reed-Solomon math against the published QR generator polynomials, plus
structural checks (finder/timing patterns, version sizing). For the real proof, point it at
a screen and **scan it with your phone**.

## Notes & limits

- The encoder is a compact **byte-mode** implementation of the QR spec (ISO/IEC 18004),
  based on Nayuki's reference algorithm (MIT). Byte mode handles any UTF-8 payload; it
  auto-selects the smallest version and the best mask, and boosts the error-correction level
  for free when there's spare capacity (more robust scanning).
- Keep payloads reasonably short for at-a-distance scanning — long URLs make a denser code.
  Use a link shortener for long destinations.
- Like all PiP overlays, this is **ephemeral**: a player reboot drops it (re-run to restore),
  and the script clears it on `Ctrl-C`.
