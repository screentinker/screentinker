# Your data, provably

ScreenTinker is open source, and you can self-host it. That helps IT and procurement, but they still
have to check what the server actually does. This feature lets them check it on the running server:

- **Outbound connections**: every external host the server contacted, the day it did, and the
  feature that caused it.
- **Data handling page**: where data lives, what is encrypted, which integrations are on and what
  each one sends, how long data is kept, backups, and sign-in security. The page is built from the
  running configuration, so it changes when the configuration changes.
- **Complete export**: everything an organization has, or everything about one person, as a zip
  file with a machine-readable manifest.
- **Delete everything**: an organization owner can delete the organization, after a grace period.

| Who | Where |
|---|---|
| Organization owners and admins | **Settings → Data & privacy** (`#/privacy`) |
| Everyone else | **Settings → Data & privacy** shows the personal export only |
| Platform admins | **Platform → Data & privacy** (`#/platform/privacy`) shows the whole instance |
| Anyone, if a platform admin turns it on | **`/trust`**, a public page you can print |

## Outbound connections

The server counts every HTTP request it makes to another host. It counts at the two places all HTTP
traffic in the process has to pass, whichever library makes the request:

- **`node:http` / `node:https`**: Node's `http.client.request.created` diagnostics channel. This
  covers the SSRF guard (`lib/ssrf-guard.js`), `lib/ai-fetch.js`, the AWS, Azure and Stripe SDKs,
  the mesh's WebSocket client, and any raw `https.request`.
- **Global `fetch`**: undici's `undici:request:create` channel.

Listening on a diagnostics channel does not alter or delay a request. The only code inside the
request path is a thin wrapper around `globalThis.fetch`. It records which code called `fetch` and
passes the arguments through unchanged.

SMTP is not HTTP, so `services/email.js` records each SMTP send itself (host and port only).

**What is recorded.** One row per UTC day, per host, per feature, per workspace. Each row holds:

- the host, with the port when it is not the default;
- the feature and its category;
- the network: internet, private network, this server, or a local socket;
- the workspace and organization the request was made for;
- request count, error count, and declared bytes in and out (from `Content-Length`);
- first seen and last seen.

**What is never recorded:** paths, query strings, headers, bodies, or credentials. The ledger cuts
the host out of the request before it looks at anything else, and the table has no column that
could hold a URL.

**Which feature caused it.** The ledger tries these in order:

1. An explicit context, when the code supplied one.
2. The first server file on the caller's stack that is not itself an outbound chokepoint.
3. The SDK package on the stack.
4. The destination host.

The file, package and host tables are in `lib/trust/features.js`. Attribution is best effort; the
host is always exact.

**Which organization.** A request made while serving a dashboard request is attributed to that
request's workspace. Data-source refreshes are attributed to the source's workspace, including the
ones the background poller runs.

> ⚠️ A timer started inside a request inherits that request's context. Once the response has
> finished, the ledger ignores that context and records the row at instance level. Without this
> rule, a background job could appear in one organization's view under another organization's
> name.

**Who sees it.**

- Platform admins see every host, for the last 30 or 90 days.
- Organization admins see only the hosts contacted for their organization.

The server writes rows every minute and at shutdown. It keeps them for 400 days.

### Outbound paths, and the chokepoint test

`test/trust-ledger.test.js` reads every server file. It fails when a file can make an outbound
request but is not on the list of reviewed files. A file can make an outbound request if it does any
of these:

- calls or references `fetch`;
- loads an http, https, net or tls client;
- loads an SDK that has its own HTTP client;
- opens a WebSocket client.

Each file on the list has one of these kinds:

| Kind | Meaning |
|---|---|
| chokepoint | A guard that callers should use: `lib/ssrf-guard.js`, `lib/ai-fetch.js`, `lib/bi/http.js` |
| feature | A direct caller. Its feature must be named in `lib/trust/features.js` |
| browser | Code inside a template string that a player or browser runs, not the server |
| inbound | A server, or a module that uses `net` only for `isIP` |

New code should use `guardedRequest`, `guardedFetch` or `lib/data-sources/http.js` `fetchText`. To
add a direct caller, put it on the list with a feature.

Some outbound traffic does not go through Node's HTTP stack, so the ledger does not see it:

| Path | Notes |
|---|---|
| Headless Chromium (embedded renders, only when puppeteer is installed) | Has its own network stack. Every request is still checked by `assertSafeUrl`. |
| `npm ci` at boot | Only when dependencies need repair. Set `ST_SKIP_DEP_PREFLIGHT=1` to turn it off. |
| DNS lookups | Includes custom-domain TXT/CNAME checks (`lib/domain-verify.js`). |
| `scripts/updater/st-updater.sh` | Runs outside the server process. Uses `git fetch` and `docker pull`. |

Some network calls are made by players and browsers, not by the server:

