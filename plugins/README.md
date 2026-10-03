# Bundled plugins

Trusted local plugins shipped with ScreenTinker. They do **not** load unless
`PLUGINS_ENABLED=true`, and even then each one stays disabled until a platform
admin enables it and the process restarts.

| Id | What |
|----|------|
| [`countdown`](countdown/) | Widget. Count down to a date on a sign. |
| [`json-api`](json-api/) | Data source. Poll JSON, bind `{{ds:slug.field}}` on slides. |
| [`webhook`](webhook/) | Hooks. POST offline / online / publish / content-upload / plugin-review events to an HTTPS URL. |

This is not a marketplace. There is no registry, no `npm install`. Operators drop a
folder here (or in `$DATA_DIR/plugins`) after they have read it. Dashboard users may
upload a `.zip`; it sits in quarantine until a platform admin approves that exact
tree, and even then enable + restart are required before it loads.

See [`docs/plugins.md`](../docs/plugins.md) for the contract.

Plugins are trusted code, same as `server/lib`. Do not enable a folder you have
not read, and do not approve a zip you have not inspected.
