# Screen verification

A player can answer every heartbeat while the panel shows a black frame, a picture that stopped an
hour ago, the wrong content, or nothing at all because someone switched the TV off. "Online" only
proves the player is alive. Screen verification checks the screenshots players already send and
keeps a state for every screen that answers a different question: **is it showing what it should?**

| State | Meaning |
|---|---|
| **Verified** | The last checked screenshot looked right. |
| **Blank** | The screen is online but its screenshots are one flat colour (black, white or another solid colour). |
| **Frozen** | The picture has not changed for longer than anything in its playlist lasts, or the player reported moving on to other items while the picture stayed the same. |
| **Unexpected content** | The screenshot does not resemble the image the screen says it is playing. |
| **Panel off** | The player reports that the display panel is off or in standby. Shown as **Panel off (scheduled)** during a display power schedule, which is never treated as a problem. |
| **Unknown** | No verdict: verification is off, the screen is offline, it cannot take screenshots, or it has not been checked recently. |

Each state shows **since when** it has been true.

## Where you see it

- **Advanced dashboard:** a badge under each screen's name (Verified, Blank, Frozen, and so on). Screens
  with no verdict show no badge. Badges update live.
- **Screen page:** a *Screen verification* section with the state, the panel's power and input (when
  the player reports them), when it was last checked, a **Check now** button and the screen's recent
  incidents.
- **Simple view:** a screen that is online but has a problem says so in plain words in place of
  "Playing": *Showing a blank screen*, *The picture seems stuck*, *Not showing what it should*,
  *The screen is switched off*, or *Asleep (scheduled)*.
- **Alerts page:** the workspace's settings and a history of recent screen problems.

## Alerts

A problem must **persist** before it counts. It has to be seen at least twice, across the
workspace's "a problem must last" window (10 minutes by default), before it is *confirmed*. Only a
confirmed problem changes the screen's badge or sends an alert. A single good frame drops an
unconfirmed suspicion without a trace. A confirmed problem needs two good observations in a row to
clear, so one good frame between two bad ones is treated as a flap, not a fix.

While a problem is suspected, the server asks the screen for extra screenshots so it can confirm or
clear it quickly. You do not have to wait for the regular cadence.

Confirmed problems go to the workspace's **alert channels** (Slack, Teams, PagerDuty, Telegram,
webhook, email) that include the new events:

- **"a screen is online but showing a problem"** (`screen_problem`), sent once per incident.
- **"that screen is showing its content again"** (`screen_ok`), sent once, and only to channels
  that received the problem alert. For PagerDuty it resolves the incident with the same dedup key.

New channels include both events by default. Existing channels keep exactly what they had: edit a
channel and tick the two boxes to opt in. The settings panel tells you how many channels currently
receive screen problems.

If a screen goes offline while a problem is open, the problem is closed and the channel is told
"verification paused". Offline alerts take over from there, so nobody is paged twice. A problem that
is open when a scheduled power-off window begins is closed the same way.

Webhook payloads for these events carry `event: "screen_problem" | "screen_ok"` and a `check` field
(`blank`, `frozen`, `unexpected`, `panel_off`). The signature works as it does for every other event.

## Settings (per workspace)

Alerts page → *Screen verification*. Anyone in the workspace can read them. Only a workspace admin,
or an org admin acting as one, can change them.

| Setting | Default | Notes |
|---|---|---|
| On | on | Off stops all checks, requests and alerts for the workspace. |
| Ask each screen for a screenshot | every 30 minutes | 15, 30, 60, 120 or 240 minutes, or **Never**: then only screenshots that are already being taken are checked, for example while someone has the dashboard open. |
| Sensitivity | Normal | *Low* speaks up only when certain. *High* catches more and gets more false alarms. |
| A problem must last | 10 minutes | 2 to 240. |
| Send alerts for | Blank, Frozen, Panel off | *Unexpected content* is shown on badges but does not alert by default, because it is the most conservative and the newest check. |

**Bandwidth.** A verification screenshot is the same capture as the dashboard's (about 960 px wide,
typically 40 to 120 KB). At the default cadence that is about 2 to 6 MB per screen per day. Requests
are spread across the cadence instead of all in one minute, capped at 120 per minute across the
server, skipped while a screen is in its scheduled power-off window, and never sent to a screen that
cannot take screenshots. Frames the dashboard already requests (every 30 seconds while a screen is
visible) are checked at most once every 45 seconds per screen, so live view costs nothing extra.

## Privacy and retention

Verification stores **no images**. Verification screenshots go through the same path as every other
screenshot: only the latest frame per screen is kept, in memory, and it is written to disk once when
the screen goes offline (the "last seen" snapshot). The checks keep only small measurements in
memory: a 64x36 brightness grid and a 64-bit hash for the last few frames. Incidents record
measurements (brightness, spread, a similarity score), never pixels. Incident history is kept for 90
days.

When a visitor is using an interactive web page, players send a deliberate blank "privacy frame"
instead of a screenshot. Verification recognises it and never judges it.

## What each check refuses to judge

Every check leans towards silence. A false page teaches people to mute pages.