- the weather widget (`wttr.in`);
- the radar widget (`api.rainviewer.com` and `tilecache.rainviewer.com` for radar frames, or an org's own map-tile host if one is set; the built-in map is bundled Natural Earth data and makes no request);
- room panel and live-publish code;
- the STUN server handed to WebRTC.

News widgets are not on this list. Since 3.0 the server reads every news feed itself (feature
`news_feeds`, `lib/news-feed/`), and a screen reads the headlines and pictures from the server. See
[news-feeds.md](news-feeds.md).

Several direct callers do not go through the SSRF guard. Their destinations are fixed hosts or URLs
set by the operator:

| File | Destination |
|---|---|
| `lib/telemetry.js` | Install statistics |
| `lib/ghcr-check.js` | Update check |
| `lib/ai-hosted.js` | Hosted AI providers |
| `lib/canva.js`, `lib/user-deletion.js` | Canva API and token revoke |
| `lib/m365.js` | Microsoft Graph |
| `lib/rooms/http.js` | Calendar providers |
| `lib/bi/powerbi.js`, `routes/bi-connections.js` | Power BI |
| `routes/content.js` | YouTube oEmbed |
| `lib/go2rtc.js` | Live video relay |
| `lib/replica-proxy.js` | Scale-out primary |
| `routes/mesh-enroll.js`, `lib/mesh/*` | Mesh peers |

On a self-hosted server, bring-your-own AI also uses plain `fetch`, as documented in
`lib/ai-fetch.js`. This feature does not change any of these paths. It counts them.

**The update check is always on.** It sends an anonymous GET to `ghcr.io` 30 seconds after boot and
then every `GHCR_CHECK_INTERVAL_HOURS` (default 36). It sends no instance data. The data handling
page lists it as always on.

## The data handling page

`GET /api/trust/report` builds the report every time it is called (`lib/trust/report.js`). It reads:

| Section | Read from |
|---|---|
| Where data lives | The storage layer's effective profile, the same one uploads use (`STORAGE_PROVIDER`, or the instance, organization and workspace profiles). Shows provider, region, bucket, endpoint and who set it. Also the content rows actually stored and, for platform admins, the database file, its size and the data folder. |
| Encryption at rest | Every `*_enc` column in the live schema, which are AES-256-GCM via `lib/secretbox.js`. Passwords are bcrypt and API tokens are SHA-256. Media and the database file are not encrypted by the application; use disk encryption for those. |
| What leaves this server | Every integration in `lib/trust/integrations.js`: whether it is on now, what it sends, whether that includes customer data, and the hosts it sends to. Instance integrations come from env and app settings. Organization integrations are counted from the organization's own rows. |
| Install statistics | `lib/telemetry.js` state, and the exact fields it sends. |
| Retention | `PLAY_LOG_RETENTION_DAYS`, `STATUS_LOG_RETENTION_DAYS`, `TELEMETRY_RETENTION_DAYS`, `REVISION_KEEP`, `REVISION_COALESCE_SEC`, `BILLING_USAGE_RETENTION_DAYS`. Plus fixed values: audit log 90 days, screenshots (latest only), export files 24 h, upgrade snapshots (newest 3), deletion grace 14 days. |
| Backups | Database snapshots taken before each upgrade (`lib/upgrade-snapshot.js`) and the platform admin's database download. The application makes no off-site copies. |
| Sign-in security | Members with two-step sign-in, passkeys and authenticator apps. SSO providers, whether SSO is required, and SCIM. |
| Residency | "All of your data stays on this server" when media and the database are local and no integration that sends customer data is on toward an internet host. Otherwise the page lists the integrations that send data off the server. |

The residency statement never overclaims:

- If the page cannot name an integration's destination, it counts that integration as sending data
  off the server.
- Object storage on a private address, such as MinIO next to the server, counts as local.

### The public `/trust` page

The public page is **off by default**. A platform admin turns it on under **Platform → Data &
privacy**. That tab also previews exactly what the page publishes.

The page (`frontend/trust.html`) reads `GET /api/public/trust`, which is rate-limited. Both return 404
while the page is off.

The page shows an allowlist of facts:

- storage provider and region;
- database type;
- how secrets, passwords and tokens are stored;
- which instance-level services are on, by name;
- install statistics on or off;
- retention periods;
- the backup policy;
- which sign-in protections exist;
- the residency statement.

It never shows host names, buckets, endpoints, paths, organization or user names, counts, or the
server version. The version is left out because it tells an attacker what to try.

The public view is built by copying named fields, not by deleting fields from the full report. A
field added to the report later is therefore private until someone adds it to the allowlist.

Use your browser's print command to print the page. The print stylesheet produces a clean document
for a procurement pack.

## Complete export

**Settings → Data & privacy → Export everything.** An export is a background job
(`lib/trust/export.js`).

1. The server streams a zip to `DATA_DIR/exports/<id>.zip`. It reads rows in pages and writes them
   as JSON Lines, so no table or media library is ever held in memory.
2. When the zip is ready, a **Download** button appears.
3. The button asks for a link that works for 15 minutes. Only a hash of the link's key is stored.
4. The file is deleted 24 hours after it was made.

### Organization export (owners and admins)

| Path in the zip | Contents |
|---|---|
| `manifest.json` | `screentinker-org-export-v1`. Every category with its tables, row counts and files; the columns removed because they hold credentials; and each table deliberately left out, with the reason. |
| `tables/<table>.jsonl` | Every row of every table that belongs to the organization. |
| `files/<content id>/…` | Uploaded media and thumbnails, wherever they are stored. |
| `fonts/<font id>/…` | Uploaded fonts. |
| `workspaces/<id>/export.json` | Each workspace in the format **Settings → Import data** reads. To restore one workspace, zip its `export.json` together with `files/`. |

Categories: organization, members, content, playlists, schedules, layouts, signs, widgets, data
sources, devices, alerts, automation, integrations, settings, history, proof of play, audit and
outbound.

**"Everything" is enforced by a test.** `lib/trust/export-tables.js` classifies every table in the
database: it is either exported, with a category and a rule for finding the organization's rows, or
excluded, with a reason. `test/trust-export.test.js` fails on any table that is not classified. A new
table therefore cannot be left out of the export by accident.

**Secrets never leave the server:**

- Columns whose names look like credentials are dropped. This uses the same rule mesh replication
  and MCP use (`lib/secret-names.js`).
- The mesh replication blocklist also applies.
- In JSON settings, encrypted values and keys with secret-looking names are removed.

**Checkable on its own (3.0).** `manifest.json` lists the SHA-256 and size of every other file in the
zip (`integrity.entries`), and the download sends the whole archive's SHA-256 (`X-Export-SHA256`) and
supports `Range`, so a transfer can resume. Another server can restore the organization from this
zip, even after this server is gone: see [Move your organization to another server](move-server.md).
Platform administrators can also export the whole server as one bundle (same document).

### Personal export (anyone, for themselves)

The personal export covers the GDPR right of access.

| Path in the zip | Contents |
|---|---|
| `account.json` | Profile, organizations and workspaces with roles, passkeys (names and dates), API tokens (names, prefixes and scopes), Canva connection names, email preferences, receipts, and product events. |
| `activity.jsonl` | Every audit-log entry that records your actions. |
| `resources/export.json` | What you created, in the import format. |

Your password hash, two-factor secret, recovery codes, token hashes and OAuth tokens are never
included. Content, screens and settings belong to the organization, so they are in the organization
export, not the personal one.

### Limits and audit

- Only one export of the same kind can be in progress at a time.
- At most 3 exports per organization per day, and 3 personal exports per person per day.
- Requesting an export or downloading one writes an audit entry: `trust.export_org_requested`,
  `trust.export_org_downloaded`, `trust.export_personal_requested` or
  `trust.export_personal_downloaded`.
- On every download, the server checks again that the person who asked still has access. An org
  admin who is removed from the organization loses the link they already hold.
- Break-glass and support sessions cannot export.

## Delete everything

**Settings → Data & privacy → Delete everything.** Only an organization **owner** can do this; org
admins cannot. To confirm, the owner types the organization's exact name.

- Nothing is deleted for **14 days**. Any owner can cancel until then, and a platform admin can also
  cancel.
- Every owner and admin is emailed when the deletion is scheduled, if the server can send email.
- On a hosted instance, an organization with an active paid subscription must cancel it first.
- After the grace period, the server runs the same deletion a platform admin uses
  (`lib/user-deletion.js` `deleteOrgCascade`):
  - every workspace and every tenant row;
  - the integrations' credentials, with Canva tokens revoked at Canva;
  - the media files, once the database rows are deleted;
  - the organization's exports and outbound-ledger rows.
- People's accounts are not deleted, because they may belong to other organizations. They only lose
  access to this one.
- The audit row `trust.org_deleted`, which records the organization's name and who asked, is kept.

Platform admins can still delete an organization immediately under **Platform → Organizations**.

## API

All routes are under `/api/trust`. They require a dashboard sign-in; API tokens cannot use them.

| Method | Path | Who |
|---|---|---|
| GET | `/report` (`?scope=instance`) | Org owners and admins (platform admins for `instance`) |
| GET | `/outbound?days=30\|90` (`&scope=instance`) | Same |
| GET, PUT | `/public` | Platform admins |
| GET, POST | `/exports` (`{ kind: 'org' \| 'user' }`) | `org`: owners and admins. `user`: anyone, for themselves |
| POST | `/exports/:id/link` | The person who requested it, or the organization's admins |
| GET, POST, DELETE | `/org-deletion` | POST: owners only. DELETE: owners and platform admins |

Public routes, each with its own rate limit:

- `GET /trust`
- `GET /api/public/trust`
- `GET /api/public/trust-export/:id?key=…`

This feature adds no new environment variables. It does add three tables: `outbound_ledger`,
`data_exports` and `org_deletion_requests`.
