# Templates library: HTTP API authorisation, tenancy and SSRF review

Scope: `server/routes/templates.js`, `server/lib/templates/*`, the template branches in
`server/routes/widgets.js`, the `/api/templates` mounts in `server/server.js` and `config/api-surface.js`,
and every other route that can write a `template` widget.

Harness: `server/test/templates-security-api.test.js`. It spawns the real `server.js` on port 3103
with a throwaway `DATA_DIR` under `$TMPDIR` and TEST Ed25519 keys (`TEMPLATE_CATALOG_PUBLIC_KEY`), then
drives it over HTTP as eight identities:

- platform_admin
- org owner (org A) and org_admin (org A)
- workspace_editor and workspace_viewer (ws A)
- platform_operator (the role a support session gets)
- a user in another org (org B / ws B)
- a user with no workspace
- an `st_` API token (org A, scope `full`)

Tests assert the safe behaviour, so a finding shows up as a failure labelled `BUG`. The server is
killed in `after()`. Run it with:

```
export PATH="$HOME/.nvm/versions/node/v20.20.1/bin:$PATH"; cd server && node --test test/templates-security-api.test.js
```

Result on 2026-09-29: 25 tests, 17 pass, 8 fail. The 8 failures are findings 1–7 below; finding 1
accounts for two of them.

## Findings

