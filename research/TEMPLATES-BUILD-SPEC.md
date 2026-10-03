# Templates library — build spec (binding for everyone working in this worktree)

Worktree: `/home/owner/Downloads/st-templates-research` (branch `research/templates-library`).
Tests: **Node 20 only** — `export PATH="$HOME/.nvm/versions/node/v20.20.1/bin:$PATH"`, run from `server/`
with `node --test test/<file>.test.js`. Never start servers on the user's ports; the research server is 3098.

## Decisions (fixed)

1. **A template is never a plugin** and never runs on the server. Two kinds:
   - `slide` — declarative: a slide `template` (the `config.template` shape of lib/slide-render.js) with
     `{{param:name}}` placeholders, rendered by `renderSlideHtml`. No template-author code runs anywhere.
   - `html` — the author's HTML/CSS/JS, rendered on players in a sandboxed document. Code.
2. **Package format** (no zip on the trusted path): a `.sttemplate` file is JSON:
   ```json
   { "format": "screentinker-template/1",
     "package": "<base64 of the canonical package bytes>",
     "signature": { "key_id": "<16 hex>", "sig": "<base64 Ed25519>" } }
   ```
   `signature` may be `null` (unsigned). Canonical package bytes = UTF-8 JSON, keys sorted recursively, no
   whitespace: `{ "manifest": {...}, "files": { "<path>": "<base64>" } }`. Deterministic, so CI can rebuild
   and compare hashes. Package sha256 = sha256 of the canonical package bytes (not the envelope), so
   re-signing never changes a package's identity.
   Signature = Ed25519 over `"screentinker-template-package/1\n" + packageBytes` (domain separated).
3. **Catalog index**: `index.json` + `index.json.sig` (base64 Ed25519 over
   `"screentinker-template-index/1\n" + indexBytes`). Index:
   ```json
   { "schema": 1, "catalog": "official", "serial": 1727600000, "generated": "ISO", "expires": "ISO",
     "revoked": [ { "id": "x", "versions": ["*"], "reason": "..." } ],
     "templates": [ { "id","name","description","author","license","kind","tags":[],"orientation":[],
        "versions": [ { "version","min_server","sha256","size","url":"packages/<id>-<ver>.sttemplate",
                        "network":[], "published" } ] } ] }
   ```
   `url` is relative to the index URL (so a mirror is just a copy of the directory). `serial` must never go
   down (rollback); `expires` past → shown as stale, still usable.
4. **Signing key**: a DEDICATED Ed25519 "template catalog" key — NOT the support key (the support key lives
   on the internet-facing hosted server and is deliberately powerless alone; a catalog key pushes code to
   screens and must stay offline). Public key compiled in (`lib/templates/keys.js`), overridable by env
   `TEMPLATE_CATALOG_PUBLIC_KEY`. `key_id` = first 16 hex of sha256(raw 32-byte public key).
5. **Manifest** (`manifest` inside the package):
   ```json
   { "id": "lobby-welcome", "name": "...", "version": "1.2.0", "kind": "slide"|"html",
     "description": "...", "author": "...", "license": "MIT", "tags": [], "orientation": ["landscape"],
     "min_server": "2.2.0", "entry": "index.html" (html) | "template.json" (slide),
     "thumbnail": "thumbnail.png", "network": ["api.example.com"] (html only),
     "params": [ { "name": "accent", "type": "color", "label": "Accent colour", "default": "#E8A33D",
                   "required": false, "options": [..] (select), "max": 200 (text) } ] }
   ```
   id `/^[a-z][a-z0-9-]{1,63}$/`, version strict semver `x.y.z`, param name `/^[a-z][a-z0-9_]{0,39}$/`,
   ≤ 40 params. Param types: `text`, `textarea`, `color`, `number`, `select`, `image`, `timezone`,
   `locale`, `data_source`, `checkbox`. **There is no secret type**: anything given to an html template is
   visible to its author.
