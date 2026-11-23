# Switch to ScreenTinker: importing from another signage CMS

ScreenTinker can bring over your media, playlists, layouts, schedules and screens from another digital
signage system, so switching takes an afternoon instead of a month.

**Where to find it**

- **The first-run guide.** Every new account is asked, right after the welcome, *Coming from another
  signage app?*
  - **No, start fresh** is the guide's Next button, so nothing changes for anyone who says no.
  - Choosing an app runs the import one question at a time inside the guide: connect or upload, what
    was found, import with progress, done. The guide then carries on to pairing the first screen.
    On its last step, the imported playlists are offered for that screen.
  - Every step has **Skip the import**. Leaving never loses the rest of the guide.
  - An import that is running keeps going on the server if you move on, or if your phone puts the
    Manager app in the background. Coming back to the step, or to `#/migrate`, shows its progress.
- **Simple view.** While a workspace has no screens yet, the home page and Help offer **Import from
  another app** (`#/simple/import`, the same guide-style wizard). Established workspaces do not see it.
- **Content → Add content → From another signage system** and **Settings → Switch to ScreenTinker**,
  for existing workspaces in Advanced view.
- Directly at `#/migrate`

Workspace owners, admins and editors can import. View-only members cannot.

## How it works

1. **Pick your current system.**
2. **Connect.** Paste an API key (and, for a self-hosted system, its address), or upload a zip.
3. **Scan.** ScreenTinker reads what is there and shows:
   - how many media files, playlists, layouts, schedules and screens it found;
   - everything it *cannot* bring over, and why.
4. **Choose** what to import, and where the media goes:
   - a new folder called *Imported from <system>*;
   - one of your folders;
   - the library root.

   You also choose whether to publish the imported playlists. If the workspace requires review,
   they wait for review instead of being published.
5. **Import.** The import runs in the background with a progress bar. You can leave the page; come back
   to `#/migrate` to see where it is.
6. **Report.** The report shows:
   - what was created;
   - what was already there and was reused;
   - what failed and why;
   - every change made on the way, such as "every 2 weeks became every week".
7. **Pair your screens.** Each screen from the old system appears under **Screens to pair**. To pair one:
   1. Install the ScreenTinker player on the screen.
   2. Press **Pair** and type the code the screen shows.

   The screen gets the old name, joins its old groups, and plays what it played before. ScreenTinker
   never claims a screen by itself.

### Running it again is safe

ScreenTinker remembers, per workspace, which source item became which ScreenTinker item. So:

- Running the same import again creates **no duplicates**. Existing items are reused, and edits you
  made since are kept.
- If you deleted an imported item, running the import again recreates it.
- An import that stopped can be **resumed**. It might have stopped because:
  - the storage allowance ran out;
  - the server restarted;
  - the vendor kept rate-limiting.

  Resuming carries on where it stopped.

### Storage

Imported media counts against your storage like an upload:

- Every file is checked against the server's per-file limit and your remaining allowance.
- When the allowance runs out, the import **stops** rather than failing file after file. Everything
  imported so far stays.
- Free up space or raise the limit, then press **Resume**.

### What happens to your key

- The API key or password is used only for the import.
- It is kept in memory and, so that a resume works, encrypted on the server (AES-256-GCM, the same
  `secretbox` that protects other integration secrets) for **at most 3 hours**.
- It is deleted as soon as the import finishes, fails or is cancelled, or when that time runs out,
  whichever comes first.
- It is never shown again, never logged, and never written into the report.
- A key with **read** access is enough.

Uploaded export files are deleted the same way, at most 24 hours after upload.

## Per system

| System | How | Media | Playlists | Layouts / zones | Schedules | Screens |
|---|---|---|---|---|---|---|
| Xibo | API (client credentials) | yes | yes | yes | yes, mostly | yes, with groups |
| Yodeck | API token | partly (see below) | yes | yes | yes | yes, tags as groups |
| ScreenCloud | API token (GraphQL) | yes | yes | yes, channels | no (see below) | yes, with groups and tags |
| Screenly | API token | yes | yes | Screenly has none | simple rules | yes, labels as groups |
| Anthias | the device's API | yes | its one loop | Anthias has none | no | the device |
| OptiSigns | not possible, use the zip | — | — | — | — | — |
| Samsung MagicINFO | not yet, use the zip (screens stay) | — | — | — | — | — |
| Anything else | zip of media + CSV | yes | yes | — | — | yes (screens.csv) |

