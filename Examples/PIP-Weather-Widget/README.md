# PiP Weather Widget

A small, always-on **weather widget** that floats in the corner of a ScreenTinker screen.
It polls [Open-Meteo](https://open-meteo.com) (free, **no API key**) for current conditions
plus today's high/low and pushes a compact web overlay via the **PiP API**. On each poll it
re-pushes; the player keeps a single overlay slot (last-show-wins), so the widget updates in
place. It's shown with `duration: 0` (stays until cleared) and clears itself on exit.

```
Open-Meteo  ──poll──▶  weather.js  ──POST /api/pip──▶  ScreenTinker  ──▶  screen overlay
```

## What it shows

Big current temperature, a condition emoji + text, the location, today's H/L, and a footer
with humidity, wind, and the last-updated time. The card tints blue in daytime, dark at night.

## Files

| File | Purpose |
|------|---------|
| `weather.js` | poller + PiP pusher; also exports the pure normaliser for tests |
| `weather-overlay.html` / `weather-overlay.js` | the overlay page rendered in the player's iframe |
| `config.example.json` | copy to `config.json` and fill in |
| `fixture-weather.json` | saved Open-Meteo response used by the offline test |
| `test.js` | offline test of the WMO code map + normaliser (`npm test`) |

## Configure

Copy `config.example.json` to `config.json` and set:

- `api_base` — your ScreenTinker base URL
- `api_token` — an `st_` API token with the **`full`** scope (PiP is fleet-affecting)
- `overlay_base_url` — where `weather-overlay.html` is served (see "Serve the overlay")
- `device_id` — a device **or** group id
- `lat`, `lon`, `location_name` — the place to report
- `units` — `"metric"` (°C, km/h) or `"imperial"` (°F, mph)
- `poll_interval_sec` (default 600), `position` (default `top-right`), `width`/`height`, `border_radius`, `opacity`

## Serve the overlay

A `web` PiP renders `overlay_base_url` in an iframe in the player. Because the server CSP is
`scriptSrc 'self'`, the overlay loads its JS from a same-origin file (`weather-overlay.js`),
so **host the overlay on the same origin as the player**. Copy both files into the signage
server's static frontend directory (the one served at `/`), e.g.:

```bash
cp weather-overlay.html weather-overlay.js /path/to/screentinker/frontend/
# then overlay_base_url = https://<your-server>/weather-overlay.html
```

## Run

```bash
node weather.js                 # uses ./config.json
node weather.js /path/to/config.json
```

Stop with Ctrl-C — it clears the overlay before exiting.

### Offline test

```bash
npm test     # -> RESULT: PASS ✅
```

## Local quick-start (this machine)

A player is already running and paired here:

- `device_id`: `DEVICE_OR_GROUP_ID`
- `api_base`: `https://localhost:3443/`
- `overlay_base_url`: `https://localhost:3443/weather-overlay.html` (copy the two overlay files into the local server's `frontend/` first)
- token: an `st_…` full-scope token

The local server uses a self-signed cert, so prefix the command:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node weather.js ./config.json
```

> Keep `overlay_base_url` on the **same origin** as the player (e.g. both `localhost`),
> or the self-signed cert / CSP will block the iframe.

## Notes

- PiP is **ephemeral** — it isn't persisted, so a screen reboot clears it; the next poll re-shows it.
- Offline devices are reported, not queued.
- Open-Meteo asks for reasonable polling; 600s (10 min) is plenty for a weather widget.
