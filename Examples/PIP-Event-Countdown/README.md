# PiP Event Countdown

Push a **live, self-clearing countdown overlay** to a ScreenTinker screen (or group) with
the PiP API. The overlay ticks down `DD : HH : MM : SS` in real time and — the fun part —
**removes itself the instant the target time arrives**. There is no clearing poll: the
script sets the PiP `duration` to "seconds until the target", so the player drops the
overlay at exactly zero and shows a quick 🎉 first.

Great for: New Year's Eve, product launches, store opening / closing, shift changes,
webinar "starts in…", conference session timers, "back in 15 minutes".

## How it works

```
countdown.js  --(POST /api/pip, type:web, duration = seconds-to-target)-->  player
                                                                              |
   overlay_base_url/countdown-overlay.html?target=<ms>&title=<text>          |
                                                                              v
   countdown-overlay.js ticks the clock every second; at zero shows 🎉 <title>
   ...and the player auto-removes the PiP at the same moment (duration elapsed)
```

`countdown.js` is a **one-shot** push — it doesn't stay running. Re-run it to change the
target or title; the player keeps last-show-wins, so the new overlay replaces the old.

## Files

| File | Purpose |
|------|---------|
| `countdown.js` | Computes seconds-to-target and pushes one PiP. `--clear` removes it early. |
| `countdown-overlay.html` / `countdown-overlay.js` | The overlay page the player loads in an iframe. Must be served by your ScreenTinker host (same-origin with the player). |
| `config.example.json` | Copy to `config.json` and fill in. |
| `test.js` | Offline unit test of the date math (`npm test`). |

## Setup

1. **Mint a token.** In the dashboard create an API token with the **`full`** scope
   (PiP is fleet-affecting and can render arbitrary web content, so it requires `full`).

2. **Serve the overlay assets.** Copy `countdown-overlay.html` and `countdown-overlay.js`
   into the directory your ScreenTinker server serves at the web root (the same place
   `index.html` is served from — the `frontend/` dir in this repo). They must be reachable
   at `overlay_base_url`, and **same-origin** with the player so the server's CSP
   (`script-src 'self'`) allows `countdown-overlay.js`. (Inline scripts are blocked by the
   CSP — that's why the JS is a separate file.)

3. **Configure.**
   ```bash
   cp config.example.json config.json
   # edit config.json: api_base, api_token, overlay_base_url, device_id, target, title
   ```

4. **Run.**
   ```bash
   node countdown.js
   # or override target/title on the CLI:
   node countdown.js "2026-07-04T21:00:00-05:00" "Fireworks!"
   # clear it early:
   node countdown.js --clear
   ```

## config.json

| Key | Meaning |
|-----|---------|
| `api_base` | Base URL of your ScreenTinker server, e.g. `https://signage.example.com`. |
| `api_token` | A `full`-scope `st_…` token. |
| `overlay_base_url` | Public URL of `countdown-overlay.html` (served by your host). |
| `device_id` | A device **or** group id to show on. |
| `target` | Target datetime, any `Date.parse`-able string (ISO 8601 recommended, include a TZ offset). |
| `title` | Heading shown above the clock, and the 🎉 message at zero. |
| `position` | `center` (default), `top-right`, `top-left`, `bottom-right`, `bottom-left`. |

## Local quick-start (this repo's dev instance)

The dev server runs at `https://localhost:3443/` with a self-signed cert, so disable TLS
verification for the run. Copy the overlay assets into the served `frontend/` dir first so
`https://localhost:3443/countdown-overlay.html` resolves.

```bash
cp config.example.json config.json
# config.json:
#   "api_base":         "https://localhost:3443/"
#   "api_token":        "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN"
#   "overlay_base_url": "https://localhost:3443/countdown-overlay.html"
#   "device_id":        "DEVICE_OR_GROUP_ID"
#   "target":           a time ~2 minutes out, e.g. "2026-06-18T19:42:00-05:00"
#   "title":            "Demo"

NODE_TLS_REJECT_UNAUTHORIZED=0 node countdown.js
```

Watch the screen count down and disappear on its own at zero. (`config.json` is
git-ignored so your token never gets committed.)

## Notes & limits

- The PiP `duration` caps at **24h (86400s)**. For a target more than a day out the
  overlay still shows, but it can't auto-clear at zero — re-run within 24h of the target
  for the self-clear effect. The script warns you when the target is beyond the cap.
- PiP is **ephemeral**: it isn't part of the device's saved layout, so a player reboot
  clears it. Re-run `countdown.js` after a reboot if needed.
- Offline devices are reported, not queued — show it while the screen is online.
