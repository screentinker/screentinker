# Templates library — research notes and proposed design

Status: research, 2026-09-29. Branch `research/templates-library`. Nothing here is built yet.
Run an isolated server for experiments with `research/run-server.sh` (port 3098, data in `research/data/`).

## The ask (Discord)

Community "app store" for templates: a zip of HTML/JS + a manifest of editable fields (logo, location,
colours, playlist) + thumbnail. Authors PR to a templates repo under the ScreenTinker org; merge publishes
an index on GitHub Pages; each on-prem server checks the index daily; Content → Templates → Library shows
"New"; Install stores the zip locally; fill fields with live preview; "Add to…" screen/playlist.
Air-gapped: import a zip like a plugin. Each server fetches its own data (weather etc.).

## What already exists (reuse, don't rebuild)

| Need | Existing piece |
|---|---|
| "Editable fields over a fixed design" | Slide model: `config.template` = view, `config.fields` = record, joined only in `renderSlideHtml` (`server/lib/slide-render.js`). `normalizeSlide` clamps everything. |
| Add to screen/playlist | A slide IS a widget (`widget_type='slide'`), so it's already a playlist item; decks publish to a playlist (`lib/slide-deck.js`). |
| Live data per server | `{{ds:slug.key}}` interpolation + data sources polled server-side with the server's own config. |
| Field form UI | Plugin `fields[]` schema + `frontend/js/lib/plugin-fields.js`. Secrets redacted + encrypted (`lib/plugins/secrets.js`). |
| Zip intake safety | `lib/plugins/inbox.js` (caps, symlink/bomb/traversal refusal) and `lib/html-bundle.js` (never extracts). |
| Review → approve on a server | `plugin_submissions` flow + tree-hash allowlist (`lib/plugins/{submissions,allowlist}.js`). |
| Sandboxed render on players | Widget render → `allow-scripts` iframe, no same-origin; `?rev=` immutable caching for offline. |
| Periodic remote fetch | `lib/ghcr-check.js` (timer, timeout, cache); opt-in pattern from `lib/telemetry.js`. |
| Gallery + "Use template" | Layouts `is_template` + `POST /:id/duplicate` (only real gallery today). |
| Ed25519 verification | Node `crypto.verify(null, …)` — already used by support access (#391). No dependency needed. |

What does NOT exist: a template artifact type, a declared field schema for slides (fields are strings only;
colour/tz/locale/logo are view properties), image/tz/playlist field types, any catalog fetch (plugin
invariant P4 "no phone home"), "New"/update state, a server-side weather data source (the weather widget is
client-side wttr.in, current conditions only), and a playlist *region* inside an item.

## Proposed design

### 1. Two kinds of template, one library

- **Slide templates (declarative, v1).** JSON: a slide `template` + a `params` schema (label, type, default,
  and *which view property it overrides*) + embedded images. No code runs, so review is cheap, import passes
  through `normalizeSlide`, and it works on every player that shows slides today. Covers logo, colours,
  location/tz, language/locale, text, clock/date/countdown, QR, `{{ds:}}` data.
- **HTML templates (code, v2).** The proposal's zip of HTML/JS + manifest. Rendered like a widget in the
  `allow-scripts` iframe with a strict CSP (`connect-src` = hosts declared in the manifest only); field
  values injected as a JSON blob, never interpolated into markup. Reuses html-bundle validation.
  Per-workspace "allow code templates" switch, default off.

Plugins stay what they are (trusted in-process Node code, platform-admin only). A template is never a plugin.

### 2. Catalog: `screentinker/templates` repo

- `templates/<id>/` holds source; **CI builds the zips** (reproducible: sorted entries, fixed mtimes) and
  attaches them to a release in that repo. Authors never control the published bytes; every update is a
  new PR with a new review (avoids Obsidian's "reviewed once, updates unreviewed" hole).
- PR checks: schema, id = folder, semver bump, thumbnail size/aspect, licence (MIT/Apache/BSD code; CC0/CC-BY
  media; OFL fonts; **no GPL/AGPL**, per the licence position), no CDN/hotlinked assets, no `eval`, network
  calls only to declared hosts, headless render → screenshot on the PR. Second-maintainer approval.
- `index.json` on GitHub Pages, **signed** (Ed25519, minisign-compatible). Public key compiled into the
  server. Index carries `generated`/`expires`; server refuses an index older than the one it holds
  (rollback) and flags a stale one (freeze). Per-version `sha256`, `size`, `minServer`, `permissions`.
- `revoked[]` in the index: enforced even with updates off — `disable` stops rendering + alerts the admin.
  The unsigned index as proposed would let anyone who owns the Pages site or the network path put code on screens.

### 3. On the server

- **Catalog fetch is an admin switch, off until turned on** (P4 + "no phone home" is a promise we've made).
  The Library tab shows a one-click "Enable community library" for admins. When on: daily fetch, same shape
  as `ghcr-check.js`. `TEMPLATE_CATALOGS` / admin UI can add extra catalogs as `{url, publicKey, label}`
  (Jellyfin / Node-RED model); identity is `catalog/id` so ids can't be squatted across catalogs.
- **Install** = download zip, check sha256 against the signed index, store under `$DATA_DIR/templates/`,
  record `{catalog, id, version, sha256}`. Re-verify the stored hash before serving. Updates are *offered*,
  not auto-applied (a new version changes what's on screens).
- **Use** = "Use template" creates a workspace copy (the layouts `/duplicate` pattern) → fill params with the
  existing preview-session → it's a widget, so "Add to playlist" / assign-to-screen already work.
- "New" badge = `catalog_seen` per user/org.

### 4. Air-gapped servers

- **Offline bundle:** CI also produces `screentinker-templates-YYYYMMDD.tar` (index + signature + all zips).
  Importing it runs exactly the same signature, hash and revocation checks as online (Grafana's rule: offline
  must still verify).
- **Mirror:** unpack that tarball on any internal web server and add it as a catalog URL (same key).
- **Single zip:** verified if it ships a detached signature from a trusted key; otherwise admin-only,
  marked "Local import (unverified)", optionally forbidden per org.

### 5. Data ("each server fetches its own")

Already the model for data sources. Gap: weather. Add a built-in, keyless server-side `weather` data source
(Open-Meteo; current + daily forecast flattened to `{{ds:slug.…}}` keys) and a `weather` slide element that
binds to it. Optional per-server API keys reuse the encrypted-secrets path. Templates never ship keys.

## Open decision: the "playlist" field

Nothing today puts a playlist *region* inside an item. Options:

- **(a)** new slide element `region` → a sub-player of a child playlist. Matches the proposal's UX
  ("template with a playlist box, add it to a playlist"), but breaks the "snapshot is flat, players never
  learn nesting" invariant and needs player work on every platform + offline pinning of the child's media.
- **(b)** a template compiles to a **layout + zoned items**; the playlist box becomes a zoned child playlist
  (child items already inherit `zone_id`). Reuses the most code, but "Add to playlist" becomes
  "Apply to screen", since layouts bind to devices, not playlists.

Recommendation: ship v1 without it (slide templates), decide (a) vs (b) with a prototype.

## Suggested phases

1. Slide templates with a `params` schema + built-in weather data source + local Library tab
   (built-in templates only, no network). Useful on day one, including hosted.
2. Export/import of a template file (air-gapped path, unverified local import).
3. `screentinker/templates` repo + CI + signed index + offline tarball; server catalog fetch behind the switch.
4. HTML (code) templates behind the per-workspace switch.
5. Playlist regions, after the (a)/(b) prototype.

## Prior art (condensed)

Obsidian (PR one index line; artifacts in author repo; updates unreviewed; removal list) · HACS (CI action +
human review; blacklist/critical lists; custom repos) · Grafana (signed per-file hash manifest; offline
install must still verify) · VS Code (signed packages; block list force-uninstalls) · Jellyfin / Node-RED
(user-added catalog URLs) · Xibo Layout Exchange (static index, **no hash, no signature**, connector can be
switched off) · Screenly Edge Apps (settings schema incl. image; secrets separate) · Yodeck HTML apps (zip
runs locally → works offline). Security: TUF (freeze/rollback), minisign (Ed25519, trusted comments).
