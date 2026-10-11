# Roku player

A ScreenTinker player for Roku devices and Roku TVs. **Status: in development. Not tested on a Roku
yet** — every check so far runs in the BrightScript Simulation Engine (`brs-node`, SceneGraph
extension) and the BrighterScript compiler. Nothing here is published to the Roku Channel Store.

## Why it is shaped like this

Roku apps are BrightScript + SceneGraph only: there is no HTML engine, no web view, and no
JavaScript runtime (Roku: "no plans" to change that). So the web player cannot be reused, and the
player is built from three pieces:

| Content | How the Roku shows it |
|---|---|
| video files (mp4/mov/mkv H.264/HEVC), HLS and DASH live streams | native `Video` node — hardware decode, subtitles, mute, looping |
| images (jpg/png/gif/webp) | native `Poster` node |
| widgets, templates, slides, web pages, HTML bundles, menu boards, everything else | a frame **rendered by the server** (headless Chromium, the same pipeline as the e-paper renderer) and refreshed on the item's own clock |
| multi-zone layouts | native zones, each zone running its own playlist cursor |

The protocol is **the same socket.io protocol every other player speaks**, over Engine.IO's plain
HTTP long-polling transport (the server already accepts it; the Roku has no WebSocket). So the Roku
gets the real `device:playlist-update` payload — schedules, emergency/CAP interrupts, automation,
power schedules, default content, play order — and the real command channel, play events and
heartbeats, with no parallel API to keep in step.

## Layout of `roku/`

```
roku/
  manifest                      channel manifest (title, version, splash, resolution fhd)
  bsconfig.json, bslint.json    BrighterScript compiler + linter settings
  package.json                  dev tooling only (bsc, bslint, brs-node, brs-scenegraph) — not a server dependency
  source/main.brs               entry point: roSGScreen + MainScene, deep-link / ECP launch args
  source/lib/                   pure BrightScript, no SceneGraph — unit-tested in brs-node
    util.brs                    ST_* helpers (strings, URLs, registry, item kinds, colours, clock text)
    engineio.brs                Engine.IO v4 polling + socket.io v5 packet codec
    device.brs                  registration identity, declared capabilities, heartbeat telemetry
    tz.brs                      local wall-clock from the server-supplied offset table
    schedule.brs                per-item schedule evaluation (shared/schedule-vectors.json)
    powerwindow.brs             display power windows (shared/power-window-vectors.json)
    playorder.brs               sequential / shuffle / weighted next-item (tizen/js/play-order.js)
  components/
    MainScene.xml/.brs          setup -> pairing -> playing; socket events, commands, heartbeats,
                                layouts, power windows, the screensaver keep-awake
    tasks/SocketTask.xml/.brs   the Engine.IO session in a Task thread (long-poll GET + one POST at a
                                time, ping/pong, ping and POST timeouts, reconnect with backoff)
    tasks/RasterTask.xml/.brs   fetches server-rendered frames to tmp:/ (Bearer auth, ETag/304,
                                X-ST-Refresh-In)
    player/ZonePlayer.xml/.brs  one zone: cursor, schedule filter, play order, A/B posters with fades,
                                Video, server frames, the native clock, a video watchdog
    ui/PairingView, ui/Overlay  pairing code screen; status / info strip
  images/                       icons + splash (from the ScreenTinker logo)
  fonts/                        Inter Regular/Bold (OFL, the server's own font, as static TTF)
  assets/keepalive.mp4          1-second silent black clip we generate (keeps the screensaver off)
  tests/                        vectors, codec, end-to-end protocol, whole-app and screenshot harnesses
```

## Interfaces between the pieces

All pure-library functions are global BrightScript functions prefixed `ST_`. Times are
**milliseconds since the epoch as LongInteger** (`ST_NowMs()`), never Integer.

### Time zones (`tz.brs`)

Roku has no IANA database for arbitrary zones (`roDateTime` only knows the device's own setting),
and the screen must follow the zone set in the dashboard. The server therefore adds to the playlist
payload, for players that ask for it (capability `clock.tz_table`):

```json
"tz_table": { "zone": "America/Chicago", "generated_ms": 1791723600000,
              "spans": [ { "from_ms": 1791700000000, "offset_min": -300 }, ... ] }
```

`spans` cover at least the previous 24 h and the next 72 h, sorted by `from_ms`; each span lasts
until the next one's `from_ms` (the last one is open-ended). The Roku re-registers every 6 h (and on
every reconnect), so the table never runs out.

