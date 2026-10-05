# Head office (corporate) playlists

Head office makes playlists that stores **can't change**, chooses where they play, and leaves
**local slots** in them that each store fills with its own content, within limits head office sets.
Head office can also run **emergency alerts** that take over screens with triggers turned on.

Everything here is enforced on the server. The dashboard explains what the server will do; it never
decides on its own that something is allowed. The design and every decision behind it is in the
build spec (Revision 2, with the security and regression critiques answered); this page is the
operator's view plus enough of the design to reason about it.

Words used in the product, one per idea:

| Idea | Store sees | Head office sees | Code |
|---|---|---|---|
| The organization's authority | **Head office** | Head office / Corporate | `corporate` |
| A corporate playlist assigned somewhere | "Head office's playlist plays here" | **Where it plays** | mandate |
| The placeholder in it | **Your slot** | **Local slot** | slot |
| What a store puts in a slot | "What plays in your slot" | "Store content" | fill (never shown) |
| A level | "Everyone in {workspace}", "Group {name}", "Video wall {name}", "This screen" | same | `scope_kind` |

## Setting it up

**Settings → Organization → Corporate content** (organization owners and admins only):

1. Choose (or create) the **head office workspace**. Corporate playlists, their media and emergency
   alerts live there. It can't be changed while it holds corporate playlists or emergency alerts, and
   a workspace shared with another server (mesh) can't be chosen.
2. Turn on **Use corporate playlists**.
3. Choose **who can edit corporate playlists**: organization owners and admins, or also the editors of
   the head office workspace. Only owners and admins ever decide **where** a playlist plays, change these
   settings, or run emergency alerts. API tokens never can.
4. Optional: **store triggers on head office's screens** and **emergency alerts** (below).

Turning **Use corporate playlists** off is the kill switch: every store screen goes back to its own
playlist immediately; corporate playlists and where they play are kept for when it is turned on again.

### Workspace per store, or group per store?

A store can be a **workspace** or a **device group** inside one workspace; both work.

- **One workspace per store** keeps stores apart: a store's editors can only see and change their own
  screens and their own slot content. Recommended whenever stores must not touch each other.
- **Groups inside one workspace**: everyone who can edit that workspace can change every group's slot
  content. There is no group-scoped role. Fine for one manager running several sites.

## Head office: the Corporate page

Opening **Corporate** switches the active workspace to head office's. A bar says "You are editing in
Head office" (with one click back) for as long as you work there, because the playlist editor, media
pickers and uploads all work in the active workspace.

Tabs:

- **Playlists**: make a corporate playlist, or make an existing head office playlist corporate. It
  opens in the normal playlist editor with a banner, slot rows and **+ Add local slot**. A corporate
  playlist can contain ordinary nested playlists (smart ones too) and local slots. It can't be smart
  itself, and it can't be nested inside another playlist.
- **Where it plays**: assign a published corporate playlist to the whole organization, a workspace, a
  group, a video wall or one screen, with an optional head office layout (otherwise full screen, and
  stores' layouts pause). "Turn these screens off instead" blanks them. Before saving, the preview says
  how many screens in which workspaces will switch, and how many store schedules, screen-specific
  playlists and layouts pause. The most specific assignment wins: screen = video wall > group >
  workspace > organization. Screens in a video wall are only ever assigned as the whole wall.
- **Store slots**: per slot and workspace, whether the stores filled it, use the fallback, skip it, or are
  over the limit (not playing). Export as CSV. **Corporate airtime** shows how often head office's own
  content played, per workspace and per corporate playlist.
- **Emergency alerts**: below.

**Preview a screen** (on the playlist card, in the editor, and on screen rows of Where it plays) shows
exactly what one screen plays, every item tagged Corporate, Slot "…": {level}, or Fallback, with the loop
length. Authors can preview the draft ("what it plays after I publish").

### Local slots

A slot has a name, a note for stores ("What to tell stores"), limits (most items, most seconds per
loop, videos allowed, widgets allowed) and an optional **fallback** that plays when a store leaves it
empty; with no fallback an empty slot is skipped.

Slot changes apply when head office **publishes**. When you lower a limit, the slot dialog shows the
line *Live: up to 5 items · After you publish: up to 3 · 2 stores have more than that*. After
publishing, those stores' content stops playing (the fallback plays instead) until they remove some, and
their Head office page tells them so.

Only items with a known play length go in a slot: pictures, widgets, slides and videos whose length
the server has measured. Live streams, YouTube and unmeasured videos can't. A video always plays to its
end, so it counts at its full length.

### Approvals in the head office workspace

If the head office workspace requires approval, its reviewers can approve a corporate playlist, but only
a corporate author can publish it. The review queue says "Waiting for an admin to publish".

## Stores: how a store manager fills a slot

Store users see **Head office** in the sidebar when head office plays something on their screens.

1. **Head office** page → *Your slots* → **Fill this slot**. Choose who it is for: **Everyone in
   {workspace}** (the usual choice), a group, a video wall, or one screen. A narrower level starts as a
   copy of what it plays now, so nothing changes on screen until you publish.
2. The slot editor is the normal playlist editor with head office's limits on top: "*2 of 3 items · 40
   of 60 seconds per loop*", head office's note, and **Preview with head office's loop** (your draft
   spliced into what the screen will really play). Items set for other times of day count too: limits
   are per loop.
3. Use **Days & hours** on your items to schedule within the slot. Store schedules can't target a screen
   head office drives (they would never show).
4. **Publish to {n} screens**. Publish is disabled, with the reason, while the slot is over its limit.

