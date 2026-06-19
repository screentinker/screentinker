# Room Status sign (calendar-driven Available / Busy)

Turns a ScreenTinker display into a meeting-room sign. It polls an **ICS calendar
feed** and pushes a [PiP](../../docs) web overlay that shows **AVAILABLE** (green) or
**BUSY** (red) plus the current/next meeting time. Re-pushed every poll so the state
stays fresh; cleared when you stop the script.

No dependencies — Node 18+ only.

## How it works

```
ICS feed ──poll──> room.js ──POST /api/pip (type=web)──> player renders room-overlay.html
```

- `room.js` fetches the calendar, parses VEVENTs, and decides busy/free at *now*.
- The overlay is `room-overlay.html` + `room-overlay.js`, served by the signage server
  and rendered by the player in an iframe. The script reads the status from the URL
  query string (the server CSP forbids inline scripts, so the logic lives in the
  external `.js`).

## Get an ICS URL

- **Google Calendar:** Calendar settings → *Integrate calendar* → **Secret address in
  iCal format**. (Treat it like a password.) For a room, use the room/resource calendar.
- **Outlook / Microsoft 365:** Calendar → Share → **Publish**, then copy the **ICS** link.
- Any CalDAV/ICS publisher works. The feed must be reachable by the machine running `room.js`.

## Serve the overlay assets

Copy `room-overlay.html` and `room-overlay.js` into the signage server's web root (the
same directory that serves the SPA), so they're reachable at
`https://<your-server>/room-overlay.html`. They must be **same-origin** with the player
(the overlay runs in an iframe under the server's CSP).

## Configure

```bash
cp config.example.json config.json
# edit config.json: api_base, api_token (st_ token with the 'full' scope),
# overlay_base_url, device_id (a device OR a group id), room_name, ics_url
```

## Run

```bash
npm start            # or: node room.js config.json
```

Stop with Ctrl-C — it clears the overlay on the way out.

### Local quick-start (self-signed dev server)

For a local ScreenTinker instance on `https://localhost:3443` with a self-signed cert:

```json
{
  "room_name": "Aspen Room",
  "api_base": "https://localhost:3443/",
  "api_token": "st_REPLACE_WITH_A_FULL_SCOPE_TOKEN",
  "overlay_base_url": "https://localhost:3443/room-overlay.html",
  "device_id": "DEVICE_OR_GROUP_ID",
  "ics_url": "https://calendar.google.com/calendar/ical/.../basic.ics",
  "poll_interval_sec": 60
}
```

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node room.js config.json
```

(`NODE_TLS_REJECT_UNAUTHORIZED=0` only to accept the dev cert — never in production.)
Remember to copy `room-overlay.html` + `room-overlay.js` into the server's web root first.

## Offline demo / test

`test.js` runs the ICS parser and status logic against `fixture-room.ics` at a fixed
clock — no server, no network:

```bash
npm test
```

You can also drive the overlay against the fixture by setting `ics_file` (instead of
`ics_url`) in `config.json`.

## Config reference

| key | meaning |
| --- | --- |
| `room_name` | label shown on the overlay |
| `api_base` | ScreenTinker server base URL |
| `api_token` | `st_` API token with the **full** scope |
| `overlay_base_url` | URL where `room-overlay.html` is served (same-origin with the player) |
| `device_id` | target device **or** group id |
| `ics_url` | calendar feed URL (or use `ics_file` for a local file) |
| `poll_interval_sec` | refresh cadence (default 120) |
| `colors.available` / `colors.busy` | band colors, 6-hex no `#` |
| `overlay.position` | `center` (default), `top-right`, `top-left`, `bottom-right`, `bottom-left` |
| `overlay.width` / `overlay.height` / `overlay.border_radius` | overlay box geometry |

## Time-zone note

DTSTART/DTEND in UTC (`…Z`) are handled exactly. A *floating* time (no `Z`) is read as
the **local time of the machine running `room.js`**, and `TZID` parameters are not
resolved to their zone. For a single room whose host shares the room's timezone this is
correct; for cross-timezone calendars, publish the feed in UTC.
