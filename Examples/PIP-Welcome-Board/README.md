# PIP-Welcome-Board

Rotate celebratory cards — **welcomes, birthdays, and work anniversaries** — onto a
ScreenTinker screen (or a whole group) using the PiP overlay API, driven by a simple
local CSV. Great for a lobby, break room, or front-desk display.

- **Birthdays / anniversaries** show only on their day (matched by `MM-DD`).
- **Welcome** rows show every day.
- Cards rotate on a timer; the overlay is cleared when you stop the script.

```
people.csv ──> welcome.js ──poll/rotate──> POST /api/pip ──ws──> player iframe
                                                                  (welcome-overlay.html)
```

## CSV format (`csv_file`)

```csv
type,name,date,note
welcome,Visitors from Acme Corp,,"Thanks for stopping by, room 204"
birthday,Priya Nair,03-14,
anniversary,Dana Olsen,2019-03-14,"Platform team lead"
```

| column | values | notes |
|--------|--------|-------|
| `type` | `welcome` \| `birthday` \| `anniversary` | accent colour is chosen per type |
| `name` | any text | shown large |
| `date` | `MM-DD` or `YYYY-MM-DD` | required for birthday/anniversary; ignored for welcome. A full `YYYY-MM-DD` anniversary shows "<n> Years!" |
| `note` | any text (quote if it contains a comma) | optional small line |

See `people.example.csv`.

## Setup

1. **Host the overlay** on the signage server (same origin as the player, so the
   server's CSP allows the external script). Copy both files into the server's
   `frontend/` directory:
   ```sh
   cp welcome-overlay.html welcome-overlay.js /path/to/screentinker/frontend/
   ```
   They are then served at `https://<your-server>/welcome-overlay.html`.

2. **Configure.** Copy `config.example.json` to `config.json` and fill in:
   - `api_base` — your ScreenTinker server
   - `api_token` — an `st_` API token with the **`full`** scope
   - `overlay_base_url` — the hosted `welcome-overlay.html` URL
   - `device_id` — a device **or** group id
   - `csv_file`, `rotate_interval_sec`, `position`, `width`, `height`, `show_all_when_empty`

3. **Run:**
   ```sh
   npm start          # = node welcome.js
   # Ctrl-C clears the overlay and exits
   ```

## Local quick-start (this machine)

The local player is device `DEVICE_OR_GROUP_ID` on
`https://localhost:3443/` (self-signed cert). A working `config.json`:

```json
{
  "api_base": "https://localhost:3443/",
  "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN",
  "overlay_base_url": "https://localhost:3443/welcome-overlay.html",
  "device_id": "DEVICE_OR_GROUP_ID",
  "csv_file": "people.example.csv",
  "rotate_interval_sec": 12,
  "position": "center"
}
```

Copy the overlay into the local server's `frontend/`, then:

```sh
cp welcome-overlay.html welcome-overlay.js ../../frontend/
NODE_TLS_REJECT_UNAUTHORIZED=0 node welcome.js
```

(`NODE_TLS_REJECT_UNAUTHORIZED=0` is only for the self-signed local cert.)

## Test

```sh
npm test          # offline, deterministic — prints RESULT: PASS ✅
```

Covers CSV parsing (incl. quoted fields with commas), `MM-DD` date matching against a
fixed "today", the welcome/always rule, the `show_all_when_empty` fallback, anniversary
year math, and the overlay-URI round-trip.

## Notes

- The overlay is a single slot on the player (last-show-wins); rotation just re-pushes.
- All card text is rendered with `textContent`, so CSV content is never interpreted as HTML.
- `config.json` and a real `people.csv` are git-ignored.
