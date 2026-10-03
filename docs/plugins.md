# Plugins

A self-hosted ScreenTinker node can load **trusted local plugins**: extra widget types,
data-source resolvers, optional API routes, and a small set of named hooks, without forking
`routes/widgets.js`.

> ### Trust model: this is not a sandbox
>
> A loaded plugin runs **in the server process via `require()`, with full Node privileges** — the
> same as any file under `server/lib`. There is no VM, worker, or capability confinement at runtime.
> The security of the system is therefore **gatekeeping, not isolation**: code runs only after a
> platform admin has approved that exact tree (pinned by sha256) or an operator with shell access
> has dropped it in and enabled it. Treat installing a plugin as equivalent to editing the server's
> own source. **Never** relax the approval gate to auto-run uploaded code, and do not describe this
> as a sandbox anywhere. The manifest `network` allowlist (below) narrows what a plugin's own
> `api.fetch` may reach, but it is a guardrail for honest plugins, not a boundary against hostile
> ones — a plugin that wanted to could bypass it with raw `require('http')`.

If a change appears to require breaking one of the invariants below, **stop**. It is not a judgement
call to make inside a PR.

Each invariant names the test that holds it up (`server/test/plugins-invariants.test.js`,
`server/test/plugin-submissions.test.js`).

---

## Invariants

| # | Invariant | Guard |
|---|---|---|
| **P1** | **Off by default and invisible.** Plugins do not load unless `PLUGINS_ENABLED=true`. When off, there is no Admin → Plugins section (the endpoint 404s), no `/plugins/:id` static mount, no `/api/plugin-submissions`, and no `require()` of plugin code. | `test_plugins_off_by_default` |
| **P2** | **Trusted local code only.** Plugins load from two directories, never from the content library, the inbox, URLs, or npm. (1) bundled `plugins/` at the repo root. (2) `$DATA_DIR/plugins/` (survives `git pull`). Path traversal and a `main` that realpath-escapes the plugin root are refused. | `test_path_traversal_refused`, `test_content_dir_is_not_a_plugin_root`, `loader never scans the inbox directory` |
| **P3** | **Failure isolation.** A missing `plugin.json`, thrown `activate()`, or broken render must not prevent boot or blank a screen. The plugin is marked `error` and the rest continue. An unknown widget type still renders the existing placeholder page, HTTP 200. Hook handlers run on their own turn; a throw is logged, not propagated. | `test_broken_activate_does_not_prevent_load`, `test_unknown_type_is_degraded_not_thrown` |
| **P4** | **No phone home.** The loader never fetches a registry, checks a licence, or phones screentinker.com. | `test_no_phone_home` |
| **P5** | **Plugins cannot clobber core.** A widget type of `clock` / `weather` / `rss` / `text` / `webpage` / `social` / `directory-board` / `directory-search` / `diag-smoothness` / `slide` / `transition`, or a data-source type of `ical`, is refused. Plugin ids match `/^[a-z][a-z0-9-]{1,63}$/`. | `test_collision_with_clock_is_refused` |
| **P6** | **Same tenancy and auth as everything else.** `/api/admin/plugins` is JWT-only and `requirePlatformAdmin`. Plugin-contributed routers mount at `/api/plugins/:id` behind `requireAuth` + `resolveTenancy`. Widget *instances* stay workspace-scoped. Uploading a zip is `canWrite`; approving it is platform admin. | `test_admin_plugins_is_platform_admin_gated` |
| **P7** | **No build step.** Server is CommonJS `require`. Dashboard is vanilla JS. Plugins do not introduce a bundler. | (review) |
| **P8** | **Players do not need a plugin runtime.** Widget plugins render server-side to HTML via the existing `GET /api/widgets/:id/render` path. Render must not do network I/O — use a data-source plugin for that. | (review — no loader in `server/player/`) |
| **P9** | **Uploaded bytes never execute without an explicit approval of that exact tree.** A dashboard zip lands in `$DATA_DIR/plugin-inbox`, is inspected against a file allowlist, and waits. The loader never scans the inbox. Approve copies the inspected tree into `$DATA_DIR/plugins/<id>` and pins its sha256. Enable + restart still required to `require()`. | `submit stores pending and never copies onto a plugin root`, `approve copies onto the data-dir plugin root and pins the hash; it does not enable` |
| **P10** | **An allowlisted tree is loadable only at the approved hash.** After approval (or a manual pin), a subsequent edit on disk is a load error, not a new payload. Revoking an upload-sourced pin does not fall back to drop-folder trust. | `loader refuses an allowlisted plugin whose files changed` |

Hosted screentinker.com keeps `PLUGINS_ENABLED` unset.

---

## Enable

```
PLUGINS_ENABLED=true
```

