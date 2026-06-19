# PiP Announce / Broadcast

Flash a one-off text announcement onto a ScreenTinker screen (or a whole group) using
the **PiP overlay API**, then clear it whenever you like. Good for fire drills, "back in
5 minutes", shift changes, a quick "Welcome, visitors!", or any manual broadcast.

It pushes a `web` overlay that renders a small dark card (optional coloured title band +
big message + a "posted" timestamp). The overlay page reads everything from its URL query
string, so there's no server-side state — the message lives entirely in the pushed URL.

## How it works

```
announce.js ──POST /api/pip──▶ server ──WS device:pip-show──▶ player
                                                              renders <iframe
                                                              src=message-overlay.html?title&message&color>
```

- `announce.js` builds an overlay URL from `overlay_base_url` + `?title&message&color` and
  POSTs it to `/api/pip` (`type: "web"`).
- The player loads that URL in an iframe overlay. Because the player enforces a strict CSP
  (`script-src 'self'`), the overlay HTML loads its JS via `<script src="message-overlay.js">`
  (no inline scripts) and the JS reads the query string.
- `duration` controls auto-dismiss: `0` (default) keeps it up until you clear it; any
  positive value (seconds) auto-clears on the player at that time.

## Setup

You need an `st_` API token with the **`full`** scope (PiP is fleet-affecting).

```bash
cp config.example.json config.json
# edit config.json: api_base, api_token, overlay_base_url, device_id
```

The overlay page is served by the signage server as a **same-origin** static file. Copy the
two overlay files into the server's frontend directory and point `overlay_base_url` at them:

```bash
# from the repo root, into the served frontend dir:
cp Examples/PIP-Announce-Broadcast/message-overlay.html frontend/
cp Examples/PIP-Announce-Broadcast/message-overlay.js   frontend/
# then in config.json:  "overlay_base_url": "https://<your-server>/message-overlay.html"
```

Same-origin matters: the player iframe and the overlay must share the server's origin so
the self-signed cert / CSP are honoured.

## Usage

```bash
# basic broadcast (stays until cleared)
node announce.js "Fire drill at 2:00 PM"

# with a coloured title band, auto-clear after 60s, centered
node announce.js "Back in 5 minutes" --title "AT LUNCH" --duration 60 --color "#E8730C" --position center

# target a specific device or a group (overrides config device_id)
node announce.js "All-hands in the atrium" --group <GROUP_ID>

# clear it
node announce.js --clear --device <DEVICE_ID> --pip <PIP_ID>
# (omit --pip to clear whatever overlay is showing)
```

Flags: `--title`, `--device`, `--group`, `--duration` (sec), `--color` (#RRGGBB),
`--position` (`top-right|top-left|bottom-right|bottom-left|center`), `--config`, `--clear`, `--pip`.

## Local quick-start (this dev box)

A web player is already running and paired:

- `api_base`: `https://localhost:3443/`  (self-signed — prefix commands with `NODE_TLS_REJECT_UNAUTHORIZED=0`)
- `device_id`: `DEVICE_OR_GROUP_ID`
- token: `st_REPLACE_WITH_A_FULL_SCOPE_TOKEN`

```bash
cp Examples/PIP-Announce-Broadcast/message-overlay.html frontend/
cp Examples/PIP-Announce-Broadcast/message-overlay.js   frontend/
cd Examples/PIP-Announce-Broadcast
# config.json with the values above and overlay_base_url=https://localhost:3443/message-overlay.html
NODE_TLS_REJECT_UNAUTHORIZED=0 node announce.js "Hello from PiP" --title TEST --duration 20
```

## Test

```bash
npm test   # offline; exercises the URL builder and arg parser
```
