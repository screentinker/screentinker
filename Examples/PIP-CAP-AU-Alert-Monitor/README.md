# CAP-AU → ScreenTinker PiP alert monitor (example)

Watches a CAP-AU emergency feed (default: the **NSW RFS `majorIncidentsCAP`** feed) and,
when a qualifying alert covers a screen's location, pushes a **PiP web overlay** to that
screen — then clears it when the alert expires, is cancelled, or leaves the feed.

It uses the **existing** ScreenTinker PiP API (`POST /api/pip`, `POST /api/pip/clear`).
No server changes required.

## How it works

```
CAP-AU feed ──poll──▶ parse (EDXL unwrap) ──▶ gate (AlertLevel + geofence) ──▶ POST /api/pip
                                                                              ◀─ clear on expiry/cancel/gone
```

Three non-obvious things this example gets right, learned from the real feed:

1. **It's EDXL-DE wrapped.** The feed is not a flat list of CAP alerts — each `<alert>`
   is embedded under `EDXLDistribution > contentObject > xmlContent > embeddedXMLContent`.
   `cap-parse.js` unwraps that.
2. **Gate on `AlertLevel`, not CAP `<severity>`.** RFS leaves `<severity>`/`<urgency>`
   as `Unknown` for routine incidents. The real urgency lives in a `<parameter>` named
   `AlertLevel` (`Planned Burn` / `Advice` / `Watch and Act` / `Emergency Warning`).
   Default threshold shows only `Watch and Act` and `Emergency Warning`, so routine
   hazard-reduction burns never hit a screen.
3. **CAP coordinates are `lat,lon`** — the reverse of GeoJSON's `lon,lat`. The geofence
   keeps that flip in one place; feeding raw CAP coords into a `lon,lat` library is the
   classic "matches on the wrong side of the planet" bug.

## Setup

```bash
npm install
cp config.example.json config.json   # then edit it
```

In `config.json`:

- `api_base` — your ScreenTinker server URL.
- `api_token` — an **`st_` API token with the `full` scope** (PiP is fleet-affecting and
  full-trust, so the route requires it). Create one in the dashboard's API-token section.
- `overlay_base_url` — where `alert-overlay.html` is hosted, **reachable by the player**
  (the player fetches the overlay URL directly). Drop the file on the ScreenTinker host
  or any static host.
- `screens` — each screen's `lat`/`lon` (its physical location, used for the geofence)
  and the `device_id` (a device **or** group id) to push the overlay to.
- `alert_levels` — the AlertLevel threshold (default `["Watch and Act","Emergency Warning"]`).

## Run

```bash
npm start            # uses ./config.json
# or
node monitor.js /path/to/config.json
```

On `Ctrl-C` it clears any overlays it put up, so a screen never keeps a stale alert.

## Test the parser (no server needed)

```bash
npm test
```

Runs the EDXL/gate/geofence logic against `fixture-feed.xml` (two real RFS planned burns
plus a synthetic Emergency Warning and a distant Watch-and-Act) and asserts that only the
in-area Emergency Warning would fire.

## Files

| File | Purpose |
|---|---|
| `monitor.js` | Poll loop + PiP show/clear lifecycle (dedup by CAP identifier). |
| `cap-parse.js` | EDXL unwrap, AlertLevel/field extraction, polygon+circle geofence, gate. |
| `alert-overlay.html` | The web overlay the PiP points at; renders from `?level=&headline=&area=…`. |
| `config.example.json` | Copy to `config.json` and fill in. |
| `fixture-feed.xml` / `test-parse.js` | Offline test of the parser/gate. |

## Notes / next steps

- **Targeting model:** one screen → one `device_id` here. For many screens you'd likely
  drive `screens` from your device inventory (each device's stored location) rather than
  hand-listing them.
- **`msgType` Update:** currently an Update re-shows only if the identifier changed; if RFS
  reuses an identifier on update you may want to force a re-push (clear + show) to refresh
  the overlay content.
- **Other states/agencies:** point `feed_url` at other CAP-AU sources (state SES/fire
  services). Field names in `<parameter>` are RFS-specific; other agencies differ, so the
  `AlertLevel` mapping may need adjusting per source.
- This is an example/reference, not a life-safety system. Don't make it the only way people
  are warned.
