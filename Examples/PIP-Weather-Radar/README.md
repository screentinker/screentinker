# PIP-Weather-Radar

A TV-news-style **live weather radar** PiP overlay for ScreenTinker — a dark county map
with **animated precipitation radar** and **live NWS warning polygons** drawn on top
(tornado = red, severe thunderstorm = yellow, flash flood = teal, flood = green), exactly
like a local station's radar.

Its headline trick is **`mode: "on_warning"`**: it watches the National Weather Service
and only **"cuts to radar"** when a qualifying warning actually covers your area — then it
**clears itself** when the warnings expire or drop. (Or run `mode: "always"` to keep the
radar up permanently, e.g. for an ops/EOC wall.)

```
 radar.js (Node)                          radar-overlay.html (player iframe)
 ──────────────                           ─────────────────────────────────
 poll NWS for warnings   ── show/clear ─▶  CARTO dark basemap
 at your point                             + animated RainViewer radar loop
 (mode on_warning)                         + live NWS warning polygons + HUD
```

Everything is **keyless** and has **zero Node dependencies**. Map rendering uses
[Leaflet](https://leafletjs.com/) (MIT), vendored locally.

## Data sources & attribution

The overlay shows attribution on-map; please keep it. Sources:
- **Basemap:** © OpenStreetMap contributors, © CARTO
- **Radar:** [RainViewer](https://www.rainviewer.com/) public weather-maps API
- **Warnings/alerts:** US National Weather Service / NOAA (`api.weather.gov`)

> ⚠️ **Disclaimer:** this is an informational visualization, **not** an official warning
> system. Radar and alert data can be delayed or incomplete. Do not rely on it for
> life-safety decisions — follow official NWS alerts and local emergency guidance.

## Why it works (CSP)

The overlay is served from your signage server, whose CSP is `script-src 'self'` — so the
map library is **vendored** (loaded same-origin), not from a CDN. The same CSP allows
`img-src https:` and `connect-src https:`, so the overlay can pull tiles and `fetch()` the
radar + alert JSON directly (both send `Access-Control-Allow-Origin: *`). No server change
needed.

## Files

| File | Purpose |
|------|---------|
| `radar.js` | Poller/pusher: decides when to show/clear the radar PiP; exports pure helpers |
| `radar-overlay.html` / `radar-overlay.js` | The map overlay (served same-origin, external JS per CSP) |
| `vendor-leaflet.sh` | Downloads `leaflet.js` + `leaflet.css` into this dir |
| `config.example.json` | Copy to `config.json` and fill in |
| `test.js` | Offline unit test (`npm test`) |

## Setup

> **Note:** Leaflet is **not** committed to this repo (it's third-party, BSD-2-licensed).
> The script below downloads it locally — run it once before deploying. Nothing else to install.

1. **Vendor Leaflet** (downloads `leaflet.js` + `leaflet.css` into this dir):
   ```bash
   ./vendor-leaflet.sh
   ```
2. **Copy the overlay + Leaflet into your signage server's frontend dir** (so they're
   served same-origin as the player):
   ```bash
   cp radar-overlay.html radar-overlay.js leaflet.js leaflet.css /path/to/screentinker/frontend/
   ```
3. **Configure:**
   ```bash
   cp config.example.json config.json
   # edit: api_base, api_token (st_ token with 'full' scope), overlay_base_url
   #       (https://<server>/radar-overlay.html), device_id, and your area:
   #       area_label, lat, lon, zoom, states (for the alert query), events
   ```
4. **Run:**
   ```bash
   npm start            # or: node radar.js
   ```

### Local quick-start (self-signed dev server)

```bash
./vendor-leaflet.sh
cp radar-overlay.html radar-overlay.js leaflet.js leaflet.css ../../frontend/
cp config.example.json config.json
# set in config.json:
#   api_base="https://localhost:3443/"
#   api_token="<your st_ full-scope token>"
#   overlay_base_url="https://localhost:3443/radar-overlay.html"
#   device_id="<your device or group id>"
NODE_TLS_REJECT_UNAUTHORIZED=0 node radar.js
```

## Config

| Key | Default | Notes |
|-----|---------|-------|
| `mode` | `"on_warning"` | `"on_warning"` = show only during qualifying warnings; `"always"` = always on |
| `lat`, `lon` | — | Map center **and** the NWS `?point=` used to detect warnings |
| `zoom` | `8` | Leaflet zoom; ~8 ≈ a county/metro |
| `area_label` | — | Shown in the overlay header |
| `states` | `[]` | 2-letter codes used to fetch warning polygons (`?area=ST`). Empty → `?point=` |
| `events` | Tornado/Severe Tstorm/Flash Flood/Flood Warning | Which warnings qualify & are drawn |
| `poll_interval_sec` | `60` | How often `radar.js` checks NWS |
| `position`/`width`/`height`/`border_radius` | center / 1100×720 / 12 | PiP box |
| `noaa_user_agent` | — | NWS asks for a contact in the User-Agent |

> The **overlay** fetches warnings by `states` (so the polygons stay visible across the
> map), while **`radar.js`** decides show/clear from the `?point=` at your `lat`/`lon`.
> Set `lat`/`lon` inside the area you care about and list its `states`.

## Test

```bash
npm test    # RESULT: PASS ✅
```
Covers the warning gate (event/expiry/geometry), the color map, the RainViewer tile-URL
builder, and the overlay-URI round-trip. No network.
