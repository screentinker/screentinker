# Layouts on playlists, layout versions, and campaigns

A **layout** splits a screen into zones (a menu on the left, a promo on the right, a ticker along
the bottom). Until 3.0 a layout belonged to a **screen** only: a group of twenty screens playing a
zoned playlist needed the layout set on each of the twenty by hand, and a new screen joining the
group played the zoned items squeezed into whatever layout it happened to have.

3.0 adds three things:

1. **A layout on a playlist.** Pick it once, on the playlist; every screen that plays the playlist
   draws it.
2. **Portrait and 4:3 versions of a layout.** The same zones, arranged for a different screen
   shape, so one playlist layout works on landscape and portrait screens in the same group.
3. **Campaigns** — playlists whose items can be whole layouts (part 3 below).

---

## 1. A layout on a playlist

### For everyone

Open a playlist. Under its name there is a **Layout** row:

- **Each screen's own layout** (the default) — nothing changes: each screen uses the layout set on
  the screen, exactly as before.
- **Any layout** (yours or a built-in template) — every screen playing this playlist uses it,
  whether the playlist reached the screen through the screen itself, a group, or a schedule.

When a playlist has a layout, every item row gets a **Zone** picker. **Main zone** means "no zone of
its own": the item plays in the layout's main zone. Items added from anywhere that does not ask
for a zone — the Simple view's "Show on screen", **Make a sign**, approved content requests, an
experiment's variants, the API — all land in the main zone automatically, unless the playlist has a
**default zone** (below).

Changing a layout is a **draft** like any other playlist edit: screens keep what they have until
you **Publish**, and then get the new layout and the moved items together. **Discard changes**
puts the old layout back too.

#### Changing to a different layout

If the playlist's items already sit in zones of another layout, ScreenTinker shows where it
suggests each group of items goes:

1. a zone with the **same name** ("Ticker" → "ticker"),
2. otherwise the zone covering **the same part of the screen** best,
3. otherwise the **main zone**.

Change any row, then **Change layout**. Nothing moves until you confirm. Choosing **Each screen's
own layout** again keeps every item's zone as it is.

#### The main zone

In the layout editor, select a zone and tick **Main zone**. If no zone is ticked, the **largest**
zone is the main zone (the first of equal ones) — the same rule every player already used for an
item whose zone it could not find, so old and new players agree.

#### A playlist's default zone

The main zone belongs to the layout, so every playlist using that layout shares it. To send one
playlist's **new** items somewhere else, pick a **Default zone** under its **Layout** (for a layout
with two or more zones).

- It only affects items added **after** you set it, from anywhere that doesn't pick a zone: the
  editor, the Manager app, the API, the Simple view, **Make a sign**, approved content requests,
  agency uploads, a synced cloud folder, a group's Add content. The zone is saved on each item as
  it's added.
- **Existing content never moves.** Items already in the playlist keep playing where they do, and
  changing the default zone later moves nothing that was added before. To move old items, use each
  item's **Zone** picker.
- It's a setting, not a draft: there's nothing to publish until you add something.
- Copying, duplicating, pasting, restoring a revision and importing keep each item's own zone.
- Changing the layout carries it along when the confirmed zone map moves its zone. Otherwise it's
  cleared, as it is when you choose **Each screen's own layout**. If the zone is later deleted from
  the layout, new items get no zone (the main zone) again.

### Which layout does a screen draw? (precedence)

Decided in one place on the server (the `device_resolved_playlist` view), highest first:

| # | Source | Notes |
|---|--------|-------|
| 1 | **Head office mandate** | Its own layout, or full screen. A store's playlist layout never shrinks head office's content. |
| 2 | **An active schedule's layout** | Only when the schedule itself names a layout. |
| 3 | **The playlist's layout** | The *published* layout of the playlist the screen resolved to (screen, group or schedule). |
| 4 | **The screen's own layout** | Unchanged from 2.x. |
| — | Full screen | When none of the above applies. |

Special cases:

- **Nested playlists:** only the TOP-LEVEL playlist's layout counts. A playlist used inside another
  playlist has its own layout ignored there; its items follow the parent item's zone, or the
  parent's main zone.
- **Video walls** keep their wall layout (**Walls → Layout**). A wall member never takes a playlist
  layout: the wall is the canvas.