- `ST_TzOffsetMin(tzTable as object, utcMs as LongInteger) as integer`
- `ST_LocalParts(tzTable as object, utcMs as LongInteger) as object` →
  `{ year, month, day, hour, minute, second, dow (0=Sun), ymd: "YYYY-MM-DD", hm: "HH:MM", minuteOfDay }`

With no table (older server), the device's own zone is used (`roDateTime.ToLocalTime`).

### Schedules (`schedule.brs`), power windows (`powerwindow.brs`)

- `ST_ItemScheduleActive(item as object, utcMs as LongInteger, tzTable as object) as boolean` —
  `item.schedules[]` (days/start/end/start_date/end_date) and `item.play_from` / `item.play_until`,
  exactly as `shared/schedule-vectors.json` defines them.
- `ST_PowerState(powerSchedule as object, utcMs as LongInteger, tzTable as object) as object` →
  `{ on: boolean, next_edge_ms: LongInteger or invalid }`, as `shared/power-window-vectors.json`.

### Play order (`playorder.brs`)

Port of `tizen/js/play-order.js` (sequential, shuffle bag, weighted; `repeat_every_sec`):

- `ST_PlayOrderNew() as object` → state
- `ST_PlayOrderNext(items as object, fromIndex as integer, allows as object, mode as string, state as object) as integer`
  — `allows` is an array of booleans (already schedule-filtered), returns -1 when nothing is eligible.

### Socket (`engineio.brs` + `SocketTask`)

- `ST_EioDecodePayload(body as string) as object` → array of `{ type: "0".."6", data: string }`
  (packets separated by U+001E).
- `ST_EioEncodePayload(packets as object) as string`
- `ST_SioEncodeEvent(nsp as string, name as string, data as dynamic) as string` → `42/device,["name",{...}]`
- `ST_SioDecode(packetData as string) as object` → `{ type, nsp, name, data }`

`SocketTask` fields: `serverUrl` (string, in), `outbound` (assocarray `{name, data}` — each write is
one emit), `inbound` (assocarray `{name, data, seq}` — observed by MainScene), `state`
(`connecting|open|closed`), `control` (`start|stop`).

## Server changes

### The `roku` family (`server/lib/player-capabilities.js`)

`platformFamily()` returns `roku` for `client_type: 'roku'` **or** `platform: 'roku'` (either signal
is enough; checked before the Android fallback, so an OS string in `android_version` can never make a
Roku an Android panel). Identity is preserved like a Tizen `.wgt`'s: a later register that omits
`client_type`/`platform` keeps the stored values (`lib/liveness.js`). Two capability names were added
to the vocabulary for it:

- `clock.tz_table` — "send me the zone's offset table" (below).
- `render.server_raster` — "I show browser-only items as server-rendered frames"; the door to
  `/api/player/raster`.

`BASELINE.roku` (for a row whose capabilities column is NULL — the player declares on every
register, so a real Roku row normally never reads it): `playback.video`, `playback.image`,
`playback.widget`, `playback.bundle`, `playback.zones`, `playback.transitions`, `audio.mute`,
`system.restart_player`, `clock.tz_table`, `render.server_raster`. Everything else is out, with the
reason in the file. What the player should **declare** at registration (it is the truth, the baseline
is only the floor): the baseline plus `playback.hls` (the Video node plays HLS) and
`display.power_schedule` (it evaluates power windows itself and blanks the screen), and
`display.power` only if it also answers `screen_off`/`screen_on` with that blanking overlay.

What follows from the capability gates, with nothing Roku-specific added: the server refuses
`reboot`/`shutdown`, `set_volume`, `set_brightness`, `shell`, `install_apk`, kiosk, `update` and
screen power for it; the dashboard hides those controls, the Remote/Controls/Terminal tabs and the
screenshot button; `refresh`/`launch` stay (`system.restart_player`). The Roku is in no OTA rollout
family (the store updates it) and is reported as unable to receive LAN triggers
(`lib/corporate/emergency.js`). The device page names it "Roku player" (`device.info.roku_player`,
all 10 languages).

### `tz_table` in the playlist payload