Web pages, apps, tickers, clocks and other widgets are never imported: the same thing in another CMS
is built differently. Each one is listed in the scan so you can add the matching ScreenTinker widget.

### Xibo (self-hosted or Xibo Cloud)

**Connect**

1. In Xibo, open **Administration → Applications → Add Application**.
2. Tick **Client Credentials**.
3. Copy the **Client ID** and **Client Secret**.
4. Enter your CMS address, i.e. the one you sign in at.
5. Optionally, enter the CMS's time zone. It is used for events whose display has no time zone of its own.

**Imported**

- **Library images, videos and audio**, downloaded through the API.
- **Library playlists**, in widget order with their durations. A dynamic playlist arrives as a fixed
  list of its current items.
- **Published layouts.** Each region becomes a zone, with pixel positions converted to percentages,
  and each region's items fill its zone. In ScreenTinker this is a layout plus a playlist named
  *<layout> (layout)* holding the zone items.
- **Display groups** become groups.
- **Displays** become placeholders, with their groups and default layout.
- **Schedule events for a layout** (or a campaign that is one layout) become schedules:
  - Times are converted from Xibo's timestamps into the display's time zone.
  - Daily, weekly (with weekdays) and monthly (by day of month) repeats are kept, with their end date.
  - "Always" events run from 2000 to 2099.
  - Priority events get priority 10.

**Not imported**

- Fonts, modules, HTML packages and PDFs from the library.
- Overlay, command, interrupt and action events.
- Campaigns of several layouts. These are listed; schedule the layouts by hand.
- Geo-fencing.
- Layout background images.
- Repeats every N minutes or hours, yearly repeats, and "the 2nd Tuesday of the month". These are
  listed with the reason.

**The address**

The Xibo address is yours, so the server checks it like any address a person types (see *For
administrators*):

- On a hosted ScreenTinker it must be a public address.
- A metadata address such as `169.254.169.254` is always refused.

**Docs used**

- https://docs.xibosignage.com/developer/integrate/authentication
- https://docs.xibosignage.com/developer/integrate/openapi
- https://raw.githubusercontent.com/xibosignage/xibo-cms/develop/web/swagger.json (v4.5)

### Yodeck

**Connect**

1. In Yodeck, open **Account Settings → Advanced Settings → API Tokens**.
2. Generate a token. This needs the Premium or Enterprise plan.
3. Paste it as `label:token`, where the label is the name you gave it.
4. Optionally, enter a time zone. It is used for screens that have none.

**Imported**

- **Media.** Yodeck's API does not offer your original uploaded files. ScreenTinker imports:
  - media Yodeck imported from a web address, from that address;
  - videos as the version Yodeck plays (Yodeck's transcode).

  Uploaded images, audio and documents are **listed, not imported**. ScreenTinker never substitutes a
  thumbnail for an original. Download those files from Yodeck and add them with the zip import.
- **Playlists**, in priority order with durations. Random playback becomes in-order (said in the report).
- **Layouts**: regions become zones, and a region showing a playlist or media item is filled with it.
- **Schedules**:
  - Every event of a schedule that a screen shows is imported, aimed at that screen.
  - Event duration is in minutes.
  - Repeats are daily, weekly with weekdays, or monthly.
  - A repeat limited to N occurrences runs until its end date instead (said in the report).
  - "Screen off" events are not imported: use a power schedule.
- **Screens** become placeholders. Their tags become groups, and their playlist or layout becomes what
  the placeholder plays.

Yodeck's API is rate-limited (21 requests per 10 seconds per token). ScreenTinker waits when told to
and carries on.

**Docs used**

- https://app.yodeck.com/api-docs/ (OpenAPI: `/api-docs/bundle.yaml`)
- https://www.yodeck.com/academy/api-token/

### ScreenCloud

**Connect**

1. In ScreenCloud Studio, open **Account Settings → Developer**.
2. Create a token with read permissions.
3. Choose the region shown there, **EU** or **US**.

**Imported**

- **Files** (images, video, audio), from the original's address.
- **Published playlists**, with durations. ScreenCloud stores them in milliseconds; a 0 duration means
  the default.
- **Channels** become layouts:
  - zone positions are read from the layout's CSS (`vw`, `vh`, `%`, `px`);
  - each zone's files and playlists fill it.
- **Screen groups and screen tags** become groups.
- **Screens** become placeholders, with their channel as their layout.

**Not imported**

- **Schedules.** ScreenCloud has no schedule object: time rules live on individual items inside a
  channel. Those items are imported without their rules, and each such channel is listed. Use a
  ScreenTinker schedule or playlist-item dayparting instead.

**Docs used**

- https://screencloud.github.io/signage-next-graphql-docs/ (playlist-content, channel-content and
  custom-layout-config references)