Restart. Copy a plugin folder to `$DATA_DIR/plugins/<id>/` (or use the bundled copy under `plugins/`
in a git checkout), or approve a zip. Refresh **Admin → Plugins** — the id appears disabled.
Enable it. Restart again.

Dropping a folder on disk does **not** load it. Enable is explicit, and enable does not `require()`
new code into the running process. Approve is not enable.

Optional:

| Variable | Description | Default |
|----------|-------------|---------|
| `PLUGINS_ENABLED` | Load the plugin system | unset (off) |
| `PLUGINS_DIR` | Operator-installed plugins | `$DATA_DIR/plugins` |
| `BUNDLED_PLUGINS_DIR` | Samples shipped in the repo | `<repo>/plugins` |
| `PLUGIN_INBOX_DIR` | Quarantine for uploaded zips. Not a plugin root. | `$DATA_DIR/plugin-inbox` |

---

## Upload and approve

Two install paths, on purpose:

1. **Drop-folder.** An operator with shell access copies a directory into `$DATA_DIR/plugins`. They
   already have the host. Enable is the gate. No hash pin unless they click **Pin** to lock the tree.
2. **Dashboard zip.** Anyone with workspace write can upload a `.zip` (Admin → Plugins, or
   `POST /api/plugin-submissions`). The zip is inspected and stored in the inbox. It is **not**
   a plugin. Platform admin reviews the file list and `plugin.json`, then **Approve** or **Reject**.
   Approve copies the tree into `$DATA_DIR/plugins/<id>` and pins the sha256. It does not enable.
   Refresh Admin → Plugins, enable, then restart.

The zip is refused rather than sanitised if any of these hold:

- Path traversal, absolute paths, drive letters, symlinks, encryption, non-UTF8 names
- A file not on the allowlist (`plugin.json`, `index.js`, `README.md`, `LICENSE`, `public/**` with
  `.js` `.json` `.md` `.html` `.css` `.svg` `.png` `.jpg` `.webp` `.woff2` `.txt`)
- `package.json`, `node_modules`, `.git`, shell scripts, native addons
- A reserved widget / data-source type
- Size or compression-ratio caps (2MiB archive, 8MiB inflated, 64 files)

Zipping the plugin folder itself is fine: a single wrapping directory is stripped if it contains
`plugin.json`.

After approval, an edit on disk that changes the tree hash is a load error. **Unpin** of an
upload-sourced plugin disables it and removes the data-dir copy rather than treating it as a
drop-folder. **Pin** on a drop-folder plugin locks its current hash the same way.

---

## Layout

```
plugins/<id>/
  plugin.json     required
  index.js        required (CommonJS). `exports.activate = function (api) { ... }`
  README.md       required for bundled plugins
  public/         optional static files, served at /plugins/<id>/* when the plugin is loaded
```

Same id in both roots: **data-dir wins**.

`activate()` **must be synchronous**. Register capabilities and return. If it returns a Promise,
the load is refused and anything it registered is rolled back — boot cannot wait on a plugin that
never settles. Kick off background work from a hook or from `resolve()`, not from `activate()`.

`plugin.json` may set `"screentinker": ">=2.0.0"`. Only `>=x.y.z` is understood; any other string
is a warning and a pass.

### Network egress (optional)

A plugin may declare the hosts its fetches are allowed to reach:

```json
"network": { "allow": ["api.weather.com", "*.example.com"] }
```

When declared, every fetch the plugin makes (`api.fetch`, and the `fetch` handed to a data-source
`resolve()`) is checked against the list before the SSRF guard runs; a host not on the list is
refused with `egress-not-allowed`. A `*.` prefix matches one-or-more leading labels
(`*.example.com` matches `a.example.com`, not the bare `example.com`). When **absent**, egress is
unrestricted (still SSRF-guarded: loopback / link-local / cloud-metadata are always refused) —
because plugins like `json-api` and `webhook` fetch an operator-supplied URL at any host, which a
static list cannot express. So the allowlist is an opt-in guardrail an honest plugin uses to
constrain itself, visible in the manifest a platform admin reviews at approval. It is **not** a
boundary against a hostile plugin (see the trust-model note at the top).

### Secrets at rest

Secret fields (type `password`, `secret: true`, or a credential-looking name) in a data source's
config and in a plugin's saved settings are **encrypted at rest** (AES-256-GCM via `lib/secretbox`,
key derived from the instance JWT secret). Non-secret config stays readable. Rotating `JWT_SECRET`
makes stored secrets undecryptable — they read back empty and must be re-entered. Existing plaintext
rows are encrypted in place by a one-time migration at boot.

### `activate(api)`