Added by `buildPlaylistPayload` (`server/ws/deviceSocket.js`) **only** when the device supports
`clock.tz_table` **and** the payload has an effective `timezone` (a null zone means "trust your own
clock" on every player, so no table is sent rather than a UTC one). Every other player's payload is
byte-for-byte unchanged. Computed by `server/lib/tz-table.js`:

```json
"tz_table": { "zone": "America/Chicago", "generated_ms": 1793458800000,
              "spans": [ { "from_ms": 1793372400000, "offset_min": -300 },
                         { "from_ms": 1793516400000, "offset_min": -360 } ] }
```

(built at 2026-10-31 15:20Z: the second span is the end of CDT, 2026-11-01 07:00Z.)

- `offset_min` is minutes EAST of UTC (Chicago -300 in summer, Kolkata +330).
- The window runs from the start of the current hour minus 24 h to plus 73 h (so ≥ 72 h past now);
  `generated_ms` is that hour, so payloads rebuilt within one hour carry an identical table.
- Transitions are found to the minute (hourly samples, binary search between disagreeing ones).
- An unknown zone yields a UTC table whose `zone` says `UTC`.

### `tz_tables` — clocks in other zones

When a `clock` widget in the payload names a zone other than the screen's, the payload also carries
`tz_tables: { "<zone>": <table> }` (same shape as `tz_table`; at most 16 zones; unknown zones left
out rather than sent as UTC). With them the Roku ticks a "New York" clock on a Chicago screen itself.

### `GET /api/player/raster` (`server/routes/player-raster.js`)

```
GET /api/player/raster?device_id=<id>&widget_id=<id>          (or &content_id=<id>)
                      [&w=1920&h=1080] [&format=jpeg|png] [&q=85] [&bg=000000] [&rev=<opaque>]
Authorization: Bearer <device_token>
If-None-Match: "<etag from the last 200>"                      (optional)
```

- **Auth**: the device token, exactly as `/api/embedded` (`middleware/deviceTokenAuth.js`); the
  device must support `render.server_raster` (else `403 {error:'capability_required'}`).
- **What may be rendered**: a widget or content item in the device's own workspace, or one its own
  playlist payload references (a head-office mandate's widget, a wall/group playlist, the default
  content). Anything else — another workspace's id or an unknown id — is `404 {error:'not_found'}`.
- **`widget_id`**: any widget type. It is rendered from the widget's own public render page
  (`/api/widgets/:id/render`, what a browser player frames), so templates, alert cards, room signs,
  social walls, menu boards and plugins draw exactly as they do elsewhere.
- **`content_id`**: an HTML bundle (flattened like `/api/content/:id/bundle`) or a remote web page
  (navigated; every request SSRF-vetted). Images, videos, streams and holds are
  `400 {error:'plays_natively'}` — play those natively. Anything else (a PDF, an uploaded document)
  is `415 {error:'unsupported_type'}`.
- **`w`/`h`**: default 1920×1080, clamped to 64..3840. **`format`**: `jpeg` (default; colour,
  quality `q` 40..95, default 85) or `png`. **`rev`**: ignored by the server (cache-busting only;
  not part of the cache key).
- **`bg`**: the zone's colour (6-digit hex, `#` optional, default `000000`), painted under whatever the
  page leaves transparent. ⚠️ Widgets are drawn to overlay a player's own background — a clock is
  white text on a transparent body — and a screenshot of "transparent" is white: the first Roku
  frames were white text on white. Part of the cache key.
- **200**: the image, with `ETag`, `Cache-Control: no-cache`, and **`X-ST-Refresh-In`** = seconds
  until the item's output can next change on its own (clock 60 s buckets, weather 600, RSS/web
  page/social 300, directory board 60, a data-bound slide 60, alert card and room display 60, menu
  board/template/BI/cloud doc 300), or `0` when it changes only on an edit — which arrives as a new
  `widget_rev`/`content_rev` in the payload. Re-ask a couple of seconds after the bucket rolls.
- **304**: `If-None-Match` matched; no render, no disk read.
- **501 `{error:'renderer_unavailable'}`**: no Chromium configured (`CHROME_PATH`) and the frame is
  not already cached. **422 `{error:'blocked_url'}`**: a remote page on a refused address.
  **504**: the 15 s render deadline. **429** (with `Retry-After`): per device, 240 requests/min and
  30 renders (cache misses)/min.