| # | Issue | Severity | Exact repro | Proposed fix |
|---|---|---|---|---|
| 1 | **Any workspace member, including a read-only `workspace_viewer`, can write through `POST /api/status/import`.** This creates widgets (including `template` widgets with unvalidated config), devices, playlists and so on. It also overwrites the workspace `white_labels` row, including `custom_css` and `custom_domain`. `POST /api/white-label` restricts those two fields to platform admins, because `custom_css` is injected into the login page and `custom_domain` routes a host's login page. The bug predates templates, but it is a real road to a `template` widget that skips both `POST /api/widgets` (refuses the type) and `/use` (viewer gets 403). | **High** (pre-existing, `routes/status.js`) | As a viewer of ws A: `curl -X POST $B/api/status/import -H "Authorization: Bearer $VIEWER" -H 'Content-Type: application/json' -d '{"format":"screentinker-export-v2","widgets":[{"id":"x","widget_type":"template","name":"viewer-import","config":{"template":"official/slide-probe","values":{}}}],"white_label":{"brand_name":"pwned","custom_css":"body{display:none}","custom_domain":"login.victim.example"}}'` returns 200. The widget is created, and `white_labels.custom_css`/`custom_domain` for ws A are set. Tests: *workspace import … refused for a workspace_viewer*, *… cannot set platform-admin-only branding*. | After `sessionWorkspaceId(...)`, compute `accessContext(userId, role, ws)` and refuse `!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer'` (the same rule as `denyReadOnly`). In the `white_label` import block, drop `custom_css`/`custom_domain` unless `isPlatformRole(session.user.role)`, mirroring `routes/white-label.js:39-41`. Optionally skip `widget_type === 'template'` rows on import, or run them through `tplWidget.buildConfig` (render is already safe, see "Verified safe"). |
| 2 | **The preview store is an unauthenticated-read, tenant-writable memory sink of up to about 1 GB.** `previews` holds the full rendered HTML (≤ 6 MB, `MAX_DOC_BYTES`) for 5 minutes, capped at **200 entries globally** with FIFO eviction. The only throttle is the mount-wide `rateLimit(60000, 120)`, which keys on the raw path. Express decodes `%xx` in `:id`, so `/installed/local/%68tml-big/preview` is the same template but a new bucket. One editor on one IP bypasses the limit. Measured: one org-B editor, one IP, 210 previews in about 3 s pushed server RSS from 382 MB to 1296 MB (+914 MB). Each document was 4.82 MB: an html template with about 1.8 MB of JS plus a 1.9 MB image from the attacker's own content. The global FIFO also evicts other tenants' live previews (410). On the hosted multi-tenant server, any free sign-up can do this whenever one html template with an image param, or large assets, is installed. | **High** on hosted, Medium self-hosted | Test: *preview store: bounded memory, …* The loop is `POST /api/templates/installed/local/<percent-variant of html-big>/preview {"values":{"photo":"<own 1.9MB image id>"}}` × 210. | (a) Do not keep rendered HTML. Store `{key, values, workspaceId, userId, at}` (a few hundred bytes) and render on `GET /preview/:token`. Otherwise enforce a **byte budget** (for example 64 MB in total) and a **per-user cap** (for example 3 live previews, oldest of *that user* evicted). (b) Mount a dedicated limiter, as `/api/widgets/preview` has (`rateLimit(60000, 30)`), on `/api/templates/installed/:c/:id/preview` and `/use`, and fold that shape in `lib/limit-paths.js`: `[/^\/api\/templates\/installed\/[^/]+\/[^/]+\/(preview\|use)$/, m => '/api/templates/installed/:c/:id/' + m[1]]`. (c) In `canonicalLimitPath`, `decodeURIComponent` each segment before lowercasing. The %-encoding bucket bypass is general, not specific to templates. |
| 3 | **The public `/preview/:token` and `/thumb/:sha` limiter is per token, not per IP.** Every distinct token or sha is its own bucket: 130 requests from one IP to random tokens gave zero 429s. Guessing is irrelevant (192-bit tokens). The effect is that the limiter is decorative, and each distinct path adds an entry to the `rateLimits` map, which is only pruned when it exceeds 10 000 entries. | Low | Test: *public preview/thumb mount is rate limited per IP (not per token)*. | Add shapes `'/api/templates/preview/:token'` and `'/api/templates/thumb/:sha'` to `LIMIT_PATH_SHAPES`. |
| 4 | **`/import` buffers up to 300 MB for every kind before checking the 8 MB template limit.** A 120 MB non-bundle body grew RSS by about 212–226 MB before the 413 (raw-body concat roughly doubles it). A 300 MB request costs about 600 MB, and a few in parallel from an admin session, or a stolen admin JWT, would OOM the server. | Low (platform admin only) | Test: *import: an oversize non-bundle upload is refused before it is buffered*. `curl -X POST $B/api/templates/import -H "Authorization: Bearer $ADMIN" --data-binary @120MB.bin` returns 413 after the full buffer. | Check `Content-Length` before the parser: if `req.query.kind !== 'bundle'` and the length exceeds `pkgLib.MAX_ENVELOPE_BYTES * 2`, return 413. Use two parsers: `express.raw({limit: '8mb'})` for templates and `'256mb'` (matching `readZip maxArchiveBytes`) for `kind=bundle`. For bundles, stream to a temp file instead of heap. |
| 5 | **`/import` with `Content-Type: application/json` fails with "empty upload".** A `.sttemplate` is JSON. The global `app.use(express.json({limit:'12mb'}))` (server.js:284) consumes it first, so `express.raw` sees an already-parsed body. A browser `fetch` that labels the file `application/json`, or `curl -H 'Content-Type: application/json'`, gets a misleading 400. | Low (functional) | Test: *import: a .sttemplate sent as application/json still imports*. | Register `app.post('/api/templates/import', express.raw(...))` before the global `express.json` (as the Stripe webhook does), or in the route re-serialise the body when `req.body` is a plain object that has `format`. |
| 6 | **Instance-level template actions are audited into whichever workspace the admin is acting in.** `audit()` passes `req.workspaceId`, so `PUT /settings` with `X-Workspace-Id: <tenant ws>` writes a `templates.settings` row with `workspace_id = tenant ws`. This mis-attributes the action and would surface in any per-workspace audit view or export (mesh audit and the like). | Low | Test: *admin actions are audited, … not into a tenant workspace*. | Call `logActivity(..., workspaceId = null)` for settings, catalogs, install, import and uninstall. These actions are instance-wide. |
| 7 | **`POST /catalogs/:cid/refresh` is not audited.** It is an admin-triggered outbound fetch, and it can revoke or reinstate installed templates. Only the resulting revocations are logged, with `user_id` null. | Low | Test: *catalog refresh … is audited* (12 refreshes, 0 rows). | `audit(req, 'templates.catalog_refreshed', { id, ok, serial })` on success and failure. |

### Observations (no test failure, worth a decision)

- **O1: `GET /library` shows every member of every tenant each catalog's `url` and `last_error`.**
  With `TEMPLATE_CATALOG_ALLOW_PRIVATE=1`, that is an internal mirror address. That same mode also
  turns `last_error` into `catalog responded HTTP <status>` from the internal host. The status comes
  from the unguarded `fetch` branch as a `CatalogError`. The guarded branch returns only the generic
  message. Suggest trimming `url` and `last_error` from the non-admin library payload.
- **O2: previously-rendered template documents can outlive a revoke or the unsigned-code switch in
  caches.** The server correctly blanks both the new-rev and the pinned `?rev=<old>` URL (verified).
  But the old-rev response went out with `Cache-Control: public, max-age=31536000, immutable`. A CDN
  (prod sits behind Cloudflare) keeps serving the withdrawn code at that URL to anyone who asks for
  it. Players move to the new rev, so screens are safe. Consider `private` or `no-store` for
  `widget_type === 'template'` renders, or a purge on revoke.
- **O3: the package cache (`store.js`, 24 entries) is checked at load, not at render.** A package
  file tampered on disk after it was cached keeps rendering until eviction or restart. A tamper made
  *before* the first load is refused (verified: thumb returns 404, use returns 409). This is
  acceptable, but the "RE-VERIFIED ON EVERY LOAD" comment should say "every cold load".
- **O4: `/thumb/:sha` serves any package file on disk that passes its hash check.** That includes
  packages kept by an offline bundle but never installed, and revoked templates. It exposes only the
  manifest thumbnail (png/jpeg/webp, `nosniff`, `CSP: sandbox`), so this is information only.
- **O5: mesh replication copies `widgets` rows as they are (`lib/mesh/replication.js`).** A replica
  where a *different* package is installed under the same `catalog/id` renders its own package with
  the replicated values. Render re-validates leniently, so this is safe, but documentation should
  note that keys are not globally unique for `local/…` imports.
- **O6: `http:` catalog URLs are accepted.** Signatures protect integrity, but which templates a
  server fetches is visible on the wire. Consider requiring `https:` unless `ALLOW_PRIVATE`.
- **O7: redirect-to-private SSRF could not be exercised end to end.** It needs a public first hop,
  and the sandbox has no egress. By code review, `guardedRequest` re-runs `assertSafeUrl` on every
  hop (`maxRedirects: 3`) and pins the socket to the vetted addresses. The test's loopback sink
  answers every request with a 302 to loopback and was never reached.

## Verified safe (with the test that pins each)

- **The admin surface is platform-admin only.** `GET/PUT /settings`, `GET/POST/PATCH/DELETE
  /catalogs`, `/catalogs/:cid/refresh`, `/install`, `/import` (both kinds) and `DELETE
  /installed/:c/:id` all return 403 for the org owner, org_admin, editor, viewer,
  **platform_operator** (with and without act-as into ws A), the other-org user and the no-workspace
  user. Nothing changed underneath: network still off, official catalog still enabled, nothing
  installed. `PLATFORM_ROLES` excludes `platform_operator`, so a support session cannot install
  code.
- **JWT only.** An `st_` API token gets 401 on every `/api/templates` route (`requireAuth` does
  `jwt.verify`). Unauthenticated requests get 401.
- **No ambient credentials, so no CSRF surface.** A `Cookie: token=<jwt>`, `?token=` or
  `?access_token=` does not authenticate. Only `Authorization: Bearer`.
- **`use`:**
  - Viewer: 403. User with no workspace: 403. Editor: 201 in its own workspace.
  - An org-B user sending `X-Workspace-Id: <ws A>` is silently resolved to ws B, and the widget
    lands in ws B.
  - An image id or data-source slug from another workspace returns 400 on `use`, on `preview` and
    on `PUT` (`contentExists` and `dataSourceExists` are workspace-scoped). So do path-traversal-shaped
    ids and `tpl:` references to non-image package files.
- **Widget PUT tampering.**
  - `config.template` cannot be repointed: it is rebuilt from the stored key.
  - Extra keys (`evil`, `__proto__`, forged `ds_refs`) are dropped. The stored config is exactly
    `{template, values, ds_refs}`.
  - Wrong types, over-long text, URLs as images, and ws B's image or data source return 400.
  - Cross-org PUT and viewer PUT return 403.
- **`POST /api/widgets`** with `widget_type: 'template'` returns 400 over JWT, and 400/403 over an `st_`
  token.
- **Render isolation, with a positive control.** A ws A widget does render ws A's image
  (`/uploads/content/<file>` in a slide, an inlined data URI in html) and ws A's data-source secret.
  A ws B widget whose raw config names ws A's image id and ws A's slug, created through the
  unvalidated import road, renders neither:
  - `readContentImage` is scoped to `widget.workspace_id`.
  - `imageResolverFor` is scoped the same way.
  - `slideImageResolver` delegates non-`tpl:` ids to that scoped resolver.
  - `getWorkspaceDataMapSync(widget.workspace_id)` backs both `dataResolverFor` and the html
    `data` map.

  An unknown or garbage `config.template` renders the black page. The `st-values` JSON stays
  script-safe with a `</script>` value.
- **Render headers.** `Content-Security-Policy: sandbox allow-scripts; …`, `nosniff`, no
  `X-Frame-Options`. Preview responses carry the same CSP plus `Cache-Control: no-store`. An
  expired or unknown token returns 410 with `CSP: sandbox`.
- **Preview tokens** are 24 random bytes (base64url, 32 characters, 192 bits). They are bearer URLs by
  design (an iframe cannot send the JWT) and contain only the previewer's own workspace data. A viewer
  may preview, which is read-only.
- **`used_by` and the uninstall 409 widget list** (widget names from every org) are returned only to
  platform admins. Non-admins get neither. `GET /installed` exposes no `installed_by`.
- **The thumbnail route** serves only `manifest.thumbnail`, only png/jpeg/webp, with
  `nosniff` + `CSP: sandbox`. A package without a thumbnail, an upper-case, suffixed or
  traversal-shaped sha, or an unknown sha all return 404. A package **tampered on disk** returns
  404 on thumb and 409 on use.
- **SSRF.**
  - `file:`, `gopher:`, `data:`, `ftp:` and `user:pass@` URLs are refused at `POST /catalogs` (400).
  - With the network switch on, `refresh` against the following never reached a loopback listener
    (0 hits):
    - `127.0.0.1:<port>`, `localhost:<port>`, `[::1]`, `[::ffff:127.0.0.1]`
    - `2130706433` (decimal) and `0x7f.1`
    - `0.0.0.0`, `169.254.169.254`, `[fd00::1]`, `10.0.0.1`, `192.168.1.1`
    - `127.0.0.1.nip.io`. The sandbox has no external DNS, so this one was stopped by `dns-fail`;
      `localhost` is the DNS name that proved resolved-address blocking.
  - Every one of these returned 502 `"the catalog could not be reached"`. Neither the response nor
    `template_catalogs.last_error` contains the address, the port, `ECONNREFUSED` or `blocked`.
  - `TEMPLATE_CATALOG_ALLOW_PRIVATE` was unset.
- **Import kind confusion.** A template zip sent as `kind=bundle`, a bundle sent as a template, and
  garbage all return a clean 4xx, and nothing is installed.
- **The unsigned-code switch.**
  - Enabling it needs the exact phrase: missing, wrong or upper-cased gives 400.
  - Disabling it bumps `updated_at` on every widget of an unverified html template, so players
    re-fetch.
  - With the switch off, both the current and the pinned `?rev=<old>` render return the black page,
    with no author code, including the ws B widget created by import.
  - `use` and `preview` return 409, and importing a new unsigned html template returns 403.
- **Audit content.** Settings, import, uninstall and catalog add/remove are logged. Every details
  blob is under 2 KB: key, version, sha256 and trust, never package bytes.