From a **screen's own page** (Playlist tab), **Add content** asks first: *Add to "Store promo" for
Everyone in Store 1 (12 screens)?*, with **Only this screen** as the other choice. The item goes into
your slot's draft, never into head office's playlist. The slot section shows where this screen's content
comes from ("From: Group Tills") and offers **Publish** when there are unpublished changes. **Give this
screen its own content** makes a copy just for it. **Use the shared content again** goes back.

## What store managers can still do on a head office screen

| Still yours | Head office's (organization admins only) |
|---|---|
| Restart, volume, brightness (not below 20 %), remote key/touch, screenshot, time zone, orientation | Move to another server, shell / terminal, install apps, launch apps, kiosk unlock, screen off, shutdown, screen timeout |
| Your slot content, its schedule (Days & hours), publishing it | Head office's items, their order, the layout (head office's or full screen) |
| Your own triggers (unless head office limits them, below) | Overlays (PiP), power schedules, block, local control, playlist/layout overrides |
| Delete the screen (recorded in head office's activity) | Changing which group or video wall a screen is in, when that would change what it plays |

Everything locked shows a lock and, on click, says why and what you can change instead. The server
refuses regardless (HTTP 403 with a `CORPORATE_*` code and a sentence written for the person in front
of the screen).

## Store triggers on head office's screens

By default (**Allow as before**) a store's trigger shows over head office's playlist exactly as it shows
over any playlist. **Limit stuck triggers to N minutes** ends a trigger whose sender stopped (a store that
keeps sending can still keep it on). **Don't show store triggers** hides them on head office's screens,
including stores' own evacuation notices, which is why switching to either needs the impact list ticked
"I've checked these". Screens head office doesn't drive are never affected.

> ⚠️ **Under the default, a store CAN cover head office's playlist.** A store editor can create an
> until-cleared trigger, assign it to a head office screen and keep re-sending it from its own LAN sender;
> it then shows full screen over head office's loop for as long as it keeps sending. Only **Don't show
> store triggers** stops that. The default stays "Allow as before" so that turning on corporate playlists
> never silently switches off a store's own safety notices; the "Where it plays" tab says so while it is
> on. **Limit stuck triggers** does not bound a store that keeps sending: a real cap needs a player
> change (a first-fire wall-clock cap for until-cleared triggers), which is a follow-up.

## Emergency alerts

An emergency alert is a trigger owned by head office, with a scope (organization, workspaces, groups,
screens). It shows **only on screens that have triggers turned on**, and only while the organization's
**Emergency alerts** switch is on. It outranks every store trigger on every player.

Two ways to set one off:

- **Activate now** (Corporate → Emergency alerts): every covered screen that is online switches at
  once; offline ones switch when they reconnect while it is on. It always ends on its own (1-60
  minutes) or with **End now**.
- **From an alarm system**: the fire panel or alarm sends the alert's code to each screen on the
  store's network (HTTP or UDP), so it works with the internet down. **Download installer sheet** gives
  each store's installer the screen addresses, ports, secrets and ready-made `curl` / UDP lines. Opening
  it is recorded. **Rotate secrets** makes any secret a store learnt earlier stop working.

Once the switch is on, stores can no longer change trigger settings (listener, ports, secret, clear-all
code) on in-scope screens. A screen whose triggers the store had already turned off stays that way and
is listed under **Who it reaches**, with the reason, like screens that can't receive triggers at all
(Samsung Tizen), have no secret, or haven't connected since the alert changed.

### How to run an emergency drill

1. Corporate → Emergency alerts → your alert → **Who it reaches**. Fix or accept every screen listed.
2. Tell the stores in scope that a drill is coming.
3. **Activate now** for 1-2 minutes. Walk a store: the alert should be on every in-scope screen with
   triggers on.
4. **End now** (or let it expire). Screens go back to what they were playing.
5. For the alarm path, have the store's installer send the code from the installer sheet to one screen
   and clear it the same way. Then check the store's activity log and the Triggers page on that screen
   (diagnostics show what the screen received).

## For integrators (public API)

The `/api/corporate` routes are dashboard-only (no API tokens). Through the public API:

- Playlists carry `corporate`; items carry `slot_id` (a local slot row). Changing a corporate playlist
  with a token answers 403 `CORPORATE_TOKEN`.
- Adding to a screen head office drives (`POST /assignments/device/{id}`) goes into the store's slot
  content and returns `redirected_to` (where it went, how many screens). Pass `slot_id` when there is
  more than one slot, and `fill_scope: "device"` for that screen only.
- Refusals carry `{ error, code, corporate }`. See `docs/openapi.yaml`.

## Rolling back to a version without corporate playlists

An older server version runs on the same database, but it doesn't know about mandates, slots or
emergency alerts. Before downgrading:

1. Remove every row on **Corporate → Where it plays** (or run `DELETE FROM corporate_mandates;` with the
   server stopped). On the older version, deleting a playlist that a mandate names fails with a database
   error, and the head office workspace can't be deleted, until this is done.
2. Remove every local slot from head office's playlists and publish them. The older version publishes a
   slot as an empty 10-second item, which a screen assigned to that playlist directly would play.
3. Don't delete the playlist an emergency alert shows while on the older version: it won't stop you, and the
   alert then has nothing to show. After upgrading again the Emergency tab and the server log say which
   alerts are affected.

When you upgrade again, the server notices anything the older version published: it drops its cached
loops and republishes head office playlists whose published content changed, so every screen plays the current
version (the server log names each one).

## Known limits

- A trigger-path emergency that keeps being re-sent stays on (no player caps an until-cleared trigger by
  wall clock); its lease (5-300 s) ends it once the sender stops. Activate now always ends on its own.
- Tizen screens can't receive triggers, so neither emergency path reaches them.
- A screen that is unpaired and paired again is a new screen: prefer workspace, group or video wall
  assignments over single screens.
- Workspaces shared with another server (mesh) can't take part yet.
- New text is in English; other languages fall back to English until translated.