- **Emergency alerts, CAP feeds and automation overrides** play full screen, as before.
- A schedule that names no layout plays its playlist's own layout (if it has one), else the
  screen's.

The screen's page (**Displays → a screen**) says which layout is on screen and who chose it
("chosen by this screen's playlist"), and **What will this screen show?** names the tier too. The
zone picker on the screen's page offers the zones of the layout actually on screen.

### For admins

- Head office playlists take their layout from the mandate, not the playlist (refused with
  `CORPORATE_LAYOUT`); content for a head office slot plays inside head office's layout
  (`FILL_LAYOUT`).
- A layout from another workspace can never be chosen (403); a zone map can only point into the new
  layout (400). Built-in templates are allowed everywhere.
- Deleting a layout clears it from every playlist that chose it (they go back to "each screen's own
  layout") and pushes the affected screens.
- Export/import carries the playlist's layout when the layout is in the same export (or is a
  built-in template).
- Version history and approvals include the playlist's layout: a layout change needs approval like
  any other playlist change when approvals are on.
- Activity log: `playlist.layout_changed`.

### API

| Call | What it does |
|---|---|
| `PUT /api/playlists/:id` `{ layout_id }` | Choose a layout (`null` = each screen's own). Draft until publish. |
| `PUT /api/playlists/:id` `{ layout_id, zone_map: { oldZoneId: newZoneId } }` | Choose and move items in one transaction. |
| `GET /api/playlists/:id/layout-zone-map?layout_id=` | The zones in use, item counts, and a suggested target for each. Read-only. |
| `PUT /api/playlists/:id` `{ default_zone_id }` | The zone new items added without one are given (`null` = none, the main zone). `400` for a zone outside the playlist's layout, or with no layout (`code: DEFAULT_ZONE_NO_LAYOUT`). Changes no existing item. |
| `POST /api/playlists/:id/items` (and `/items/bulk`) | With no `zone_id`, the new item is saved with the playlist's default zone. |
| `GET /api/playlists/:id` | `layout` is the chosen layout with `explicit: true`, `main_zone_id` and `default_zone_id`, else #104's derived one. |
| `PUT /api/layouts/:id` | Zones may carry `is_main: 1`. |

Database: `playlists.layout_id` (draft) and `playlists.published_layout_id` (on screens), both
`REFERENCES layouts ON DELETE SET NULL`; `layout_zones.is_main`; `playlists.default_zone_id` (no FK: a
zone that's no longer in the layout is ignored). All NULL/0 = exactly the 2.x
behaviour — the test suite proves every existing screen's payload is byte-identical
(`test/playlist-layout.test.js`).

---

## 2. Portrait and 4:3 versions of a layout

Zones are percentages, so a layout already fits any **resolution**. What it cannot survive is a
different **shape**: three side-by-side columns drawn on a portrait screen become slivers.

A layout can now have a **portrait version** and a **4:3 version**: the **same zones** (same ids,
so every item bound to a zone plays in that zone in every version), each with its own position and
size.

### For everyone

In the layout editor there is a **Landscape | Portrait | 4:3** switch.

- Switch to **Portrait** and press **Create portrait version**: ScreenTinker arranges the zones for
  you as a starting point — side-by-side zones are stacked top to bottom in the same order, and a
  full-width banner (a ticker, a header) stays full width at the same end of the screen, with the
  same height in pixels. Adjust it, then **Save**.
- **Remove this version** goes back to "portrait screens use the landscape zones".
- The canvas previews at 9:16 (portrait) or 4:3.

### Which version a screen gets

Decided when the playlist is sent to the screen, from the screen's real shape:

- the **orientation** set on the screen (a portrait setting turns a landscape panel), and
- the **resolution the player reported** (a natively portrait panel; a 4:3 or 5:4 monitor).

| Screen shape (width ÷ height) | Version |
|---|---|
| below 0.8 (9:16, 3:4) | portrait |
| 0.8 – 1.45 (1:1, 5:4, 4:3) | 4:3 |
| wider (16:10, 16:9, ultrawide) | landscape (the default) |

A screen whose version the layout does not have gets the landscape zones — exactly what it got
before (byte-for-byte). Players need no update: they still just receive zone rectangles.

Versions apply wherever a layout reaches a screen: the screen's own layout, a schedule's layout,
a playlist's layout and a campaign's layout items. **What will this screen show?** builds the same
payload and shows the same version; the playlist preview's **Portrait** toggle shows the portrait
version. Video walls are not affected (a wall is its own canvas).

### For admins / API

- Stored in `layout_zone_variants (zone_id, layout_id, variant, x/y/width/height_percent)`,
  `variant` ∈ `portrait`, `square` (= the 4:3 version). A side table rather than columns on
  `layout_zones`, because every payload is built with `SELECT * FROM layout_zones`: new columns
  would add fields to every zoned screen's payload, rows in a side table change nothing for a layout
  without versions.
- `GET /api/layouts/:id`: each zone has `variants: { portrait: {...}, square: {...} }` when set.
  `GET /api/layouts`: each layout lists `variants: ['portrait']`.
- `PUT /api/layouts/:id`: send `variants` on a zone to set them; `{ portrait: null }` removes one;
  a zone without `variants` keeps its versions (an older editor never erases them). Versions are
  only ever written for that layout's own zones.
- `POST /api/layouts/auto-variant` `{ variant, zones, width, height }` returns the starting
  arrangement (pure arithmetic, nothing stored).
- In the payload a version adds `layout.variant` and swaps `layout.width`/`height` to the version's
  canvas; zone ids, order and every other field are unchanged.

---

## 3. Campaigns: whole layouts as playlist items

A **campaign** is a playlist whose items can be **whole layouts**. For example:

> the lunch menu board (menu on the left, today's special on the right) for 30 s →
> a full-screen promo video → the "events" layout (two zones) for 20 s → back to the start.

Any playlist becomes a campaign as soon as it holds a layout item; take the layout items out and it
is an ordinary playlist again.

### For everyone

In a playlist (Advanced view), press **Add layout**:

1. **Layout** — any of your layouts or a built-in template.
2. **Show the layout for** — how long it stays on screen (seconds).
3. **What each zone plays**, one choice per zone:
   - **a playlist** — the zone plays that playlist on a loop (it must be a plain list: no nested
     playlists or layouts inside it), or
   - **Items placed in this zone** — add content to this campaign as usual, then in that item's
     row choose *Layout › Zone* under **Where this item plays**. Those items belong to the layout
     and are not steps of their own.

Everything else in the playlist is a **full-screen step**. Steps play in order and loop. A layout
item can have dayparts, a play window and a data condition like any item (outside them it is
skipped). Change what the zones play with the **Zones** button on the layout row. Like every
playlist change, nothing reaches screens until you **Publish**.

**Preview** plays the campaign exactly as a screen would, layout switches included, and
**What will this screen show?** lists the steps (layouts and items) and which of them play at that
moment; its timeline names the steps of each period.

At the top of a campaign the editor says which screens play it — and, in amber, **which screens
will play the simplified version** (below) and why.

### The simplified version (fallback) — exactly

Players that cannot switch layouts yet get a plain playlist built from the campaign, so they never
see anything they cannot play:

- a **full-screen item** plays as it is;
- a **layout item** becomes **the items of its main zone, played full screen**, each for its own
  duration (the zone ticked **Main zone** in the layout editor, else the largest one; if that zone
  is empty, the largest zone that has content; if every zone is empty, nothing). Each copied item
  takes the layout item's play window (intersected with its own) and the layout item's dayparts and
  data condition when it has none of its own;
- a layout item whose layout has been **deleted** is skipped (deleting a layout removes its layout
  items and republishes the campaigns that used it; content that was placed in the deleted layout's
  zones plays full screen as ordinary items).

Video walls and synced groups always play the simplified version (they run one shared clock),
and so do head office mandates, emergency alerts, CAP feeds and automation overrides, which never
contain layout items anyway.

### Player support

| Player | Campaigns | Notes |
|---|---|---|
| Web player (browser, Chromium kiosk, desktop) | **Yes** | Each step fades in over the last (400 ms); the next step's images and videos are preloaded while the current one plays. A full-screen video plays to its end. Offline: the last campaign is cached and resumes on a cold start. |
| Android (native app) | **Yes** | Steps drawn through the zone engine with a short fade; every campaign item is downloaded with the playlist, so the next layout is on disk before the switch. A full-screen step lasts its item's duration. |
| Web player inside the BrightSign, webOS, Vega and iOS shells | Not yet — simplified version | Overlapping video stages are unverified on those hosts. |
| Samsung Tizen | Not yet — simplified version | |
| BrightSign (native autorun) | Not yet — simplified version | |
| Roku | Not yet — simplified version | |
| Pi / Windows / macOS native player | Not yet — simplified version | |
| E-ink (embedded renderer) | Not yet — simplified version | |

A player tells the server it can play campaigns by declaring the capability `layout.campaign`.

### Proof of play

- Every time a layout step starts, a play is recorded **for the layout** (Reports show it under the
  layout's name; `play_logs.trigger_type = 'layout'`, `play_logs.layout_id`).
- Items in a layout's zones are recorded as zone items always are, and carry the layout they played
  in (`play_logs.layout_id`). Full-screen steps are recorded like any item.
- Plays recorded while a screen is offline are replayed without the layout attribution.

### For admins / developers

**Data model (additive)**

| Where | What |
|---|---|
| `playlist_items.layout_ref_id` | The item is a layout (`REFERENCES layouts ON DELETE CASCADE`). Its `duration_sec`, dayparts, play window, data condition and log-play setting apply to the whole layout. |
| `playlist_item_zone_sources (item_id, zone_id, playlist_id)` | Zone *Z* of that layout item plays playlist *P*. No row = the zone plays this playlist's rows whose `zone_id` is *Z*. A table rather than JSON so that publishing *P* republishes every campaign showing it, deleting *P* is refused while one does, and a zone removed from the layout takes its row with it. |
| `playlists.published_campaign` | The published structure (JSON `{ v, steps }`), written on Publish next to `published_snapshot` (which holds the simplified version). NULL for every playlist without a layout item. |
| `play_logs.layout_id` | Which layout a play happened in. |

**Payload.** `assignments` is always the simplified version. A player that declares
`layout.campaign` additionally receives:

```json
"campaign": { "v": 1, "steps": [
  { "type": "layout", "layout_id": "…", "duration_sec": 30,
    "layout": { "id": "…", "name": "Lunch board", "width": 1920, "height": 1080, "zones": [ … ] },
    "zones": { "<zone id>": [ <items, each with zone_id> ] },
    "schedules": [ … ], "play_from": "…", "play_until": "…", "play_when": { … } },
  { "type": "item", "item": { …an ordinary assignment… } }
] }
```

The layout in a step is the screen's orientation version (part 2). Zone items go through the same
pipeline as playlist items (revision refresh, unsupported-media strip, weather/area conditions,
file URLs, data-source values). Empty zones are left out; a step whose layout no longer exists is
left out. Players that do not declare the capability receive byte-for-byte what they did before
(no `campaign` field at all), and a capable player gets no `campaign` field for an ordinary
playlist. Play events: `play_start` may carry `layout_id` and `zone_id`; a new `layout_start`
event (`layout_id`) records the layout itself — the server only attributes a play to a layout of the
screen's own workspace (or a template).

**API**

| Call | What it does |
|---|---|
| `POST /api/playlists/:id/items` `{ layout_ref_id, duration_sec, zone_sources: { zoneId: playlistId \| null } }` | Add a layout item. |
| `PUT /api/playlists/:id/items/:itemId` `{ zone_sources }` | Change what its zones play. |
| `GET /api/playlists/:id` | Layout items carry `layout`, `zone_sources`, `zone_source_names`; a campaign carries `campaign_screens: [{ id, name, full }]` (`full: false` = simplified version). |
| `GET /api/playlists/:id/preview-payload` | Includes `campaign` (the preview player plays it). |

**Refused (with a code):** a layout item in a playlist that has its own layout (`CAMPAIGN_HAS_LAYOUT`)
and the reverse; in a head office playlist or slot content (`CORPORATE_CAMPAIGN`); in a playlist
that itself plays in another campaign's zone (`CAMPAIGN_IN_ZONE`); a zone playlist from another
workspace (403), the campaign itself, a head office playlist, or one holding nested playlists or
layouts (400); a zone that is not in the item's layout (400); an experiment on a layout item.
Copy/paste of rows skips layout items; bulk duplicate refuses them (the row's own Duplicate keeps
the layout and its zones). Export/import does not carry layout items yet (the zone-bound items
import as ordinary items). Version history, approvals and Discard include layout items and their
zone sources. Activity log: `playlist.layout_item_added`.