6. **Files**: ≤ 64 files, ≤ 2 MB decoded total, ≤ 1 MB each, paths `/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}(\/[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}){0,3}$/`,
   no `..`, no leading dot segments. Extensions: html, css, js, json, svg, png, jpg, jpeg, webp, gif, woff2,
   txt, md. Plus root LICENSE/README.md allowed.
7. **Instance model**: install is instance-wide (platform admin), stored in `$DATA_DIR/templates/<sha256>.sttemplate`
   + `templates_installed` table. Use = a widget of new built-in type **`template`** in the workspace with
   `config = { template_id, values: {...}, ds_refs: [{ "slug": "..." }] }` (ds_refs so data-source
   changes bump the widget). Render resolves the installed version; version is pinned on install and
   changed only by an explicit update. Revoked/uninstalled → a black page, never the old code.
8. **Render (html kind)**: the entry HTML with every local `src/href` inlined as data: URIs (or inline
   `<style>/<script>`), values injected as `<script id="st-values" type="application/json">` (JSON with
   `<` `>` `&` U+2028/9 escaped) plus a tiny `window.ST` runtime. Response headers:
   `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' data:;
   style-src 'unsafe-inline' data:; img-src data: blob: <declared network>; font-src data:; media-src data: blob:;
   connect-src <declared network https only, else 'none'>; form-action 'none'; base-uri 'none'; frame-src 'none'`,
   `X-Content-Type-Options: nosniff`, no `X-Frame-Options`. The `sandbox` directive forces an opaque origin
   even when the URL is opened top-level (an admin clicking the render link must not hand template JS the
   dashboard origin / its localStorage JWT).
9. **Catalog fetch** is OFF until a platform admin enables it (`app_settings.templates_catalog_enabled`),
   honouring the "no phone home" invariant (docs/plugins.md P4). When on: fetch at boot+5min then every 24h,
   plus "Check now". Offline: import an offline bundle (zip of index.json, index.json.sig, packages/*) or a
   single `.sttemplate`.
10. **Trust levels** shown everywhere: `verified` (signed by a trusted catalog key, sha matches), `unverified`
   (local import, unsigned or unknown key). Unverified `html` templates require the instance setting
   `templates_allow_unsigned_code` (default off). Unverified `slide` templates are allowed for platform admins.

## Module layout

- `server/lib/templates/package.js` — parse/validate/canonicalize/pack a `.sttemplate` (pure, no DB).
- `server/lib/templates/signing.js` — keys, key_id, sign/verify package + index (domain separated).
- `server/lib/templates/params.js` — validate values against params; substitute into slide templates.
- `server/lib/templates/render.js` — html-kind document builder + CSP; slide-kind config builder.
- `server/lib/templates/store.js` — DB + disk (install, list, uninstall, revoke, get).
- `server/lib/templates/catalog.js` — catalogs, fetch, verify, serial/expiry, offline bundle import.
- `server/routes/templates.js` — `/api/templates` (JWT only, tenancy).
- `scripts/template-catalog.js` — keygen / pack / sign / build-index / verify / bundle (maintainer CLI).
- `catalog/` — scaffold of the future `screentinker/templates` repo (templates/, CI, docs).
- Built-in weather data source: `server/lib/data-sources/weather-resolver.js` (type `weather`, Open-Meteo, keyless).

## Weather data-source keys (contract for templates)

Flat keys only (so `{{ds:slug.key}}` works): `location`, `temperature`, `apparent_temperature`, `humidity`,
`wind_speed`, `condition` (English text), `icon` (emoji), `code` (WMO), `units` ("C"/"F"), `updated`, and for
`d` in 0..5: `day{d}_name` (short weekday in the source's locale), `day{d}_date` (YYYY-MM-DD),
`day{d}_high`, `day{d}_low`, `day{d}_condition`, `day{d}_icon`, `day{d}_code`, `day{d}_precip_prob`.