- https://developer.screencloud.com/

### Screenly (cloud)

**Connect**

1. In Screenly, open **Settings → Security → Tokens**.
2. Add a token.

**Imported**

- **Image, video and audio assets.**
- **Playlists**, in position order.
- **Labels** become groups. A screen's own label, the one named after it, targets that screen.
- **Screens** become placeholders.
- **Playlist rules** (predicates) become schedules for each label the playlist is on. ScreenTinker
  understands:
  - `$WEEKDAY IN {…}`
  - `$TIME BETWEEN {…}`
  - `$DATE` bounds joined with AND

  A rule using OR, or any other form, is listed and not guessed.

**Docs used**

- https://developer.screenly.io/api_v4_1/
- https://www.screenly.io/docs/developers/overview/api-tokens/
- https://www.screenly.io/docs/scheduling/advanced/predicates/

### Anthias (Screenly OSE)

**Connect**

Enter the device's address, for example `http://192.168.1.20`. If you turned on authentication,
also enter the username and password; they are sent to that device only.

The device is normally on your local network. On a self-hosted ScreenTinker, an administrator must
allow that address first (see *For administrators*).

**Imported**

- **Image, video and audio files** stored on the device.
- **The device's loop**, as one playlist in play order.
- **The device** as one screen placeholder, named after its player name.

**Not imported**

- **Per-asset date, weekday and time windows.** They are listed: set them as playlist-item dayparting.
- **Web pages and streamed URLs.**
- **The backup archive** (`.tar.gz`). It contains a SQLite database, and reading an uploaded database
  is more risk than this import is worth; the API covers the same data.

**Docs used**

https://github.com/Screenly/Anthias. The API is documented in its source (`api/urls/v2.py`,
`api/serializers/v2.py`) and on each device at `/api/docs/`.

### OptiSigns: not possible through its API

OptiSigns has a GraphQL API (Pro Plus plan and above), but it documents **no way to download your
files**:

- there is no download query or mutation;
- its storage fields are not documented as usable addresses.

ScreenTinker does not rely on undocumented behaviour. Without the files, playlists and schedules would
arrive empty.

**Instead:** download your files from OptiSigns and use the zip import below, with one folder per
playlist or a `playlists.csv`.

**Docs read**

- https://docs.optisigns.com/quickstart
- https://docs.optisigns.com/generate-api-key
- https://api-doc.optisigns.com

### Samsung MagicINFO: not yet through its API, and your screens stay

Samsung is retiring MagicINFO: **On-Premise End of Sale is 31 December 2026** (End of Support
31 December 2029) and **MagicINFO Cloud End of Service is 28 February 2027**. Samsung's successor
is VXT.

The MagicINFO Server REST API (`/MagicInfo/restapi/v2.0/`, a token from `POST /auth`) lists content,
playlists, content schedules and device groups, but documents **no way to download a content file**.
As with OptiSigns, ScreenTinker does not rely on undocumented behaviour, and without the files the
playlists would arrive empty. An API importer may follow once it can be tested against a real
MagicINFO server.