```js
module.exports = {
  activate(api) {
    api.registerWidget({
      type: 'countdown',
      render(config, ctx) {
        // Full HTML page. Use ctx.escapeHtml / ctx.safeCss / ctx.safeUrl / ctx.safeNumber.
        // ctx.interpolate(str) resolves {{ds:slug.key}} against cached data sources.
        // No network I/O — render is on the player-facing path.
      }
    });
    api.registerDataSource({
      type: 'json-api',
      async resolve(config, ctx) {
        // ctx.fetch(url, opts) is the SSRF-guarded request (same guard as iCal).
        // Return a flat object of keys matching [a-zA-Z0-9_]+ for {{ds:slug.key}}.
        // Return null to keep the previous cache (HTTP 304).
      }
    });
    api.on('playlist.published', ({ id, name, workspace_id }) => { /* fire-and-forget */ });
    api.on('device.offline', ({ device_id, reason }) => {});
    api.on('device.online', ({ device_id, reason }) => {});
    api.on('content.uploaded', ({ content_id, workspace_id, mime }) => {});
    api.on('plugin.submitted', ({ submission_id, plugin_id, submitted_by }) => {});
    api.on('plugin.approved', ({ submission_id, plugin_id, sha256, approved_by }) => {});
    api.on('plugin.rejected', ({ submission_id, plugin_id, decided_by }) => {});
    // api.fetch(url, { method, headers, body }) — SSRF-guarded, 2xx accepted. Same private-IP
    // refusal as iCal. For hook handlers and data-source resolve, not widget render.
    // api.registerRouter(express.Router())  // mounted at /api/plugins/<id>
    // api.getSettings() / api.saveSettings(obj)  — instance-global JSON, 32KiB cap
    // api.log(...)
  }
};
```

`api` is a frozen, narrow object. It does **not** include `app`, `db`, or `io`.

### Hooks

An allowlist, not a bus. Unknown names throw at register time.

| Name | Fired from | Payload |
|------|------------|---------|
| `device.offline` | Heartbeat timeout, and `logDeviceStatus` on a genuine disconnect | `{ device_id, reason }` |
| `device.online` | `logDeviceStatus` on a genuine reconnect/register | `{ device_id, reason }` |
| `playlist.published` | The shared `publishPlaylist` path, only when the snapshot actually changed | `{ id, name, workspace_id }` |
| `content.uploaded` | Shared ingest (`lib/content-ingest.js`), dashboard and agency | `{ content_id, workspace_id, mime }` |
| `plugin.submitted` | Workspace or admin zip upload, after inspect, still pending | `{ submission_id, plugin_id, name, version, sha256, submitted_by, workspace_id }` |
| `plugin.approved` | Platform admin approve — tree copied and hash pinned | `{ submission_id, plugin_id, name, version, sha256, approved_by }` |
| `plugin.rejected` | Platform admin reject — archive deleted | `{ submission_id, plugin_id, decided_by }` |

Handlers run on `setImmediate`. A throw is logged. Payloads are identifiers — never tokens, never
secrets, never the request object. Telemetry packets do **not** fire these (that path is a flood).
Unknown hook names throw at `api.on` and are a no-op at `emit`.

### Settings and secrets

`plugin.json` may include `settings.fields` using the same field types as widgets, plus `password`.
Platform admin edits them on Admin → Plugins. **Settings apply immediately** (hook handlers re-read
`getSettings()`). Enable/disable still needs a restart.

`password` fields (and anything named `authorization`) are never returned by GET. A blank PUT keeps
the stored value. Widget/data-source config of type `password` behaves the same.

---

## Samples

- `plugins/countdown` — widget. Drop-folder → enable → create widget → `/player` ticks.
- `plugins/json-api` — data source. Poll JSON through the SSRF guard, flatten, bind with
  `{{ds:slug.weather_temp}}`. Authorization is a password field: GET never returns it, blank PUT keeps it.
- `plugins/webhook` — hooks. POST `device.offline` / `device.online` / `playlist.published` /
  `content.uploaded` / `plugin.submitted` / `plugin.approved` / `plugin.rejected` to an HTTPS URL.
  Settings (URL, token, which events) apply immediately, no restart. Tick "When someone submits a
  plugin zip" if you want Discord/ntfy when an editor queues a package for you.

---

## Explicitly not in this version

No stubs, no dormant paths, no disabled-in-UI versions.

- Plugin marketplace, remote install, signed-package verify
- Hot reload without process restart
- Dashboard hash-routes / sidebar items contributed by plugins
- WebSocket namespaces contributed by plugins
- Android / Tizen / webOS / BrightSign native plugins
- Replacing built-in widgets with plugin copies
- A generic "any event" bus (the allowlist is the feature)
- Sandboxing untrusted code — approval is the human gate, not a VM
- Per-workspace plugin enablement (instance-level only; widget instances are still workspace-scoped)
