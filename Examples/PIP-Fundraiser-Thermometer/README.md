# PiP Fundraiser Thermometer

Pushes a **goal-progress "thermometer"** overlay to a ScreenTinker screen (or group) via
the PiP API. Reads a tiny JSON progress doc, computes the percentage, and shows a filling
bar with the amount raised, the goal, and the percent. It re-pushes on every poll so the
bar updates in place, and clears the overlay when you stop it.

```
progress.json ──poll──▶ thermo.js ──POST /api/pip──▶ ScreenTinker ──▶ screen
{raised,goal}                (web overlay, duration 0 = persistent)
```

Great for lobby displays, telethons, membership drives, "miles walked", etc.

## Data source

A small JSON document, from a local file **or** a URL:

```json
{ "campaign": "Community Garden", "raised": 12450, "goal": 20000, "currency": "USD" }
```

- `source_file` — a path (relative to this dir or absolute). Update the file and the next
  poll picks it up.
- `source_url` — any endpoint returning that JSON (e.g. a Google Sheet published as JSON,
  a CRM webhook target, your own little script). If both are set, `source_url` wins.

Supported currency symbols: USD/CAD/AUD/NZD `$`, EUR `€`, GBP `£`, JPY `¥`, INR `₹`.
Anything else renders as `CODE 1,234`.

## Setup

1. **Host the overlay page.** Copy both overlay files into the ScreenTinker server's
   frontend directory so they're served same-origin (the server's CSP only allows the
   external `<script src>` when it's same-origin):

   ```
   cp thermo-overlay.html thermo-overlay.js  /path/to/screentinker/frontend/
   ```

   They'll be served at `https://<your-server>/thermo-overlay.html`.

2. **Create your config:**

   ```
   cp config.example.json config.json
   ```

   Set `api_base`, `api_token` (an `st_` token with the **`full`** scope), `device_id`
   (a device **or** group id), `overlay_base_url` (the hosted `thermo-overlay.html`), and
   either `source_file` or `source_url`. Optional: `position` (default `bottom-left`),
   `width`/`height`, `poll_interval_sec` (default 60), `currency`.

3. **Run it:**

   ```
   npm start
   # or: node thermo.js config.json
   ```

   Stop with Ctrl-C — it clears the overlay on the way out.

## Local quick-start (this repo's dev server)

The local ScreenTinker dev instance serves on `https://localhost:3443` with a self-signed
cert, so prefix commands with `NODE_TLS_REJECT_UNAUTHORIZED=0`:

```bash
cp thermo-overlay.html thermo-overlay.js  ../../frontend/      # serve same-origin
cp config.example.json config.json
# edit config.json:
#   "api_base": "https://localhost:3443/",
#   "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN",
#   "overlay_base_url": "https://localhost:3443/thermo-overlay.html",
#   "device_id": "DEVICE_OR_GROUP_ID",
#   "source_file": "progress.example.json"
NODE_TLS_REJECT_UNAUTHORIZED=0 node thermo.js config.json
```

Edit `progress.example.json` (bump `raised`) and watch the bar climb on the next poll.
When `raised >= goal` the overlay shows **Goal reached! 🎉**.

## Test

```
npm test
```

Offline unit tests for the money formatter and the progress math
(`62.25%` → label `62%`, clamps over 100%, divide-by-zero-safe goal). Prints `RESULT: PASS`.

## Notes

- PiP overlays are **ephemeral** — a player reboot drops them; the next poll re-pushes.
- `device_id` may be a group id to fan out to every screen in the group.
- Cents are dropped on purpose (whole units read better on a wall display).