**Your Samsung screens do not need replacing.** On the display, open the menu and go to
**System > Play Via > URL Launcher** (called **Custom App** on Tizen 6.5 and later), point it at your
ScreenTinker player address and make URL Launcher the source the display boots into (Auto Source
Switching or the URL Launcher Settings entry, depending on firmware); nothing has to be installed
(see the [Samsung TV guide](https://screentinker.com/guides/samsung-tv-digital-signage.html)). The
display then plays ScreenTinker instead of MagicINFO.

**Moving your content:** copy your media files out of MagicINFO (on an On-Premise server the
uploaded files are in the server's `runtime` folder) or use your original files, then use the zip
import below, with one folder per playlist or a `playlists.csv`. Rebuild MagicINFO Author (LFD)
layouts, video wall layouts, tickers and data links with ScreenTinker layouts and widgets.

If your MagicINFO 9 server is reachable from the internet, patch or isolate it while you move:
CVE-2024-7399 and CVE-2025-4632 have been exploited in the wild.

**Docs read**

- https://docs.samsungvx.com/docs/ (End of Sale and End of Service dates)
- https://docs.samsungvx.com/docs/x/NhiUAw (MagicINFO Server 9 / Cloud Open API)
- https://nvd.nist.gov/vuln/detail/CVE-2024-7399

### Others we looked at

- **piSignage** has a documented API. It is not built yet; use the zip import.
- **Rise Vision** and **NoviSign** publish no API reference. Use the zip import.

### Any other system: a zip of media, with optional CSVs

Upload a `.zip` (up to 2 GB):

- **Every image, video and audio file** in it is imported. The bytes decide the type, so a misnamed
  file is caught. Anything else is listed.
- **Without a CSV**, each folder that holds media becomes a playlist of those files, in name order
  (`2.png` before `10.png`).
- **`playlists.csv`** (optional) defines playlists instead. Columns:
  - `playlist`
  - `file`: the path inside the zip
  - `duration`: seconds, optional
  - `order`: optional

  Example:

  ```
  playlist,file,duration,order
  Lobby,lobby/welcome.jpg,8,1
  Lobby,lobby/promo.mp4,,2
  ```
- **`screens.csv`** (optional) adds screen placeholders. Columns:
  - `name`
  - `group`: optional; separate several groups with `;`
  - `playlist`: optional

  Example:

  ```
  name,group,playlist
  Front desk,Lobby screens;Ground floor,Lobby
  ```

Column names are matched case-insensitively. Common synonyms (`filename`, `seconds`, `screen`,
`tags`…) work too.

Uploading the same zip again reuses what it made. A different zip is a different source.

## What gets changed on the way (lossy cases)

ScreenTinker schedules use **wall-clock times in the schedule's time zone**. They repeat daily, weekly
on chosen weekdays, or monthly on the start's day of the month, with an inclusive end date and a
same-day time window. Other systems can express more, so:

| In the old system | In ScreenTinker |
|---|---|
| A repeating window past midnight (22:00–02:00) | Split into an evening and an early-morning schedule, the second on the following days |
| Every 2 or more days, weeks or months | Every day, week or month (said in the report) |
| Every N minutes or hours, yearly, "2nd Tuesday" | Not imported (listed) |
| One occurrence lasting several days | Its daily time window |
| A limited number of occurrences | Runs until the end date |
| No time zone known | UTC, with a note to check it |
| Random or shuffled playback | In order |
| Widgets, web pages, apps | Left out (listed); add a ScreenTinker widget |

Schedules that targeted a single screen target a group made for that screen, named
*<screen> (imported)*. The placeholder joins it when you pair it, so the schedule starts working the
moment the screen is paired.

## For administrators

- **Outbound requests.** Every request goes through the server's SSRF guard (`lib/ssrf-guard.js`):
  - public addresses only;
  - DNS pinned;
  - every redirect re-checked;
  - credentials never forwarded to another host.

  Vendor API hosts are fixed per vendor:
  - `app.yodeck.com`
  - `api.screenlyapp.com`
  - `graphql.eu|us.screencloud.com`

  The API key is sent only to that host. Media on a CDN is fetched without it.

  Only Xibo and Anthias take an address from the person. To import from one on a private network,
  allow it with `OUTBOUND_ALLOW_HOSTS` (or `OUTBOUND_ALLOW_PRIVATE`); see
  [outbound-requests.md](outbound-requests.md). Cloud metadata addresses are always refused.
- **Limits.**
  - One import at a time per workspace, two at a time per server.
  - 20,000 items of each kind per import.
  - Uploads up to 2 GB.
  - The API is rate-limited per IP (`/api/migrate`: 120 per minute; connecting or uploading: 30 per
    hour).
- **Data.** Three new tables, all deleted with their workspace:
  - `migration_jobs`
  - `migration_items` (the id map that makes a re-run idempotent)
  - `migration_screens` (placeholders)

  After a job ends it keeps its summary and report; the scanned catalog of the source is dropped.
- **Restart.** An import running when the server stops comes back as *Interrupted*; press **Resume**.
  No import resumes by itself.
- **Audit log.** These actions are recorded:
  - `migration_started`
  - `migration_connect`
  - `migration_run`
  - `migration_done`
  - `migration_cancelled`
  - `migration_screen_linked`

  None of them carries a credential.
- **API.** `/api/migrate` is JSON, JWT-only (no API tokens), and acts on the active workspace:
  - `GET /vendors`
  - `GET /jobs`
  - `POST /jobs`
  - `POST /jobs/upload`
  - `GET /jobs/:id`
  - `POST /jobs/:id/run`
  - `POST /jobs/:id/cancel`
  - `GET /placeholders`
  - `POST /placeholders/:id/link`
  - `DELETE /placeholders/:id`