- **Rendering**: the e-ink pipeline's shared browser and 3-page pool (`lib/embedded-render.js`
  `renderPlayerFrame`), with the screen's time zone emulated (a clock reads local time), the browser
  cache off, and a request guard: this server's own origin is readable (GET/HEAD only — a page cannot
  post to the server), everything else goes through `lib/ssrf-guard`.
- **Cache**: a disk LRU sibling of the e-ink cache (`lib/embedded-cache.js` `createCache`,
  `PLAYER_RASTER_CACHE_DIR`, 300 frames / 300 MB), keyed by item, edit revision, time bucket, size,
  format, quality (JPEG only) and the screen's zone. The **device** joins the key only for the two
  widget types whose render depends on the screen (`room-display`, `diag-smoothness`); everything
  else is one render for the whole fleet in a zone, and concurrent identical requests share one
  render.

## Player behaviour worth knowing

- **Clock widgets are drawn natively** (they tick every second) when the clock's zone is known — the
  screen's zone, a `tz_tables` entry, or UTC for a clock with no zone, as `renderClock()` does — and
  the text is English (the clock's `locale`, else the Roku's). Otherwise the clock is a server frame:
  the right time, updated each minute. Format, seconds, date style and position, sizes and colours
  follow the widget's settings.
- **Every other widget is a server frame**, requested at the zone's size with the zone's colour
  (`bg`), refreshed `X-ST-Refresh-In` seconds later while it is on screen; a 304 keeps the frame. If a
  render fails, the last good frame stays up and is retried in 60 s; an item with no frame yet is
  skipped this round.
- **Video**: the largest zone of a layout plays video (a Roku decodes one stream at a time); smaller
  zones show the video's thumbnail for its length. A file video that has not finished by its length
  + 15 s is skipped (a wedged decoder raises no event); a single eligible video loops.
- **Playlist pushes keep playing** when only data changed (the structural signature the web player
  uses); a structural change rebuilds the stage.
- **The socket rebuilds itself** when no ping arrives within `pingInterval + pingTimeout + 5 s`, or a
  POST has not completed in 15 s (re-sending what was in flight, then re-registering).
- **Screensaver**: Roku holds off its screensaver only while a Video node with `disableScreenSaver`
  plays, so while no zone plays video a 2×2 px silent clip loops behind the stage.
- **Power windows and `screen_off`** blank the screen and pause playback; the TV stays on.
- **Debugging**: launch with `debug=1` to log every Engine.IO request; `debug=0` turns it off.

## How it was tested (no Roku yet)

| | |
|---|---|
| `bsc` + bslint | the whole app compiles with zero diagnostics |
| `tests/run-vectors.js` | the shared schedule and power-window vectors, generated time-zone and next-edge cases, play order against `tizen/js/play-order.js` |
| `tests/run-protocol.js --e2e` | the codec, then a real Engine.IO session against the server: register, pair, re-register, playlist, heartbeat ack |
| `tests/run-app.js` | the whole app in brs-node: pairing, a 3-item playlist (image, video, clock), server frames, tz_table, plays reported, `platform_family roku` |
| `tests/screenshot-app.js [--layout]` | the app drawn by the simulator in Chromium: pairing screen, image, video, native clocks, server frames, a two-zone layout |
| `server/test/roku-*.test.js`, `player-raster.test.js`, `tz-table.test.js` | the server side, plus a guard against BrightSign-only or certification-banned calls in `roku/` |

## What a Roku cannot do (and will not pretend to)

- **Start by itself** after power-on or reboot. Roku does not let an app autostart. Workarounds:
  a ScreenTinker device on the same LAN relaunching it over ECP (`POST http://<roku>:8060/launch/<id>`,
  needs *Settings → System → Advanced → Control by mobile apps* to allow it), or the TV left on the
  channel. Roku OS 12+ also needs *Auto power saving* and *Bandwidth saver* switched off by hand.
- **Reboot, change volume, take a screenshot, change the TV input or power.** Not available to apps.
- **Play items that need a browser natively.** They are shown as server-rendered frames: correct
  content, refreshed on a timer, but no animation, no video inside a web page, no touch.
- **Video walls / group sync.** Not implemented.