**Blank** is not reported when:
- the item is a *hold* item (`hold://blank` is a deliberate black screen);
- the item's own picture is just as flat, for example a black slide on purpose;
- the frame is the 160x90 privacy frame, or the web player's "could not capture this" card, which it
  draws when the video is on a hardware layer the page cannot read.

**Frozen** is not reported for:
- a playlist with a single still item (an image or a widget is meant not to move);
- a still image during its own duration. The picture must stay identical for longer than 1.5 times
  the longest item in the loop plus a minute;
- anything the player shows that is not in the screen's own playlist, such as a trigger, an
  emergency message or an override, because there is no way to know how long it should last;
- hold items, live streams, YouTube and animated GIFs;
- a lone video, unless it has shown one frame for twice its length, and never at Low sensitivity.

It *is* reported, for any item, when the player reports starting two or more different items while
the picture never changed.

Small changes count as movement. Comparisons use the most-changed cell of the grid, not the average,
so a ticking clock or an updated price is enough.

**Unexpected content** is checked **only** for a full-screen image item whose thumbnail (or file) is
on the server's local disk and belongs to the same workspace. Zones, video walls, widgets, video,
live streams, YouTube and content held only in object storage are excluded. It also skips the first
4 seconds of an item and its last 1.5 seconds (transitions), and a frame that still looks like the
*previous* item (the screen is a beat behind). The comparison tries contain, cover and fill fitting,
and portrait rotations. Trying more fittings can only make "unexpected" less likely.

## Panel power and input

The panel state comes from what players already report:

- **Android:** the OS screen-on and screen-off broadcasts (`device:event display_on` / `display_off`).
- **Raspberry Pi, Linux and Windows native player:** the same events when it switches the display
  (DSI backlight, HDMI-CEC, DPMS).
- **Tizen:** page visibility, which also reports as `display_off` when the player is in the background.

A `display_off` from before a reconnect is not believed afterwards. A player that restarts with the
screen on never sends `display_on`.

The protocol also has room for a direct panel report, for players that can ask the panel itself (for
example HDMI-CEC power status or RS-232). It can arrive either in the heartbeat telemetry or in
`device:info`:

```json
"panel": { "power": "on" | "off" | "standby", "input": "HDMI 1", "input_ok": true, "source": "cec" | "rs232" | "ddc" | "os" | "vendor" }
```

Every value is whitelisted or sanitised. **No shipping player sends this yet**, so the screen page
shows *Panel: not reporting* unless OS display events have arrived. No native player code was
changed for this feature.

## API

All routes are JWT only and workspace-scoped (`/api/screen-verification`). Every read also checks
that the screen is still in the workspace, so a screen moved to another workspace takes none of its
history with it.

| Method | Path | Who |
|---|---|---|
| GET | `/settings` | any member |
| PUT | `/settings` | workspace admin, or an org admin acting as one (audited as `screen_verification.settings`) |
| GET | `/states` | any member: every screen's state |
| GET | `/devices/:id` | any member: one screen's state and its last 20 incidents |
| POST | `/devices/:id/check` | editors and admins (not viewers): request a screenshot now, at most once every 20 seconds |
| GET | `/incidents?limit=&open=1` | any member: confirmed incidents, newest first |

The dashboard socket emits `dashboard:verification-state` `{ device_id, state, since, detail }` to the
screen's workspace room when a screen's state changes.

## For operators: how it works

- `server/lib/screen-verify/frame-metrics.js` turns a frame into numbers: brightness mean and spread,
  colour spread, edge density, the dominant colour, a 64x36 brightness grid and a difference hash.
  It runs in the existing image-ops worker thread (`lib/image-ops.js`, op `frameMetrics`), never on
  the event loop. A 960 px capture takes about 40 ms. Frames are JPEG or PNG only, and a PNG whose
  header claims more than 3840x2160 is refused before decoding.
- `server/lib/screen-verify/classify.js` holds every decision as pure functions: blank, same-frame,
  resemblance, freeze, the persistence state machine and settings validation. Tests:
  `test/screen-verify-classify.test.js`, which uses generated frames and real sign images.
- `server/lib/screen-verify/index.js` connects it all: per-screen history in memory, what the screen
  should be showing (from the player's own `play_start` reports and the resolved playlist), the
  minute tick (panel checks, verification requests, alert delivery) and persistence.
  Tests: `test/screen-verify.test.js`.
- The image worker is shared with uploads. Verification backs off when more than 6 jobs are waiting,
  so it is never the reason a thumbnail waits.
- On a scale-out replica, verification does not act on copied workspaces. The primary that owns the
  workspace handles it.

Tables (all additive): `screen_verification_settings`, `screen_verification_state`,
`screen_verification_incidents`, `screen_verification_deliveries`.

## Known limits

- Screens attached through a mesh relay to another node are not asked for verification screenshots
  by this node. Frames that reach this node are still checked.
- "Unexpected content" compares brightness layout, not colour. Two different signs with the same
  layout in different colours would pass.
- Freeze detection depends on the player's `play_start` reports and the resolved playlist. An item
  shown through a path that reports neither is never called frozen, which is the conservative choice.
