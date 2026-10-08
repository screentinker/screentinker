const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { devicesPlayingWidget } = require('../lib/devices-playing');
const slideRender = require('../lib/slide-render');
const appConfig = require('../config');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
const { denyReadOnly, resourceAccess } = require('../lib/tenancy');
const { isRealTimezone } = require('../lib/device-timezone');
const { escapeHtml, safeUrl, safeCss, safeNumber } = require('../lib/widget-sanitize');
const pluginRegistry = require('../lib/plugins/registry');
const { BUILTIN_WIDGET_TYPES } = require('../lib/plugins/reserved');
const { redactSecrets, mergeSecrets, fieldsForWidget, redactConfigJson } = require('../lib/plugins/secrets');

function redactWidgetRow(row) {
  if (!row) return row;
  const fields = fieldsForWidget(row.widget_type);
  const out = { ...row };
  out.config = redactConfigJson(row.config, fields);
  if (row.draft_config) {
    let draft;
    try { draft = JSON.parse(row.draft_config); } catch { draft = null; }
    if (draft && draft.config && typeof draft.config === 'object' && !Array.isArray(draft.config)) {
      const redacted = redactSecrets(draft.config, fields);
      if (JSON.stringify(redacted) !== JSON.stringify(draft.config)) {
        out.draft_config = JSON.stringify({ ...draft, config: redacted });
      }
    }
  }
  return out;
}

function storedWidgetConfig(widget) {
  if (widget && widget.draft_config) {
    try {
      const draft = JSON.parse(widget.draft_config);
      if (draft && draft.config && typeof draft.config === 'object') return draft.config;
    } catch { /* fall through to live config */ }
  }
  try { return JSON.parse((widget && widget.config) || '{}'); } catch { return {}; }
}

// For preview only: inline /api/content/:id/file and /thumbnail URLs as data URIs,
// scoped to the caller's current workspace. Lets the srcdoc preview iframe show
// logos/bg images before the widget is saved (post-save they're reachable via
// the widget-reference gate).
const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10MB cap — base64 expands ~1.33x
const MIME_RE = /^image\/[a-zA-Z0-9.+-]+$/;
function inlineUserContent(html, workspaceId) {
  if (!workspaceId) return html;
  return html.replace(/\/api\/content\/([a-f0-9-]+)\/(file|thumbnail)/gi, (match, id, kind) => {
    const c = db.prepare('SELECT filepath, thumbnail_path, mime_type, workspace_id FROM content WHERE id = ?').get(id);
    // Inline content only when it lives in the caller's workspace, or is a
    // platform-template row (workspace_id IS NULL) shared with everyone.
    if (!c) return match;
    if (c.workspace_id && c.workspace_id !== workspaceId) return match;
    const filename = kind === 'thumbnail' ? c.thumbnail_path : c.filepath;
    if (!filename) return match;
    // YouTube (and other remote-sourced) content stores thumbnail_path as a remote
    // http(s) URL, not a local file. Don't try to read it from disk (would ENOENT the
    // same way the serving route did) — leave the /api/content/:id/thumbnail reference
    // in place; the thumbnail route proxies it same-origin and CSP img-src allows https:.
    if (/^https?:\/\//i.test(filename)) return match;
    const mime = kind === 'thumbnail' ? 'image/jpeg' : c.mime_type;
    if (!mime || !MIME_RE.test(mime)) return match;
    const safe = path.resolve(appConfig.contentDir, path.basename(filename));
    if (!safe.startsWith(path.resolve(appConfig.contentDir))) return match;
    try {
      const st = fs.statSync(safe);
      if (!st.isFile() || st.size > MAX_INLINE_BYTES) return match;
      const buf = fs.readFileSync(safe);
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { return match; }
  });
}

/*
 * Is this an actual IANA zone? (#316)
 *
 * ⚠️ CHARACTER-SHAPE IS NOT VALIDATION. This used to test the string against a character class,
 * which passes anything spelled like a zone and rejects anything spelled unusually, neither of
 * which is the question. A Spanish operator hit both halves of that in one sitting:
 *
 *   "España"  -> the 'ñ' fails a character class -> silently fell back to UTC -> clock two hours
 *                behind, with nothing anywhere saying why.
 *   "Spain"   -> passes a character class, is not a zone -> toLocaleTimeString throws RangeError
 *   "GMT+2"   -> inside the generated widget script -> the clock renders NOTHING at all.
 *
 * Intl is the only thing that actually knows, so ask it. Kept as a fallback for configs already
 * stored with a bad value (a blank clock is worse than a wrong one); new values are rejected at
 * save time by validateTimezone below, so nobody silently gets UTC again.
 */
function safeTimezone(tz) {
  if (!tz) return 'UTC';
  return isRealTimezone(tz) ? tz : 'UTC';
}

function serverTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch (_) { return 'UTC'; }
}

function clockDateFormat(format) {
  switch (format) {
    case 'long': return "year:'numeric', month:'long', day:'numeric'";
    case 'medium': return "year:'numeric', month:'short', day:'numeric'";
    case 'short': return "year:'2-digit', month:'2-digit', day:'2-digit'";
    default: return "weekday:'long', year:'numeric', month:'long', day:'numeric'";
  }
}

function clockDatePosition(position) {
  return ['above', 'below', 'left', 'right'].includes(position) ? position : 'below';
}

/*
 * A BCP-47 tag, structurally — same approach and same expression as slide-render.js's LOCALE_RE.
 *
 * ⚠️ EMPTY MEANS "THE PLAYER'S OWN LOCALE", NOT ENGLISH (#323). The clock and date were formatted
 * with a hardcoded 'en-US', so a Spanish operator got "Wednesday, September 3" on a screen whose
 * dashboard, timezone and audience were all Spanish, with no setting anywhere to change it. An
 * empty locale now yields `undefined`, which is how toLocaleTimeString is told to use the runtime's
 * own locale — the right default for a screen standing in a particular country.
 */
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
function safeLocale(l) {
  if (!l || typeof l !== 'string') return 'undefined';      // literal `undefined` in the emitted JS
  return LOCALE_RE.test(l) ? `'${l}'` : 'undefined';
}

/*
 * Save-time gate. Returns an error string, or null when the value is fine. A widget config is
 * accepted or refused as a whole, so this is called before the insert/update rather than at render,
 * where the only options left are "wrong time" or "no time".
 */
function validateTimezone(config) {
  const tz = config && config.timezone;
  if (tz === undefined || tz === null || tz === '') return null;   // absent is fine: safeTimezone -> UTC
  if (isRealTimezone(tz)) return null;
  return `"${String(tz).slice(0, 60)}" is not a time zone. Use an IANA name such as Europe/Madrid, `
       + 'America/New_York or UTC — a country name or a GMT offset will not work.';
}

// A room display may only show a room of its OWN workspace: the id comes from a config blob a user
// typed, and the panel would otherwise read — and book — another tenant's room.
function validateRoomDisplay(type, config, workspaceId) {
  if (type !== 'room-display') return null;
  const id = config && config.room_id;
  if (!id) return null;   // an unconfigured display says so on screen
  const ok = workspaceId && db.prepare('SELECT 1 FROM rooms WHERE id = ? AND workspace_id = ?').get(String(id), workspaceId);
  return ok ? null : 'That room is not in this workspace.';
}

// Validate ISO date string format
function safeDateString(d) {
  if (!d) return '';
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(d) ? d : '';
}

// Security: widget render output is public and CSP-exempt — see lib/widget-sanitize.js.

// List widgets accessible to the caller's current workspace, plus any
// platform-template rows (workspace_id IS NULL) shared with all workspaces.
// Phase 2.2d: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list branch.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const widgets = db.prepare(
    // 'cap_alert' rows are the hidden cards of emergency feeds (lib/cap/feeds.js), not library widgets.
    "SELECT * FROM widgets WHERE (workspace_id = ? OR workspace_id IS NULL) AND widget_type != 'cap_alert' ORDER BY created_at DESC"
  ).all(req.workspaceId);
  res.json(widgets.map(redactWidgetRow));
});

// Create widget in the caller's current workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating widgets.' });
  if (denyReadOnly(req, res)) return;   // a read-only member cannot create (PUT/DELETE use checkWidgetWrite)
  const { widget_type, name, config } = req.body;
  if (!widget_type || !name) return res.status(400).json({ error: 'widget_type and name required' });
  if (!pluginRegistry.isAcceptedWidgetType(widget_type)) {
    return res.status(400).json({ error: 'Unknown widget_type' });
  }
  // A template widget's config is only ever built by lib/templates (POST /api/templates/:key/use),
  // which validates every value against the installed template. Here it would be a free blob.
  if (widget_type === 'template') {
    return res.status(400).json({ error: 'Create template widgets from the Templates library' });
  }
  const tzErr = validateTimezone(config);
  if (tzErr) return res.status(400).json({ error: tzErr });
  let storedConfig = config;
  if (widget_type === 'cloud-doc') {
    const cd = cloudDocConfig(config);
    if (cd.error) return res.status(400).json({ error: cd.error });
    storedConfig = cd.config;
  }
  if (widget_type === 'bi-dashboard') {
    const bi = biConfigOrError(req.workspaceId, config);
    if (bi.error) return res.status(400).json({ error: bi.error });
    storedConfig = bi.config;
  }
  if (widget_type === 'social') {
    const sw = socialConfigOrError(req.workspaceId, config);
    if (sw.error) return res.status(400).json({ error: sw.error });
    storedConfig = sw.config;
  }
  const roomErr = validateRoomDisplay(widget_type, config, req.workspaceId);
  if (roomErr) return res.status(400).json({ error: roomErr });

  const id = uuidv4();
  db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, widget_type, name, JSON.stringify(storedConfig || {}));

  require('../lib/revisions').recordCurrent(db, 'widget', id, { actor: require('../lib/releases').actorOf(req), summary: 'Created' });
  res.status(201).json(redactWidgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id)));
});

/*
 * The bundled font catalogue, for the slide editor's font picker.
 *
 * ⚠️ SERVED RATHER THAN DUPLICATED IN THE FRONTEND. The editor previewing a family the renderer
 * does not have — or offering one it dropped — makes the tool a liar about the thing it exists to
 * show. One list, defined next to the files themselves.
 */
router.get('/slide-fonts', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ fonts: require('../lib/slide-fonts').catalogue() });
});

/*
 * Enabled plugin widget types (plus their field schemas) for the dashboard picker.
 * Empty when plugins are off. Built-in types stay client-side so i18n does not move.
 */
router.get('/plugin-types', (req, res) => {
  res.json({ types: pluginRegistry.listWidgetTypes() });
});

router.get('/clock-defaults', (req, res) => {
  res.json({ timezone: serverTimezone() });
});

// Phase 2.2d: workspace-aware access. Mirrors the device/content pattern.
// Platform-template widgets (workspace_id IS NULL) are readable by anyone
// authenticated and writable only by platform_admin.
function checkWidgetRead(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  if (!widget.workspace_id) return widget;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(widget.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return widget;
}

// CORPORATE: a widget head office's playlist plays may be changed or deleted only by a corporate
// author (duplicating one is a read, and stays open). Returns true when refused.
function corpMediaRefused(req, res, widget) {
  const corpGuard = require('../lib/corporate/guard');
  try { corpGuard.assertMediaWritable(req, 'widget', widget.id); return false; } catch (e) {
    if (corpGuard.send(res, e, req)) return true;
    throw e;
  }
}

function checkWidgetWrite(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  if (!widget.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared widgets' }); return null;
    }
    return widget;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(widget.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  // An emergency feed's card belongs to the feed: edit or delete the feed instead.
  if (widget.widget_type === 'cap_alert') {
    res.status(409).json({ error: 'This is an emergency feed\'s alert card. Change it from Emergency feeds.', code: 'CAP_CARD' }); return null;
  }
  return widget;
}

/*
 * Duplicate a widget: a new, independent widget with the same type and settings — three screens,
 * three menus, without typing the first one in three times.
 *
 * ⚠️ THE COPY STAYS IN THE ORIGINAL'S WORKSPACE. Its config names that workspace's data sources and
 *    content by id/slug; landing it anywhere else would either break those or reach across tenants.
 * ⚠️ THE LIVE CONFIG IS COPIED, NEVER A PENDING DRAFT. With approval on, copying the draft would put
 *    unreviewed changes into a brand-new live widget — a way around review. The copy is what the
 *    original's screens are showing now; its first edit becomes a draft like any other.
 * ⚠️ A TEMPLATE WIDGET IS REBUILT, not copied as a blob — exactly what "Use…" and PUT do. Since the
 *    original was made, its template may have been revoked or uninstalled, unsigned code switched
 *    off, or an image/data source it names deleted.
 */
router.post('/:id/duplicate', (req, res) => {
  if (denyReadOnly(req, res)) return;
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  if (widget.widget_type !== 'template' && !pluginRegistry.isAcceptedWidgetType(widget.widget_type)) {
    return res.status(400).json({ error: 'This widget type is not available on this server any more' });
  }
  let config;
  try { config = JSON.parse(widget.config || '{}'); } catch { config = {}; }
  if (widget.widget_type === 'template') {
    try {
      config = require('../lib/templates/widget').buildConfig(config.template, config.values, widget.workspace_id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, param: e.param });
    }
  }
  const asked = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const name = (asked || `${widget.name} (copy)`).slice(0, 120);

  const id = uuidv4();
  db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, widget.workspace_id, widget.widget_type, name, JSON.stringify(config));
  require('../lib/revisions').recordCurrent(db, 'widget', id, {
    actor: require('../lib/releases').actorOf(req),
    summary: `Duplicated from "${String(widget.name).slice(0, 120)}"`,
  });
  res.status(201).json(redactWidgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id)));
});

// Get widget
router.get('/:id', (req, res) => {
  const widget = checkWidgetRead(req, res);
  if (!widget) return;
  res.json(redactWidgetRow(widget));
});

// Update widget
router.put('/:id', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  if (corpMediaRefused(req, res, widget)) return;

  const { name } = req.body;
  let { config } = req.body;
  if (config && typeof config === 'object' && !Array.isArray(config)) {
    config = mergeSecrets(config, storedWidgetConfig(widget), fieldsForWidget(widget.widget_type));
  }
  /*
   * ⚠️ A TEMPLATE WIDGET'S CONFIG IS RE-BUILT, NEVER STORED AS SENT. Its values are checked against
   * the installed template (types, the workspace's own images and data sources) and the template
   * key cannot be pointed at something else by editing the blob.
   */
  if (widget.widget_type === 'template' && config) {
    try {
      const stored = storedWidgetConfig(widget);
      config = require('../lib/templates/widget').buildConfig(stored.template, config.values, widget.workspace_id);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, param: e.param });
    }
  }
  const tzErr = validateTimezone(config);
  if (tzErr) return res.status(400).json({ error: tzErr });
  if (widget.widget_type === 'cloud-doc' && config) {
    const cd = cloudDocConfig(config);
    if (cd.error) return res.status(400).json({ error: cd.error });
    config = cd.config;
  }
  if (widget.widget_type === 'bi-dashboard' && config) {
    const bi = biConfigOrError(widget.workspace_id, config);
    if (bi.error) return res.status(400).json({ error: bi.error });
    config = bi.config;
  }
  if (widget.widget_type === 'social' && config) {
    const sw = socialConfigOrError(widget.workspace_id, config);
    if (sw.error) return res.status(400).json({ error: sw.error });
    config = sw.config;
  }
  const roomErr = config ? validateRoomDisplay(widget.widget_type, config, widget.workspace_id) : null;
  if (roomErr) return res.status(400).json({ error: roomErr });

  /*
   * Approval on: the edit becomes a DRAFT. Players keep rendering `config` (their rev is
   * updated_at, which does not move), the editor shows the draft, and the draft goes live only
   * through a reviewed submission (lib/releases.js releaseWidgetDraft). Approval off: in place,
   * exactly as before, plus a revision so history knows what was saved.
   */
  const policy = require('../lib/release-policy');
  const revisions = require('../lib/revisions');
  const actor = require('../lib/releases').actorOf(req);
  if (widget.workspace_id && policy.approvalRequired(db, widget.workspace_id)) {
    const current = revisions.parseJson(widget.draft_config, null) || { name: widget.name, config: JSON.parse(widget.config || '{}') };
    const draft = { name: name || current.name, config: config || current.config };
    db.prepare('UPDATE widgets SET draft_config = ? WHERE id = ?').run(JSON.stringify(draft), req.params.id);
    revisions.recordCurrent(db, 'widget', req.params.id, { actor, summary: 'Saved draft' });
    return res.json({ ...redactWidgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id)), draft: true, pending_review: true });
  }
  if (name) db.prepare('UPDATE widgets SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
  if (config) db.prepare('UPDATE widgets SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(JSON.stringify(config), req.params.id);
  revisions.recordCurrent(db, 'widget', req.params.id, { actor, summary: 'Saved' });

  // Push the change to any display currently showing this widget. Editing a widget used to
  // notify nothing at all: the render endpoint serves live config, but a player that already has
  // the widget on screen keeps its WebView (deliberately — re-navigating a widget every duration
  // is a visible flash and destroys widget state). With no push and no change to the URL, an edit
  // reached the screen only when the app was restarted. Reported on #234: "I changed the text and
  // the new text did not appear on the screen. I had to close the app and then open again."
  //
  // The push is what makes it prompt; the rev in the payload is what makes the player reload.
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      // ⚠️ Resolved AND nesting-aware — see lib/devices-playing.js. This joined on
      // devices.playlist_id, which is NULL for a screen that inherits, and looked only at the
      // top-level rows, so a widget inside a nested playlist matched nothing either. Both cases
      // meant an edited widget simply never reached those screens.
      for (const id of devicesPlayingWidget(req.params.id)) {
        commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
      }
    }
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }

  res.json(redactWidgetRow(db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id)));
});

/*
 * Mark a menu-board item sold out (or back on) without opening the editor: the button a manager
 * taps on a phone, or a till system calling the API when an item runs out.
 *
 * ⚠️ OPERATIONAL, SO IT GOES LIVE EVEN WHEN APPROVAL IS ON. "We are out of salmon" cannot wait for
 * a review, and it changes availability, not content. It is applied to the live config AND to a
 * pending draft (so publishing the draft later cannot undo it), recorded in history, and pushed to
 * the screens showing the menu. Items from a data source are changed in the sheet, not here.
 */
router.patch('/:id/menu-items/:itemId', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  if (widget.widget_type !== 'menu-board') return res.status(400).json({ error: 'Not a menu board' });
  if (typeof (req.body || {}).sold_out !== 'boolean') return res.status(400).json({ error: 'sold_out must be true or false' });
  const menu = require('../lib/menu-board');
  // The LIVE config, not storedWidgetConfig (which prefers a pending draft): writing a draft's
  // config back as live would publish an unreviewed edit along with the sold-out flag.
  let config;
  try { config = JSON.parse(widget.config || '{}'); } catch { config = {}; }
  if (config.source && config.source.slug) {
    return res.status(409).json({ error: 'This menu comes from a data source. Change the item there.', code: 'MENU_FROM_DATA_SOURCE' });
  }
  const item = menu.findItem(config, req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.sold_out = req.body.sold_out;
  db.transaction(() => {
    db.prepare("UPDATE widgets SET config = ?, updated_at = MAX(updated_at + 1, strftime('%s','now')) WHERE id = ?")
      .run(JSON.stringify(config), widget.id);
    if (widget.draft_config) {
      try {
        const draft = JSON.parse(widget.draft_config);
        const dItem = draft && menu.findItem(draft.config, req.params.itemId);
        if (dItem) { dItem.sold_out = req.body.sold_out; db.prepare('UPDATE widgets SET draft_config = ? WHERE id = ?').run(JSON.stringify(draft), widget.id); }
      } catch (_) { /* a draft we cannot read is left as it is */ }
    }
  })();
  require('../lib/revisions').recordCurrent(db, 'widget', widget.id, {
    actor: require('../lib/releases').actorOf(req),
    summary: `${req.body.sold_out ? 'Sold out' : 'Back on'}: ${String(item.name || '').slice(0, 80)}`,
  });
  try {
    const io = req.app.get('io');
    if (io) {
      const { buildPlaylistPayload } = require('../ws/deviceSocket');
      const commandQueue = require('../lib/command-queue');
      for (const id of devicesPlayingWidget(widget.id)) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), id, buildPlaylistPayload);
    }
  } catch (_) { /* best effort */ }
  res.json({ success: true, item: { id: item.id, name: item.name, sold_out: item.sold_out } });
});

/*
 * bi-dashboard config, validated as a whole at save time (lib/bi/widget.js). The connection must
 * belong to the widget's own organization — the id is a value an editor typed.
 */
function biConfigOrError(workspaceId, config) {
  try {
    const orgId = require('../lib/bi/connections').orgOfWorkspace(db, workspaceId);
    return { config: require('../lib/bi/widget').normaliseConfig(db, orgId, config) };
  } catch (e) {
    return { error: e.message };
  }
}

/*
 * social wall config (lib/social/widget.js): the feed must be one of the widget's own workspace's.
 */
function socialConfigOrError(workspaceId, config) {
  try { return { config: require('../lib/social/widget').normaliseConfig(db, workspaceId, config) }; }
  catch (e) { return { error: e.message }; }
}

/*
 * ⚠️ PUBLIC, LIKE /render: a wall's page is a null-origin frame and cannot carry a session. What
 * they hand out is what the wall shows anyway — its visible posts, and the images those posts use —
 * and both are bounded per widget.
 */
function liveSocialWidget(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!widget || widget.widget_type !== 'social') { res.status(404).json({ error: 'Not a social wall' }); return null; }
  let config = {};
  try { config = JSON.parse(widget.config || '{}'); } catch { config = {}; }
  return { widget, config };
}

router.get('/:id/social.json', (req, res) => {
  const got = liveSocialWidget(req, res);
  if (!got) return;
  res.setHeader('Cache-Control', 'no-store');
  if (biRateLimited(`soc:${got.widget.id}`, 60)) return res.status(429).json({ error: 'Too many requests' });
  res.json(require('../lib/social/widget').payload(db, got.widget, got.config));
});

router.get('/:id/social-media/:hash', (req, res) => {
  const got = liveSocialWidget(req, res);
  if (!got) return;
  const media = require('../lib/social/media');
  const hash = String(req.params.hash || '');
  if (!media.HASH_RE.test(hash)) return res.status(404).end();
  if (biRateLimited(`socimg:${got.widget.id}`, 600)) return res.status(429).end();
  // Only an image one of THIS wall's visible posts uses: this is not a general file server.
  const feedId = String(got.config.feed_id || '');
  const used = db.prepare(`SELECT 1 FROM social_posts p JOIN social_feeds f ON f.id = p.feed_id
      WHERE p.feed_id = ? AND f.workspace_id = ? AND p.status = 'approved' AND (p.author_avatar = ? OR p.media LIKE ?) LIMIT 1`)
    .get(feedId, got.widget.workspace_id, hash, `%"${hash}"%`);
  const m = used ? media.lookup(db, hash) : null;
  if (!m) return res.status(404).end();
  res.setHeader('Content-Type', m.mime);
  // Content-addressed by source URL; loaded by an opaque-origin page, so CORP must allow it.
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(m.file);
});

function liveBiWidget(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!widget || widget.widget_type !== 'bi-dashboard') { res.status(404).json({ error: 'Not a dashboard widget' }); return null; }
  let config = {};
  try { config = JSON.parse(widget.config || '{}'); } catch { config = {}; }
  return { widget, config };
}

/*
 * ⚠️ PUBLIC, LIKE /render (a screen's widget page is a null-origin frame and cannot carry a session),
 * so both of these are bounded: an address that leaks lets someone view the dashboard — as the screen
 * does — but not make this server hammer Grafana or mint tokens without limit.
 *
 * ⚠️ WHAT IS COUNTED IS WORK, NOT VIEWS. A cached image or embed token is served without counting:
 * a per-widget limit on every request meant a big fleet on one dashboard got 429s, and anyone with
 * a widget id could spend that budget and blank every screen showing it. Only a call that would
 * reach Grafana / Power BI (or mint a Tableau JWT) is counted, twice: per caller — the page holds no
 * identity, so that is the address it came from — and, more generously, per widget, which is the cap
 * on what one dashboard can cost upstream.
 */
const biLimiter = require('../lib/bounded-snapshot-store').createStore({ max: 20000, ttlMs: 60_000 });
function biRateLimited(key, max) {
  // A fixed one-minute window: the store expires an entry 60s after its receivedAt.
  const win = biLimiter.get(key) || { receivedAt: Date.now(), n: 0 };
  win.n += 1;
  biLimiter.set(key, win);
  return win.n > max;
}
const BI_LIMITS = {
  img: { caller: 30, widget: 120 },   // Grafana renders (cache misses only)
  pbi: { caller: 10, widget: 30 },    // Power BI GenerateToken (cache misses only; ~1/hour normally)
  tab: { caller: 60, widget: 1200 },  // Tableau JWTs: every call, but signing one is local and cheap
};
function biUpstreamAllowed(kind, req, widgetId) {
  const l = BI_LIMITS[kind];
  if (biRateLimited(`${kind}:${widgetId}:${req.ip || ''}`, l.caller)) return false;
  return !biRateLimited(`${kind}:${widgetId}`, l.widget);
}

// The latest Grafana render for a dashboard widget. The token never leaves this server.
router.get('/:id/bi-image.png', async (req, res) => {
  const got = liveBiWidget(req, res);
  if (!got) return;
  const { widget, config } = got;
  if (config.provider !== 'grafana' || config.mode === 'public') return res.status(404).json({ error: 'Not a Grafana image dashboard' });
  const conn = require('../lib/bi/connections').forWidget(db, widget, config);
  if (!conn || conn.kind !== 'grafana') return res.status(404).json({ error: 'No connection' });
  try {
    const grafana = require('../lib/bi/grafana');
    const img = await grafana.imageFor(widget.id, conn, grafana.normaliseWidgetConfig(config),
      { width: req.query.w, height: req.query.h },
      { refreshSec: config.refresh_sec, beforeFetch: () => biUpstreamAllowed('img', req, widget.id) });
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'private, max-age=30');
    // Loaded by the widget page, a sandboxed (opaque-origin) document: same-origin CORP blocks it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (img.stale) res.setHeader('X-Dashboard-Stale', '1');
    res.send(img.buf);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    if (e.status === 429) return res.status(429).json({ error: 'Too many requests' });
    console.warn(`[bi] grafana render for widget ${widget.id}: ${e.message}`);
    res.status(502).json({ error: 'The dashboard could not be rendered' });
  }
});

// A fresh Power BI embed token / Tableau JWT for a dashboard widget's page. Never a secret.
router.get('/:id/bi-token', async (req, res) => {
  const got = liveBiWidget(req, res);
  if (!got) return;
  const { widget, config } = got;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const kind = config.provider === 'tableau' ? 'tab' : 'pbi';
    res.json(await require('../lib/bi/widget').tokenFor(db, widget, config, { beforeFetch: () => biUpstreamAllowed(kind, req, widget.id) }));
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: e.message });
    if (e.status === 429) return res.status(429).json({ error: 'Too many requests' });
    console.warn(`[bi] token for widget ${widget.id}: ${e.message}`);
    res.status(502).json({ error: 'The dashboard service did not issue a token' });
  }
});

// Delete widget
router.delete('/:id', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  if (corpMediaRefused(req, res, widget)) return;
  db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

const KNOWN_WIDGET_TYPES = new Set(BUILTIN_WIDGET_TYPES);

/*
 * A cloud-doc's config is REBUILT from the pasted link (lib/cloud-docs.js), never stored as sent: the
 * stored URL is the one players frame with allow-same-origin, so it must be one we constructed on an
 * allowlisted provider host. Returns { config } or { error }.
 */
function cloudDocConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  try {
    const n = require('../lib/cloud-docs').normaliseCloudDoc(c.url, { delaySec: c.delay_sec, refreshMin: c.refresh_min });
    const zoom = Math.min(Math.max(Number(c.zoom) || 100, 25), 400);
    const background = /^#[0-9a-f]{3,8}$/i.test(c.background || '') ? c.background : '#000000';
    return { config: { ...n, zoom, background } };
  } catch (e) {
    return { error: e.message };
  }
}
function renderWidgetHtml(type, config, opts = {}) {
  const iframeSandbox = opts.iframeSandbox || 'allow-scripts';
  config = config || {};
  switch (type) {
    case 'clock': return renderClock(config);
    case 'weather': return renderWeather(config);
    case 'rss': return renderRSS(config);
    case 'text': return renderText(config, iframeSandbox);
    case 'webpage': return renderWebpage(config, iframeSandbox, opts.origin);
    // The embedded renderer passes the workspace and gets a self-contained snapshot; otherwise this is
    // the editor's Preview (a saved wall's /render is handled above).
    case 'social': return opts.workspaceId && config && config.feed_id
      ? require('../lib/social/widget').renderSnapshot(require('../db/database').db, opts.workspaceId, config)
      : require('../lib/social/widget').previewHtml(config);
    case 'directory-board': return renderDirectoryBoard(config);
    case 'menu-board': return require('../lib/menu-board').renderMenuBoard(config, {
      dataMap: config && config.source && config.source.slug && opts.workspaceId
        ? require('../lib/data-sources/service').getWorkspaceDataMapSync(opts.workspaceId) : null,
    });
    case 'directory-search': return renderDirectorySearch(config);
    case 'cloud-doc': return require('../lib/cloud-docs').renderCloudDoc(config);
    case 'diag-smoothness': return renderDiagSmoothness(config);
    // Only reached by the editor's Preview: a saved widget's /render is handled above.
    case 'bi-dashboard': return require('../lib/bi/widget').previewHtml(config);
    /*
     * ⚠️ THE ONLY WIDGET WHOSE CONTENT IS NOT BAKED INTO ITS CONFIG. A slide keeps its layout in
     * `config.template` and its words in `config.fields`, and they are joined here — which is what
     * makes it possible to come back and change a headline without rebuilding the layout, and
     * therefore what makes editing one later work at all. See lib/slide-render.js.
     */
    case 'slide': return slideRender.renderSlideHtml(config, {
      resolveImage: opts.resolveImage, resolveFont: opts.resolveFont,
      resolveData: opts.resolveData, dataSources: opts.dataSources,
    });
    default: {
      const plugin = pluginRegistry.getWidget(type);
      if (plugin) {
        try {
          const html = plugin.render(config, {
            escapeHtml,
            safeUrl,
            safeCss,
            safeNumber,
            now: opts.now || new Date(),
            workspaceId: opts.workspaceId || null,
            interpolate(text) {
              return slideRender.interpolateDataSources(String(text == null ? '' : text), opts.resolveData);
            },
            resolveImage: typeof opts.resolveImage === 'function' ? opts.resolveImage : () => null,
            log: (...args) => console.warn(`[plugin:${plugin.pluginId}]`, ...args),
          });
          if (typeof html === 'string' && html.length) return html;
        } catch (e) {
          console.warn(`[plugins] render failed for type "${type}":`, e.message);
        }
      }
      return '<html><body style="color:white;background:black;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>Unknown widget</h1></body></html>';
    }
  }
}

// The widget editor's Preview is framed by the DASHBOARD, from the dashboard's own
// origin, and the dashboard keeps its session JWT in localStorage. So preview HTML is
// pinned to the isolating sandbox and never consults the org setting: otherwise anyone
// who can author a widget (workspace_editor and up) could run script in the dashboard
// origin and lift the session of whichever admin clicked Preview.
//
// The org setting exists so PLAYERS can embed origin-strict third-party sites. A player
// runs on a kiosk with a device token, which is the risk the confirmation modal
// describes; an admin's dashboard session is not.
const PREVIEW_IFRAME_SANDBOX = 'allow-scripts';

function widgetIframeSandboxForWorkspace(workspaceId) {
  if (!workspaceId) return 'allow-scripts';
  try {
    const row = db.prepare(`
      SELECT COALESCE(o.widget_sandbox_isolation_disabled, 0) AS disabled
      FROM workspaces ws
      LEFT JOIN organizations o ON o.id = ws.organization_id
      WHERE ws.id = ?
    `).get(workspaceId);
    return Number(row?.disabled || 0) === 1
      ? 'allow-scripts allow-same-origin'
      : 'allow-scripts';
  } catch (_) {
    return 'allow-scripts';
  }
}

// Render widget as HTML page
router.get('/:id/render', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');
  const config = JSON.parse(widget.config || '{}');
  const iframeSandbox = widgetIframeSandboxForWorkspace(widget.workspace_id);
  // This page is DESIGNED to be embedded by the player, which frames it in a
  // sandboxed (allow-scripts, no allow-same-origin) iframe = a null origin. The
  // global helmet X-Frame-Options: SAMEORIGIN refuses that (null != same), so
  // widgets render blank in the web player. Drop it here; the sandbox - not
  // X-Frame-Options - is what isolates the widget (it can't read the dashboard JWT).
  res.removeHeader('X-Frame-Options');
  // Caching is keyed on whether the caller pinned a revision.
  //
  // A URL carrying ?rev=<widget.updated_at> is content-addressed: those exact bytes cannot change
  // without the rev changing, so it is safe to cache hard — and it NEEDS to be, because a player
  // that loses its network must still be able to render its widgets. Offline resilience is the
  // point of the player's cache, and no-store made widgets the one thing it could never keep.
  //
  // A URL with no rev is the old shape and stays uncacheable: nothing distinguishes one render
  // from the next, so a cached copy could serve content the operator has already changed.
  if (req.query.rev) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader('Content-Type', 'text/html');
  /*
   * ⚠️ A TEMPLATE CARRIES ITS OWN CONTENT-SECURITY-POLICY, and the `sandbox` in it is the part
   * that matters: it makes the document an opaque origin even when it is opened top-level (an
   * Android panel loads a fullscreen widget straight into its WebView, and an admin can click the
   * link). Without it an html template's code would run as this server's origin — the origin
   * whose localStorage holds the dashboard session. See lib/templates/render.js.
   */
  /*
   * An emergency feed's alert card: the feed's live alerts, rendered from text a third party wrote,
   * so it gets the same opaque-origin sandbox a template does (lib/cap/card.js escapes it all).
   */
  if (widget.widget_type === 'cap_alert') {
    const feeds = require('../lib/cap/feeds');
    const feed = config.feed_id ? db.prepare('SELECT * FROM cap_feeds WHERE id = ? AND workspace_id = ?').get(config.feed_id, widget.workspace_id) : null;
    const alerts = feed ? feeds.liveAlerts(db, feed) : [];
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; sandbox allow-scripts");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Rev-pinned like every widget, but private: a shared cache must not keep a cleared alert.
    if (req.query.rev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.send(require('../lib/cap/card').renderCard(alerts, { title: feed ? feed.name : 'Emergency alert' }));
  }
  /*
   * A cloud document runs NO script (lib/cloud-docs.js): that is what lets players frame it with
   * allow-same-origin, which Google's embed needs. The CSP is the guarantee, not a convention.
   */
  if (widget.widget_type === 'cloud-doc') {
    const cd = require('../lib/cloud-docs');
    res.setHeader('Content-Security-Policy', cd.RENDER_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(cd.renderCloudDoc(config));
  }
  /*
   * A Grafana / Power BI / Tableau dashboard (lib/bi/widget.js). Its page carries no token — those
   * come from /bi-image.png and /bi-token at run time — and sets its own CSP naming the one host it
   * may load from.
   */
  /*
   * A social wall (lib/social/widget.js). Posts travel as JSON and are drawn with textContent; the
   * CSP keeps images and data to this server, so a screen never talks to a social network.
   */
  if (widget.widget_type === 'social') {
    const out = require('../lib/social/widget').render(db, widget, config, { origin: `${req.protocol}://${req.get('host')}` });
    res.setHeader('Content-Security-Policy', out.csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.query.rev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.send(out.html);
  }
  if (widget.widget_type === 'bi-dashboard') {
    const out = require('../lib/bi/widget').render(db, widget, config, {
      origin: `${req.protocol}://${req.get('host')}`, iframeSandbox,
    });
    res.setHeader('Content-Security-Policy', out.csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.query.rev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.send(out.html);
  }
  /*
   * A meeting-room display (lib/rooms/render.js): meeting titles typed by anyone who can send an
   * invitation, so the same opaque-origin sandbox as the alert card, plus the one connection the page
   * needs — back to this server for its room's state. Rendered with the current state so the first
   * paint is right; the page then keeps itself current.
   */
  if (widget.widget_type === 'room-display') {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ${origin}; sandbox allow-scripts`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.query.rev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    const room = config.room_id ? db.prepare('SELECT * FROM rooms WHERE id = ? AND workspace_id = ?').get(String(config.room_id), widget.workspace_id) : null;
    const rooms = require('../lib/rooms/service');
    const { renderRoomDisplay } = require('../lib/rooms/render');
    return (room ? rooms.panelState(room) : Promise.resolve(null))
      .catch(() => null)
      .then((initial) => res.send(renderRoomDisplay({ widgetId: widget.id, origin, config, initial })));
  }
  if (widget.widget_type === 'template') {
    const out = require('../lib/templates/widget').renderTemplateWidget(widget, {
      origin: `${req.protocol}://${req.get('host')}`,
      resolveImage: imageResolverFor(widget),
      resolveFont: require('./fonts').fontResolverFor(widget),
      resolveData: dataResolverFor(widget),
    });
    res.setHeader('Content-Security-Policy', out.csp);
    // private, not public: a shared cache (a CDN in front of the server) must not keep serving a
    // template's old code after it is revoked. Players still cache the rev-pinned copy.
    if (req.query.rev) res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.send(out.html);
  }
  res.send(renderWidgetHtml(widget.widget_type, config, {
    iframeSandbox,
    origin: `${req.protocol}://${req.get('host')}`,
    resolveImage: imageResolverFor(widget),
    resolveFont: require('./fonts').fontResolverFor(widget),
    resolveData: dataResolverFor(widget),
    workspaceId: widget.workspace_id,
  }));
});

/*
 * Data source dynamic variable resolver scoped to the widget's workspace.
 */
function dataResolverFor(widgetOrWorkspaceId) {
  const wsId = typeof widgetOrWorkspaceId === 'string' ? widgetOrWorkspaceId : (widgetOrWorkspaceId?.workspace_id || null);
  if (!wsId) return () => null;
  let dataMap = null;
  let loaded = false;
  return (slug, key) => {
    try {
      if (!loaded) {
        dataMap = require('../lib/data-sources/service').getWorkspaceDataMapSync(wsId);
        loaded = true;
      }
      const dsData = dataMap ? (dataMap[slug] || dataMap[slug.toLowerCase()]) : null;
      if (dsData && dsData[key] !== undefined && dsData[key] !== null) {
        return dsData[key];
      }
    } catch (_) {}
    return null;
  };
}

/*
 * Turn a slide's `content_id` into a URL, or into nothing.
 *
 * ⚠️ SCOPED TO THE WIDGET'S OWN WORKSPACE, AND THAT IS THE WHOLE JOB. The id comes out of a config
 * blob that a workspace editor authored, so it is a value a user typed — nothing stops somebody
 * pasting an id belonging to another tenant, and a resolver that simply looked up the row would
 * then embed another customer's photo in their slide and serve it from this origin. Read as: a
 * slide may only ever show media its own workspace already owns.
 *
 * A widget with no workspace is a PLATFORM TEMPLATE (see checkWidgetRead), so it is held to the
 * matching rule — platform content only — rather than being treated as unscoped.
 */
function imageResolverFor(widget) {
  return (contentId) => {
    if (!contentId) return null;
    try {
      const row = widget.workspace_id
        ? db.prepare('SELECT filepath, remote_url FROM content WHERE id = ? AND workspace_id = ?')
            .get(contentId, widget.workspace_id)
        : db.prepare('SELECT filepath, remote_url FROM content WHERE id = ? AND workspace_id IS NULL')
            .get(contentId);
      if (!row) return null;
      // remote_url content is a URL the operator supplied and the player already fetches directly;
      // an uploaded file is served from this origin. Either way the slide references, never inlines
      // — the designer's base64 habit is how one widget config in the wild reached 2.71 MB.
      if (row.remote_url) return row.remote_url;
      return row.filepath ? `/uploads/content/${encodeURIComponent(row.filepath)}` : null;
    } catch (e) {
      return null;
    }
  };
}

// Public JSON feed of a directory board's entries. A directory-search page polls
// this to reflect board edits without a reload. It exposes only the same data
// already public via /render, and is CORS-open so a null-origin sandboxed widget
// iframe can read it. 404 (not empty) on a missing/wrong-type source so the
// polling page keeps its last-good data instead of blanking on a transient miss.
router.get('/:id/data.json', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget || widget.widget_type !== 'directory-board') return res.status(404).json({ error: 'Not a directory board' });
  let categories = [];
  try {
    const cfg = JSON.parse(widget.config || '{}');
    categories = Array.isArray(cfg.categories) ? cfg.categories : [];
  } catch (e) { categories = []; }
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ categories });
});

// Latest frame-rate telemetry per widget, reported by the diag-smoothness widget running on a device.
// In-memory (diagnostic, not persisted) — a device page reads the snapshot for the widget it plays.
//
// BOUNDED, because the writer is unauthenticated (the widget runs in a null-origin sandboxed
// iframe and cannot carry a session) and the key comes from the request body. An uncapped map
// keyed on caller-supplied values is a remote memory-exhaustion path, and on this product a dead
// server means the whole fleet reconnects at once.
//
// The cap is GLOBAL rather than per-IP on purpose: signage sites egress through one NAT address,
// so a per-IP limit would punish an entire venue for one noisy panel while doing nothing about a
// distributed writer. Same reasoning as lib/ota-download-guard ("NEVER per-IP (SNAT)"). Eviction
// is least-recently-written, and a live panel rewrites its key every 2.5s, so only entries the
// dashboard would already call stale (>15s) are ever eligible.
const widgetTelemetry = require('../lib/bounded-snapshot-store').createStore({ max: 500, ttlMs: 60_000 });
widgetTelemetry.startSweep();
// Public POST from the widget: it runs in a null-origin sandboxed iframe, so this must be no-auth +
// CORS-open. The widget sends text/plain (a "simple" request → no CORS preflight); we JSON.parse it.
router.post('/:id/telemetry', express.text({ type: '*/*', limit: '16kb' }), (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let t = {};
  try { t = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) { t = {}; }
  t.receivedAt = Date.now();
  // Key by the reporting device (player passes ?device=<id>) so multiple panels don't collide;
  // fall back to a widget-scoped key for players that don't pass a device id yet.
  const key = (t.device && String(t.device).slice(0, 64)) || ('w:' + req.params.id);
  widgetTelemetry.set(key, t);
  // 204, not res.json(): this is fire-and-forget diagnostic data and the reporting widget ignores
  // the response entirely (routes/widgets.js renderDiagSmoothness -> fetch(...).catch()). It also
  // keeps services/activity.js activityLogger — which wraps res.json — from writing an activity_log
  // row per unauthenticated report, i.e. from letting an anonymous caller grow a DB table.
  res.status(204).end();
});
// Public GET so the dashboard device page can display the snapshot. ?device=<id> reads that panel's
// report; without it (or if that panel hasn't reported) falls back to the widget-scoped snapshot.
router.get('/:id/telemetry', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const dev = req.query.device ? String(req.query.device) : null;
  // Device-scoped request returns ONLY that device's report — NO widget-wide fallback, or one
  // reporting panel's data would show on every other device's page (incl. offline ones). A request
  // with no device id gets the widget-scoped snapshot (raw/debug view only).
  // get() returns null for a missing OR expired entry, so a stale snapshot is never served
  // as live even between sweeps.
  const rec = dev ? widgetTelemetry.get(dev) : widgetTelemetry.get('w:' + req.params.id);
  res.json(rec || null);
});

// What a pasted cloud document link resolves to, for the editor (no side effects; the save re-checks).
router.post('/cloud-doc/check', (req, res) => {
  const cd = cloudDocConfig(req.body || {});
  if (cd.error) return res.status(400).json({ error: cd.error });
  res.json(cd.config);
});

// Preview unsaved widget from config (used by editor Preview button)
router.post('/preview', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type) && !pluginRegistry.hasWidget(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  // Preview renders inside the DASHBOARD origin, so it never opts into same-origin —
  // see PREVIEW_IFRAME_SANDBOX.
  const resolveData = dataResolverFor(req.workspaceId);
  const resolveFont = req.workspaceId ? require('./fonts').fontResolverFor({ workspace_id: req.workspaceId }) : undefined;
  let html = renderWidgetHtml(widget_type, config || {}, {
    iframeSandbox: PREVIEW_IFRAME_SANDBOX,
    resolveData,
    resolveFont,
  });
  if (req.workspaceId) html = inlineUserContent(html, req.workspaceId);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Preview sessions — ephemeral store so the preview iframe loads via src (not srcdoc)
// and bypasses the dashboard CSP that would block the widget's inline scripts.
const previewStore = new Map();
const PREVIEW_TTL = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of previewStore) {
    if (now - entry.created > PREVIEW_TTL) previewStore.delete(key);
  }
}, 60 * 1000).unref();

router.post('/preview-session', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type) && !pluginRegistry.hasWidget(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  const id = uuidv4();
  // Same reasoning as /preview — dashboard origin, never same-origin.
  const resolveData = dataResolverFor(req.workspaceId);
  const resolveFont = req.workspaceId ? require('./fonts').fontResolverFor({ workspace_id: req.workspaceId }) : undefined;
  const html = renderWidgetHtml(widget_type, config || {}, {
    iframeSandbox: PREVIEW_IFRAME_SANDBOX,
    resolveData,
    resolveFont,
  });
  previewStore.set(id, { html, widget_type, created: Date.now() });
  res.json({ id, url: `/api/widgets/preview-session/${id}` });
});

router.get('/preview-session/:id', (req, res) => {
  const entry = previewStore.get(req.params.id);
  if (!entry) return res.status(410).send('Preview expired');
  if (Date.now() - entry.created > PREVIEW_TTL) {
    previewStore.delete(req.params.id);
    return res.status(410).send('Preview expired');
  }
  let html = entry.html;
  if (req.workspaceId) html = inlineUserContent(html, req.workspaceId);
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html');
  // The editor previews a cloud document with allow-same-origin (as players do); script-free by CSP.
  if (entry.widget_type === 'cloud-doc') res.setHeader('Content-Security-Policy', require('../lib/cloud-docs').RENDER_CSP);
  res.send(html);
});

function renderClock(c) {
  const datePosition = clockDatePosition(c.date_position);
  const dateFirst = datePosition === 'above' || datePosition === 'left';
  const row = datePosition === 'left' || datePosition === 'right';
  const dateMargin = row
    ? (dateFirst ? 'margin-right:8px;' : 'margin-left:8px;')
    : (dateFirst ? 'margin-bottom:8px;' : 'margin-top:8px;');
  const dateHtml = c.show_date !== false ? '<div id="date"></div>' : '';
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, 'transparent')}; display:flex; flex-direction:${row ? 'row' : 'column'}; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; overflow:hidden; }
  #time { font-size:${safeNumber(c.font_size, 64)}px; font-weight:700; color:${safeCss(c.color, '#FFFFFF')}; }
  #date { font-size:${Math.max(8, safeNumber(c.date_font_size, Math.max(16, safeNumber(c.font_size, 64) / 3)))}px; color:${safeCss(c.date_color, safeCss(c.color, '#FFFFFF'))}; opacity:${c.date_color ? 1 : 0.7}; ${dateMargin} }
</style></head><body>
${dateFirst ? dateHtml : ''}
<div id="time"></div>
${dateFirst ? '' : dateHtml}
<script>
function update() {
  // show_seconds defaults TRUE so existing widgets keep the clock they already had (#323).
  const opts = { hour12: ${c.format !== '24h'}, timeZone: '${safeTimezone(c.timezone)}', hour:'2-digit', minute:'2-digit'${c.show_seconds === false ? '' : ", second:'2-digit'"} };
  document.getElementById('time').textContent = new Date().toLocaleTimeString(${safeLocale(c.locale)}, opts);
  ${c.show_date !== false ? `document.getElementById('date').textContent = new Date().toLocaleDateString(${safeLocale(c.locale)}, { timeZone: '${safeTimezone(c.timezone)}', ${clockDateFormat(c.date_format)} });` : ''}
}
setInterval(update, 1000); update();
</script></body></html>`;
}

function renderWeather(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, 'transparent')}; display:flex; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; color:${safeCss(c.color, '#FFF')}; }
  /*
   * #324: EVERYTHING SCALES, OR NOTHING DOES.
   *
   * Only .temp was tied to font_size; location, description and icon were pinned at 18px, 16px
   * and 64px. In a small zone the icon alone is 64px whatever the space, the content overflows,
   * and the widget gets a scrollbar - reported as "the font size does change, but nothing else".
   * No Fit setting could help, because Fit places the widget's output rather than laying it out.
   * The other three are derived from the same base size now, so one control moves all of them.
   */
  .weather { text-align:center; max-width:100%; max-height:100%; }
  .temp { font-size:${safeNumber(c.font_size, 48)}px; font-weight:700; line-height:1.1; }
  .location { font-size:${Math.max(10, Math.round(safeNumber(c.font_size, 48) * 0.34))}px; opacity:0.7; margin-top:2px; }
  .desc { font-size:${Math.max(10, Math.round(safeNumber(c.font_size, 48) * 0.30))}px; opacity:0.6; margin-top:4px; }
  .icon { font-size:${Math.max(14, Math.round(safeNumber(c.font_size, 48) * 1.2))}px; line-height:1; }
  /* A signage widget must never offer a scrollbar. If it still does not fit, it clips. */
  html, body { overflow:hidden; }
  body.horizontal .weather { display:flex; align-items:center; justify-content:center; text-align:left; }
  body.horizontal .weather > * + * { margin-left:${Math.max(6, Math.round(safeNumber(c.font_size, 48) * 0.25))}px; }
</style></head><body class="${c.layout === 'horizontal' ? 'horizontal' : ''}">
<div class="weather">
  <div class="icon" id="icon"></div>
  <div>
    <div class="temp" id="temp">--</div>
    ${c.show_location === false ? '' : `<div class="location">${escapeHtml(c.location) || 'Unknown'}</div>`}
    <div class="desc" id="desc"></div>
  </div>
</div>
<script>
async function load() {
  try {
    // #324: wttr.in accepts lang=, so "Sunny" can arrive in the operator's language rather than
    // always English. Same locale field the clock gained in #323; blank leaves wttr.in's default.
    const r = await fetch('https://wttr.in/${encodeURIComponent(c.location || 'New York')}?format=j1${/^[A-Za-z]{2}$/.test(String(c.locale || '').slice(0, 2)) ? '&lang=' + String(c.locale).slice(0, 2).toLowerCase() : ''}');
    const d = await r.json();
    const cur = d.current_condition[0];
    const unit = '${c.units === 'metric' ? 'temp_C' : 'temp_F'}';
    const deg = '${c.units === 'metric' ? '°C' : '°F'}';
    document.getElementById('temp').textContent = cur[unit] + deg;
    // With lang=, wttr.in returns localised text under lang_<code>; fall back to English.
    const langKey = Object.keys(cur).find((k) => k.startsWith('lang_'));
    document.getElementById('desc').textContent =
      (langKey && cur[langKey] && cur[langKey][0] && cur[langKey][0].value) || cur.weatherDesc[0].value;
    const code = parseInt(cur.weatherCode);
    const icons = {113:'☀️',116:'⛅',119:'☁️',122:'☁️',143:'🌫️',176:'🌧️',200:'⛈️',227:'🌨️',260:'🌫️',263:'🌧️',266:'🌧️',293:'🌧️',296:'🌧️',299:'🌧️',302:'🌧️',305:'🌧️',308:'🌧️',311:'🌧️',314:'🌧️',317:'🌧️',320:'🌨️',323:'🌨️',326:'🌨️',329:'🌨️',332:'🌨️',335:'🌨️',338:'🌨️',350:'🌧️',353:'🌧️',356:'🌧️',359:'🌧️',362:'🌨️',365:'🌨️',368:'🌨️',371:'🌨️',374:'🌨️',377:'🌨️',386:'⛈️',389:'⛈️',392:'⛈️',395:'🌨️'};
    document.getElementById('icon').textContent = icons[code] || '🌡️';
  } catch(e) { document.getElementById('desc').textContent = 'Weather unavailable'; }
}
load(); setInterval(load, 600000);
</script></body></html>`;
}

function renderRSS(c) {
  // scroll_speed is authored in the UI as "seconds" (legacy field), but that used to be wired
  // straight into animation-duration: a *fixed total time* for the whole strip to cross the
  // screen. That makes the on-screen speed depend on how much content there is - a feed with
  // many items gets dragged through in the same {scroll_speed}s as a feed with one, so it
  // flies past far too fast, never lets the reader finish, and simply "jumps back to the
  // start" once the fixed duration is up. Instead we treat scroll_speed as calibrating a
  // constant px/sec rate (using one viewport-width per scroll_speed seconds as the reference,
  // matching prior behaviour for content that fits in one screen), then measure the actual
  // rendered width of the ticker and derive a duration long enough to move that full distance
  // at the same constant speed - so more items simply take proportionally longer, and every
  // item scrolls fully into and out of view before the loop restarts.
  const scrollSpeedSec = safeNumber(c.scroll_speed, 30);
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, '#000')}; height:100vh; overflow:hidden; font-family:-apple-system,sans-serif; }
  .ticker { display:flex; align-items:center; height:100%; white-space:nowrap; position:relative; will-change:transform; }
  .item { display:inline-block; padding:0 40px; font-size:${safeNumber(c.font_size, 24)}px; color:${safeCss(c.color, '#FFF')}; }
  .item .title { font-weight:600; }
  .item .sep { margin:0 20px; opacity:0.3; }
</style></head><body>
<div class="ticker" id="ticker"><div class="item">Loading feed...</div></div>
<script>
var SCROLL_SPEED_SEC = ${scrollSpeedSec};
var ticker = document.getElementById('ticker');
var anim = null;
function restartAnimation() {
  if (anim) { anim.cancel(); anim = null; }
  var viewportW = window.innerWidth;
  var tickerW = ticker.scrollWidth;
  // Reference speed: one viewport-width travelled every SCROLL_SPEED_SEC seconds, so the
  // default of 30s behaves the same as before for a feed that fits within one screen.
  var pxPerSec = viewportW / SCROLL_SPEED_SEC;
  var distance = viewportW + tickerW; // starts fully off-screen right, ends fully off-screen left
  var durationMs = Math.max(1000, (distance / pxPerSec) * 1000);
  anim = ticker.animate(
    [
      { transform: 'translateX(' + viewportW + 'px)' },
      { transform: 'translateX(-' + tickerW + 'px)' },
    ],
    { duration: durationMs, iterations: Infinity, easing: 'linear' }
  );
}
async function load() {
  try {
    const r = await fetch('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('${escapeHtml(c.feed_url) || ''}'));
    const d = await r.json();
    const items = d.items?.slice(0, ${safeNumber(c.max_items, 10)}) || [];
    // NOTE: RSS feed titles are external content - using textContent instead of innerHTML to prevent XSS
    ticker.innerHTML = items.map(i => {
      const el = document.createElement('span'); el.textContent = i.title;
      return '<div class="item"><span class="title">' + el.innerHTML + '</span></div><div class="item sep">•</div>';
    }).join('') || '<div class="item">No items</div>';
  } catch(e) { ticker.innerHTML = '<div class="item">Feed unavailable</div>'; }
  requestAnimationFrame(restartAnimation);
}
window.addEventListener('resize', restartAnimation);
load(); setInterval(load, 300000);
</script></body></html>`;
}

function renderText(c, iframeSandbox = 'allow-scripts') {
  let html = c.html || '<p style="color:white;padding:20px">Empty text widget</p>';

  // LEGACY DESIGNER RESCUE — deliberately narrow.
  //
  // The Content Designer used to publish absolute font sizes as fontSize*10.8 px; today it emits
  // cqw (see designer.js). Converting px/108 back to vw restores the author's intended size and
  // makes those old widgets scale to any screen.
  //
  // It must NOT touch hand-authored HTML. This regex used to run over EVERY text widget, so
  // someone writing `font-size:16px` in the Text/HTML editor got 0.15vw — 2.8px on a 1080p
  // screen, and smaller still on anything narrower. Their text was not clipped or hidden; it was
  // rendered too small to read, in the one widget whose whole purpose is hand-written HTML.
  //
  // Designer output is identified by its absolutely-positioned elements, the same signal the
  // dashboard uses to decide whether a text widget can be reopened in the designer. Hand-written
  // markup keeps its px exactly as typed.
  const isDesignerAuthored = /position:\s*absolute;\s*left:/.test(html);
  if (isDesignerAuthored) {
    html = html.replace(/font-size:\s*([\d.]+)px/g, (match, px) => {
      return `font-size:${(parseFloat(px) / 108).toFixed(2)}vw`;
    });
  }

  // What to do when the text is taller than the screen. It used to be clipped in silence: the
  // document was overflow:hidden with no scrollbar and nothing to scroll it, so on a display
  // shorter than the content the bottom simply vanished — reported as "text goes to bottom and
  // disappears. It dont fit."
  //
  //   fit    (default) shrink until it fits. A no-op when the content already fits, so this
  //          rescues widgets that are currently losing text without altering ones that are fine.
  //   scroll pan through it on a loop, with a pause at each end. For content that is genuinely
  //          longer than a screen, where shrinking it would make it unreadable.
  //   clip   the old behaviour, kept because a designer-positioned layout may deliberately run
  //          past the edge and must not be rescaled underneath the author.
  const overflowMode = ['fit', 'scroll', 'clip'].includes(c.overflow) ? c.overflow : 'fit';

  // Runs inside the sandboxed iframe (allow-scripts, null origin). Measures after layout, after
  // web fonts settle, and on resize — a rotation or a resized zone changes the answer, and fonts
  // loading late is the classic cause of a fit that was computed against the wrong height.
  const fitScript = overflowMode === 'clip' ? '' : `<script>
  (function () {
    var mode = ${JSON.stringify(overflowMode)};
    var wrap = document.getElementById('st-wrap');
    if (!wrap) return;
    var anim = null;
    function apply() {
      // Reset before measuring, or we measure the previous transform's result.
      wrap.style.transform = '';
      if (anim) { anim.cancel(); anim = null; }
      var avail = document.documentElement.clientHeight;
      var need = wrap.scrollHeight;
      if (!avail || !need || need <= avail + 1) return;   // already fits: leave it alone
      if (mode === 'fit') {
        var k = avail / need;
        wrap.style.transformOrigin = 'top center';
        wrap.style.transform = 'scale(' + k + ')';
        return;
      }
      // scroll: hold, pan the overflow, hold, return. Speed is distance-based so a long
      // document is not unreadably fast and a short one is not tediously slow.
      var over = need - avail;
      var panMs = Math.max(4000, (over / 40) * 1000);
      var holdMs = 2000;
      var total = panMs * 2 + holdMs * 2;
      var p1 = holdMs / total, p2 = (holdMs + panMs) / total, p3 = (holdMs * 2 + panMs) / total;
      anim = wrap.animate(
        [
          { transform: 'translateY(0)', offset: 0 },
          { transform: 'translateY(0)', offset: p1 },
          { transform: 'translateY(' + (-over) + 'px)', offset: p2 },
          { transform: 'translateY(' + (-over) + 'px)', offset: p3 },
          { transform: 'translateY(0)', offset: 1 },
        ],
        { duration: total, iterations: Infinity, easing: 'linear' }
      );
    }
    addEventListener('resize', apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(function(){});
    // Late images change the height too; rAF lets first layout finish before measuring.
    addEventListener('load', function () { requestAnimationFrame(apply); });
    requestAnimationFrame(apply);
  })();
  </script>`;

  // Security: c.html / c.css are intentionally raw user-authored content, but the
  // render is public and same-origin with the dashboard - injected <script> could
  // otherwise read the dashboard's localStorage JWT. Render the user content inside
  // a sandboxed iframe with NO allow-same-origin: scripts still run (so legit
  // widget markup works) but in a null origin that can't touch the app's storage.
  const inner = `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100vw; height:100vh; overflow:hidden; }
  /* The wrapper is what gets scaled or panned. It must be allowed to exceed the viewport,
     otherwise there is nothing to measure and nothing to move. */
  #st-wrap { width:100%; min-height:100%; will-change:transform; }
  ${c.css || ''}
</style></head><body><div id="st-wrap">${html}</div>${fitScript}</body></html>`;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100vw; height:100vh; overflow:hidden; background:${safeCss(c.background, 'transparent')}; }
  iframe { width:100%; height:100%; border:0; display:block; }
</style></head><body><iframe sandbox="${escapeHtml(iframeSandbox)}" srcdoc="${escapeHtml(inner)}"></iframe></body></html>`;
}

function renderWebpage(c, iframeSandbox = 'allow-scripts', origin) {
  const zoom = (c.zoom || 100) / 100;
  const invZoom = 100 / (c.zoom || 100) * 100;
  const kioskPath = typeof c.url === 'string' && /^\/api\/kiosk\/[a-f0-9-]+\/render(?:\?|$)/i.test(c.url);
  let url = kioskPath ? c.url : safeUrl(c.url);
  // Older kiosk assignments saved the dashboard's absolute origin. When the dashboard was
  // opened at localhost, that origin points at the display itself. Kiosk renders are served by
  // this widget's origin, so only rewrite that known-bad generated URL.
  try {
    const parsed = new URL(url);
    if (['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
        /^\/api\/kiosk\/[a-f0-9-]+\/render$/i.test(parsed.pathname)) {
      const path = parsed.pathname + parsed.search;
      url = origin ? new URL(path, origin).toString() : path;
    }
  } catch (_) { /* safeUrl already reduced invalid input to about:blank */ }
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; } body { height:100vh; overflow:hidden; }
  iframe { width:${invZoom}%; height:${invZoom}%; border:0; transform:scale(${zoom}); transform-origin:0 0; }
</style></head><body>
<iframe src="${escapeHtml(url)}" sandbox="${escapeHtml(iframeSandbox)}"></iframe>
${c.refresh_interval > 0 ? `<script>setInterval(()=>document.querySelector('iframe').src=document.querySelector('iframe').src,${c.refresh_interval * 1000});</script>` : ''}
</body></html>`;
}

// Directory Board — lobby tenant directory with scrolling content, header/footer,
// rotating background images, and anti-burn-in motion (pixel shift, bg pulse).
// All user-supplied strings are rendered via textContent in-browser, not inlined
// into HTML, so no server-side HTML escaping is needed for entries/categories.
function renderDirectoryBoard(c) {
  const configJson = JSON.stringify(c || {}).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Directory</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; overflow:hidden; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:#fff;
    background:#1a1a2e;
    animation: bg-pulse 60s ease-in-out infinite;
  }
  body.light { color:#1a1a2e; background:#f5f5f5; animation: bg-pulse-light 60s ease-in-out infinite; }
  @keyframes bg-pulse { 0%,100% { background:#1a1a2e; } 50% { background:#1b1b30; } }
  @keyframes bg-pulse-light { 0%,100% { background:#f5f5f5; } 50% { background:#ededf0; } }

  .page { position:fixed; top:0; right:0; bottom:0; left:0; overflow:hidden; transition: transform 1.5s ease; will-change: transform; }

  .bg-layer { position:absolute; top:0; right:0; bottom:0; left:0; z-index:0; }
  .bg-img { position:absolute; top:0; right:0; bottom:0; left:0; width:100%; height:100%; object-fit:cover; opacity:0; transition: opacity 2s ease-in-out; }
  .bg-img.active { opacity:0.30; }

  .header {
    position:absolute; top:0; left:0; right:0; z-index:2;
    padding:32px 48px 24px; text-align:center;
    background: linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0));
  }
  body.light .header { background: linear-gradient(to bottom, rgba(255,255,255,0.75), rgba(255,255,255,0)); }
  .header img.logo { max-height:160px; max-width:440px; object-fit:contain; margin-bottom:16px; }
  .header h1 { font-size:72px; font-weight:600; letter-spacing:0.02em; }

  .footer {
    position:absolute; bottom:0; left:0; right:0; z-index:2;
    padding:22px 48px; text-align:center;
    background: linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0));
    font-size:28px; color:#fff; line-height:1.3;
  }
  body.light .footer { color:#1a1a2e; background: linear-gradient(to top, rgba(255,255,255,0.85), rgba(255,255,255,0)); }

  .scroller {
    position:absolute; left:0; right:0; z-index:1;
    overflow:hidden;
    mask-image: linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
  }
  .track { position:absolute; top:0; left:0; right:0; }

  .category { padding:36px 0 16px; }
  .category h2 {
    text-align:center;
    font-size:52px;
    font-weight:500;
    letter-spacing:0.08em;
    text-transform:uppercase;
    opacity:0.9;
    padding-bottom:14px;
    border-bottom: 1px solid rgba(255,255,255,0.15);
    margin-bottom:22px;
  }
  body.light .category h2 { border-bottom-color: rgba(0,0,0,0.12); }

  /* grid-gap is deliberate: display:grid is itself Chromium 57, so on a Chrome 53 panel this
     element is an inert block and the gap can never apply. Removing it only cost modern
     multi-column boards their 36px gutter. See the row-gap note below. */
  .entries { display:grid; gap:14px 36px; }
  .entries[data-cols="auto"] { grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); }
  .entries[data-cols="1"] { grid-template-columns: 1fr; }
  .entries[data-cols="2"] { grid-template-columns: repeat(2, 1fr); }
  .entries[data-cols="3"] { grid-template-columns: repeat(3, 1fr); }
  .entries[data-cols="4"] { grid-template-columns: repeat(4, 1fr); }

  /* Row gap for engines with no grid support, where .entries lays out as a plain block.
     @supports is Chromium 28, so a real grid engine zeroes this and uses the gap above rather
     than double-spacing rows and trailing a margin after the last one. */
  .entry { font-size:38px; line-height:1.35; color:#fff; display:flex; align-items:baseline; margin-bottom:14px; }
  @supports (display:grid) { .entry { margin-bottom:0; } }
  .entry .id { font-weight:600; min-width:3.5em; flex-shrink:0; margin-right:14px; }
  .entry .text { display:flex; flex-direction:column; flex:1; min-width:0; }
  .entry .nm { font-weight:400; }
  .entry .sub { font-size:0.55em; opacity:0.65; margin-top:4px; line-height:1.3; font-weight:400; }
  .entry.available { color:#00ff00; }
  .entry.available .id { color:#00ff00; }
  body.light .entry { color:#1a1a2e; }
  body.light .entry.available, body.light .entry.available .id { color:#059669; }

  @media (max-width: 1280px) {
    .header h1 { font-size:54px; }
    .header img.logo { max-height:120px; }
    .category h2 { font-size:40px; }
    .entry { font-size:28px; }
    .footer { font-size:22px; padding:16px 32px; }
    .entries[data-cols="auto"] { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
  }
</style>
</head>
<body>
  <div class="page" id="page">
    <div class="bg-layer" id="bgLayer"></div>
    <header class="header" id="header"></header>
    <div class="scroller" id="scroller">
    </div>
    <footer class="footer" id="footer"></footer>
  </div>

<script>
(function(){
  var cfg = ${configJson};
  var SPEEDS = { slow: 20, medium: 45, fast: 75 };

  if (cfg.theme === 'light') document.body.classList.add('light');
  var GAP_PX = 120; // blank space between the end of the directory and where it repeats (loop seam)
  var MIN_SCROLL_PX_SEC = 5; // anti-burn-in minimum when content fits
  var REFRESH_MS = 60000;    // poll data.json this often; re-render ONLY when entries changed

  // ----- header -----
  var header = document.getElementById('header');
  function safeImgUrl(u) {
    return typeof u === 'string' && (u.indexOf('/') === 0 || /^https?:\\/\\//.test(u) || /^data:image\\//.test(u)) ? u : '';
  }
  var logoSrc = safeImgUrl(cfg.logo_url);
  if (logoSrc) {
    var img = document.createElement('img');
    img.className = 'logo';
    img.src = logoSrc;
    img.alt = '';
    header.appendChild(img);
  }
  // A logo replaces the title text — showing both stacks the wordmark over the name.
  if (cfg.title && !logoSrc) {
    var h1 = document.createElement('h1');
    h1.textContent = cfg.title;
    header.appendChild(h1);
  }

  // ----- footer -----
  var footer = document.getElementById('footer');
  footer.textContent = cfg.footer_text || '';

  // ----- background images crossfade -----
  var bgLayer = document.getElementById('bgLayer');
  var bgs = Array.isArray(cfg.background_images) ? cfg.background_images.map(safeImgUrl).filter(Boolean) : [];
  var bgEls = [];
  bgs.forEach(function(url){
    var el = document.createElement('img');
    el.className = 'bg-img';
    el.src = url;
    el.alt = '';
    bgLayer.appendChild(el);
    bgEls.push(el);
  });
  if (bgEls.length > 0) {
    bgEls[0].classList.add('active');
    if (bgEls.length > 1) {
      var idx = 0;
      setInterval(function(){
        bgEls[idx].classList.remove('active');
        idx = (idx + 1) % bgEls.length;
        bgEls[idx].classList.add('active');
      }, 15000);
    }
  }

  // ----- layout the scroller between header and footer -----
  var scroller = document.getElementById('scroller');
  function layoutScroller() {
    var headerH = header.getBoundingClientRect().height;
    var footerH = footer.getBoundingClientRect().height;
    scroller.style.top = headerH + 'px';
    scroller.style.bottom = footerH + 'px';
  }
  layoutScroller();
  window.addEventListener('resize', layoutScroller);

  // ----- build directory content -----
  var cols = cfg.columns || 'auto';
  if (['auto','1','2','3','4'].indexOf(String(cols)) === -1) cols = 'auto';

  function buildCategoryEl(cat) {
    var catEl = document.createElement('div');
    catEl.className = 'category';
    var h2 = document.createElement('h2');
    h2.textContent = cat.name || '';
    catEl.appendChild(h2);
    var entries = document.createElement('div');
    entries.className = 'entries';
    entries.setAttribute('data-cols', String(cols));
    (cat.entries || []).forEach(function(e){
      var row = document.createElement('div');
      row.className = 'entry' + (e.available ? ' available' : '');
      var id = document.createElement('span');
      id.className = 'id';
      id.textContent = (e.identifier || '') + ':';
      var text = document.createElement('div');
      text.className = 'text';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = e.name || '';
      text.appendChild(nm);
      if (e.subtitle) {
        var sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = e.subtitle;
        text.appendChild(sub);
      }
      row.appendChild(id);
      row.appendChild(text);
      entries.appendChild(row);
    });
    catEl.appendChild(entries);
    return catEl;
  }

  var stage = scroller; // the clip window between header & footer
  var N = 4;            // panels in the ring (2 tile the screen, 1 dwells below, 1 above)
  var baseStyle = document.createElement('style');
  baseStyle.textContent =
    '.panel{ position:absolute; left:0; right:0; top:0; overflow:hidden; contain:paint; will-change:transform; backface-visibility:hidden; }' +
    '.pcontent{ position:absolute; left:0; right:0; top:0; padding:0 48px; }';
  document.head.appendChild(baseStyle);
  var scrollStyle = document.createElement('style');
  scrollStyle.id = 'dir-scroll-kf';
  document.head.appendChild(scrollStyle);

  // ----- scroll: a ring of compositor-animated, viewport-tall panels -----
  // Animating one tall track fails on Firefox (it won't composite a transform bigger than ~1.1x the
  // viewport / 4096px and falls back to a stuttering main-thread animation) and churns GPU tiles even
  // on Chromium. Instead we run N panels, each exactly one stage-height tall (overflow:hidden +
  // contain:paint clamp each compositor layer to that box). Each panel is a static window onto a full
  // copy of the directory (positioned by a static inner translateY = -slice); the PANEL is slid
  // rigidly upward by ONE CSS @keyframes animation, and the panels are phase-locked by negative
  // animation-delay so two always tile the screen while one dwells off-screen below and one above.
  // There is NO per-frame JS — "scrolling" is the compositor sliding pre-rasterized viewport-sized
  // textures, so nothing on the main thread (GC, extensions, the host player) can stutter it. On each
  // off-screen wrap a panel jumps its slice N screens ahead (content already built — nothing to load
  // when it reappears) and, if a data refresh is pending, rebuilds its content THEN, safely off-screen.
  var panels = [];       // [{el, content, version, slice}]
  var Sh = 0;            // panel / stage height
  var C = 0;             // looped directory height (one full copy)
  var speedPxSec = 0;
  var contentVersion = 0;
  var pending = null;    // a queued data refresh, picked up per-panel while off-screen

  function fillContent(el) { // full directory + a clone of the top (>= one screen) for the within-panel wrap
    var arr = Array.isArray(cfg.categories) ? cfg.categories : [];
    arr.forEach(function(c){ el.appendChild(buildCategoryEl(c)); });
    var full = el.scrollHeight; // == C (one full directory)
    var i = 0, guard = arr.length * 4 + 1;
    while ((el.scrollHeight - full) < Sh + 4 && arr.length && i < guard) {
      el.appendChild(buildCategoryEl(arr[i % arr.length])); i++;
    }
    return full;
  }

  function globalScroll() { return speedPxSec * ((document.timeline.currentTime || 0) / 1000); }
  function mod(a, n) { return n > 0 ? ((a % n) + n) % n : 0; }
  function setSlice(p, off) { p.slice = off; p.content.style.transform = 'translate3d(0,' + (-off) + 'px,0)'; }

  function seedSlices() { // four consecutive screens, matching the lanes' physical phase (delays 0..-3T)
    var base = globalScroll();
    var laneStart = [2 * Sh, 1 * Sh, 0, -1 * Sh];
    panels.forEach(function(p, i){ setSlice(p, mod(base + laneStart[i % 4], C)); });
  }

  function onWrap(p) { // fires as a panel wraps to the bottom (off-screen); rebuild + advance N screens
    if (pending && p.version !== pending.version) {
      p.content.replaceChildren();
      C = fillContent(p.content); // all panels share the same data => same C
      p.version = pending.version;
    }
    setSlice(p, mod(p.slice + N * Sh, C));
  }

  function setup() {
    layoutScroller();
    Sh = stage.getBoundingClientRect().height || window.innerHeight;
    stage.replaceChildren();
    panels = [];
    for (var i = 0; i < N; i++) {
      var el = document.createElement('div'); el.className = 'panel'; el.setAttribute('data-lane', i);
      el.style.height = Sh + 'px';
      var content = document.createElement('div'); content.className = 'pcontent';
      el.appendChild(content);
      stage.appendChild(el);
      panels.push({ el: el, content: content, version: contentVersion, slice: 0 });
    }
    C = fillContent(panels[0].content);
    for (var j = 1; j < N; j++) fillContent(panels[j].content);
    speedPxSec = (C <= Sh) ? MIN_SCROLL_PX_SEC : (SPEEDS[cfg.scroll_speed] || SPEEDS.medium);
    var T = Sh / speedPxSec, dur = N * T;
    var kf = '@keyframes dir-pan { from { transform: translate3d(0,' + (2 * Sh) + 'px,0); } to { transform: translate3d(0,' + (-2 * Sh) + 'px,0); } }';
    kf += '.panel{ animation: dir-pan ' + dur + 's linear infinite; }';
    for (var k = 0; k < N; k++) kf += '.panel[data-lane="' + k + '"]{ animation-delay: ' + (-k * T).toFixed(4) + 's; }';
    scrollStyle.textContent = kf;
    seedSlices();
    panels.forEach(function(p){ p.el.addEventListener('animationiteration', function(){ onWrap(p); }); });
  }

  // wait for images (logo + bgs) to load before the first layout, so heights are correct
  var pendingImgs = Array.from(document.images).filter(function(i){ return !i.complete; });
  if (pendingImgs.length === 0) {
    setup();
  } else {
    var built = false, build = function(){ if (!built) { built = true; setup(); } };
    pendingImgs.forEach(function(i){
      i.addEventListener('load', build, { once:true });
      i.addEventListener('error', build, { once:true });
    });
    setTimeout(build, 5000); // hard timeout so we never hang
  }

  // re-layout on resize (debounced) — rebuild the ring; globalScroll() keeps the same content position
  var rT;
  window.addEventListener('resize', function(){
    clearTimeout(rT);
    rT = setTimeout(setup, 250);
  });

  // ----- live data refresh: poll data.json; re-render ONLY when the entries changed -----
  // Mirrors the directory-search poll. data.json is THIS board's own feed (relative URL,
  // CORS-open, no-store). Diff the categories signature and rebuild IN PLACE only on a real
  // change, so an unchanged poll never touches the running scroll (no periodic reset).
  var lastSig = JSON.stringify(cfg.categories || []);
  setInterval(function(){
    if (document.hidden) return;
    fetch('data.json', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(data){
        var cats = data && Array.isArray(data.categories) ? data.categories : [];
        var sig = JSON.stringify(cats);
        if (sig === lastSig) return;      // unchanged -> leave the scroll running untouched
        lastSig = sig;
        cfg.categories = cats;
        contentVersion++;                 // queue it; each panel adopts it on its next off-screen wrap
        pending = { version: contentVersion };
      })
      .catch(function(){ /* transient error -> keep last-good board */ });
  }, REFRESH_MS);

  // ----- pixel shift (anti-burn-in): every 5 min, shift .page 0-3px random dir -----
  var page = document.getElementById('page');
  setInterval(function(){
    var dx = Math.floor(Math.random() * 7) - 3; // -3..+3
    var dy = Math.floor(Math.random() * 7) - 3;
    page.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
  }, 5 * 60 * 1000);
})();
</script>
</body></html>`;
}

// Friendly full-page fallback when a directory-search points at a missing or
// non-directory-board source. Matches the "Unknown widget" fallback tone.
function renderDirectorySearchMissing() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Directory Search</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box;color:#fff;background:#1a1a2e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:640px"><h1 style="font-size:2.2em;font-weight:600;margin:0 0 14px">Directory source not found</h1><p style="opacity:0.7;font-size:1.2em;margin:0;line-height:1.4">Pick a directory board in the widget settings.</p></div>
</body></html>`;
}

// Interactive walk-up search over an existing directory-board's entries. It
// REFERENCES the source board by id (no data copy): the board scrolls on a main
// screen while this lets someone find an entry instantly on a tablet.
function renderDirectorySearch(c) {
  c = c || {};
  const src = db.prepare('SELECT * FROM widgets WHERE id = ?').get(c.source_widget_id);
  if (!src || src.widget_type !== 'directory-board') return renderDirectorySearchMissing();
  let categories = [];
  try {
    const sc = JSON.parse(src.config || '{}');
    categories = Array.isArray(sc.categories) ? sc.categories : [];
  } catch (e) { categories = []; }

  // Inline everything the page needs as one JSON blob, guarded the same way the
  // board does. All user text is rendered via textContent below — never concat.
  const payload = {
    categories: categories,
    source_widget_id: src.id,
    title: c.title || '',
    logo_url: c.logo_url || '',
    theme: c.theme === 'light' ? 'light' : 'dark',
    placeholder_text: c.placeholder_text || 'Search…',
    show_onscreen_keyboard: c.show_onscreen_keyboard !== false,
  };
  const configJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Directory Search</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100%; height:100%; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:#fff; background:#1a1a2e;
    display:flex; flex-direction:column; height:100vh; overflow:hidden;
  }
  body.light { color:#1a1a2e; background:#f5f5f5; }

  .header { flex:0 0 auto; text-align:center; padding:20px 24px 8px; }
  .header img.logo { max-height:90px; max-width:320px; object-fit:contain; margin:0 auto 8px; display:block; }
  .header h1 { font-size:40px; font-weight:600; letter-spacing:0.01em; }

  .searchbar { flex:0 0 auto; padding:10px 24px; }
  #q {
    width:100%; font-size:34px; padding:18px 22px; border-radius:14px; color:inherit; outline:none;
    border:2px solid rgba(255,255,255,0.2); background:rgba(255,255,255,0.08);
  }
  #q:focus { border-color:#4a9eff; }
  #q::placeholder { color:rgba(255,255,255,0.4); }
  body.light #q { border-color:rgba(0,0,0,0.15); background:#fff; }
  body.light #q:focus { border-color:#2563eb; }
  body.light #q::placeholder { color:rgba(0,0,0,0.4); }

  .results { flex:1 1 auto; overflow-y:auto; padding:8px 24px 16px; -webkit-overflow-scrolling:touch; }
  .msg { text-align:center; opacity:0.55; font-size:26px; padding:48px 16px; line-height:1.4; }

  .group { margin-bottom:22px; }
  .group h2 {
    font-size:22px; font-weight:500; letter-spacing:0.06em; text-transform:uppercase; opacity:0.6;
    padding:14px 0 8px; border-bottom:1px solid rgba(255,255,255,0.15); margin-bottom:10px;
  }
  body.light .group h2 { border-bottom-color:rgba(0,0,0,0.12); }

  .entry { display:flex; align-items:baseline; padding:10px 8px; font-size:30px; line-height:1.3; border-radius:8px; }
  .entry:nth-child(even) { background:rgba(255,255,255,0.03); }
  body.light .entry:nth-child(even) { background:rgba(0,0,0,0.03); }
  .entry .id { font-weight:700; min-width:2.6em; flex-shrink:0; margin-right:14px; }
  .entry .text { display:flex; flex-direction:column; flex:1; min-width:0; }
  .entry .nm { font-weight:400; }
  .entry .sub { font-size:0.6em; opacity:0.6; margin-top:3px; }
  .entry.available, .entry.available .id { color:#00ff00; }
  body.light .entry.available, body.light .entry.available .id { color:#059669; }

  /* The keyboard is sized against the VIEWPORT, not in fixed px. A panel's CSS viewport is its
     physical resolution divided by its density, so a 1080p screen at 240dpi presents only 1280x720
     CSS px - and a keyboard laid out for 1920x1080 then eats ~37% of the height instead of ~24%.
     The viewport rule below scales it down on short screens; the default keeps the original
     1080px layout and the smallest rule keeps keys tappable on very short screens. */
  .keyboard { flex:0 0 auto; padding:8px 12px 14px; background:rgba(0,0,0,0.25); user-select:none; }
  body.light .keyboard { background:rgba(0,0,0,0.05); }
  .krow { display:flex; justify-content:center; margin-bottom:6px; }
  .krow > * + * { margin-left:6px; }
  .key {
    flex:1 1 0; max-width:96px; min-width:0;
    height:56px; font-size:24px; text-transform:uppercase;
    border:0; border-radius:8px; background:rgba(255,255,255,0.12); color:inherit; cursor:pointer;
  }
  .key:active { background:#4a9eff; color:#fff; }
  body.light .key { background:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.15); }
  .key-space { flex:4 1 0; max-width:none; text-transform:none; }
  .key-wide { flex:2 1 0; max-width:none; text-transform:none; }

  @media (max-width:700px) {
    .header h1 { font-size:30px; }
    #q { font-size:26px; padding:14px 16px; }
    .entry { font-size:24px; }
  }
  @media (max-height:1050px) {
    .keyboard { padding:0.8vh 12px 1.3vh; }
    .krow { margin-bottom:0.6vh; }
    .krow > * + * { margin-left:0.6vh; }
    .key { height:5.3vh; font-size:2.3vh; }
  }
  @media (max-height:650px) {
    .keyboard { padding:5px 12px 8px; }
    .krow { margin-bottom:4px; }
    .krow > * + * { margin-left:4px; }
    .key { height:34px; font-size:15px; }
  }
</style>
</head>
<body>
  <header class="header" id="header"></header>
  <div class="searchbar"><input id="q" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
  <div class="results" id="results"></div>
  <div class="keyboard" id="keyboard"></div>
<script>
(function(){
  var cfg = ${configJson};
  if (cfg.theme === 'light') document.body.classList.add('light');

  function safeImgUrl(u) {
    return typeof u === 'string' && (u.indexOf('/') === 0 || /^https?:\\/\\//.test(u) || /^data:image\\//.test(u)) ? u : '';
  }

  // ----- header -----
  var header = document.getElementById('header');
  var logoSrc = safeImgUrl(cfg.logo_url);
  if (logoSrc) {
    var img = document.createElement('img');
    img.className = 'logo'; img.src = logoSrc; img.alt = '';
    header.appendChild(img);
  }
  // A logo replaces the title text — showing both stacks the wordmark over the name.
  if (cfg.title && !logoSrc) {
    var h1 = document.createElement('h1');
    h1.textContent = cfg.title;
    header.appendChild(h1);
  }
  if (!logoSrc && !cfg.title) header.style.display = 'none';

  // ----- flatten source entries (preserve category order) -----
  function buildFlat(categories) {
    var out = [];
    (Array.isArray(categories) ? categories : []).forEach(function(cat){
      var cn = cat && cat.name != null ? String(cat.name) : '';
      var entries = cat && Array.isArray(cat.entries) ? cat.entries : [];
      entries.forEach(function(e){
        var item = {
          cat: cn,
          identifier: e && e.identifier != null ? String(e.identifier) : '',
          name: e && e.name != null ? String(e.name) : '',
          subtitle: e && e.subtitle != null ? String(e.subtitle) : '',
          available: !!(e && e.available)
        };
        item._h = (item.identifier + ' ' + item.name + ' ' + item.subtitle).toLowerCase();
        out.push(item);
      });
    });
    return out;
  }
  var flat = buildFlat(cfg.categories);

  var input = document.getElementById('q');
  input.placeholder = cfg.placeholder_text || '';
  var results = document.getElementById('results');
  var HINT = 'Start typing to search the directory…';
  var NO_MATCHES = 'No matches';

  function showMessage(msg) {
    results.textContent = '';
    var d = document.createElement('div');
    d.className = 'msg';
    d.textContent = msg;
    results.appendChild(d);
  }

  function render(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) { showMessage(HINT); return; }
    var matches = flat.filter(function(e){ return e._h.indexOf(q) !== -1; });
    if (!matches.length) { showMessage(NO_MATCHES); return; }
    var order = [], groups = {};
    matches.forEach(function(e){
      if (!groups[e.cat]) { groups[e.cat] = []; order.push(e.cat); }
      groups[e.cat].push(e);
    });
    results.textContent = '';
    order.forEach(function(cn){
      var group = document.createElement('div');
      group.className = 'group';
      if (cn) {
        var h2 = document.createElement('h2');
        h2.textContent = cn;
        group.appendChild(h2);
      }
      groups[cn].forEach(function(e){
        var row = document.createElement('div');
        row.className = 'entry' + (e.available ? ' available' : '');
        var id = document.createElement('span');
        id.className = 'id';
        id.textContent = e.identifier;
        var text = document.createElement('div');
        text.className = 'text';
        var nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.name;
        text.appendChild(nm);
        if (e.subtitle) {
          var sub = document.createElement('span');
          sub.className = 'sub';
          sub.textContent = e.subtitle;
          text.appendChild(sub);
        }
        row.appendChild(id);
        row.appendChild(text);
        group.appendChild(row);
      });
      results.appendChild(group);
    });
    results.scrollTop = 0;
  }

  // ----- debounced input (~120ms) -----
  var dT;
  function onInput() { clearTimeout(dT); dT = setTimeout(function(){ render(input.value); }, 120); }
  input.addEventListener('input', onInput);

  // ----- on-screen keyboard (drives the same filter path as typing) -----
  if (cfg.show_onscreen_keyboard) {
    /* Tell the platform not to raise ITS keyboard for this field. We autofocus a real
       <input>, which on Android is the signal to throw the system IME over the bottom of
       the screen - directly on top of the keyboard we draw below, so a directory panel
       showed Google's keyboard (mic, GIF and emoji keys included) and never showed its
       own. The buttons write input.value directly, so suppressing the platform keyboard
       costs nothing here. Ignored by browsers that don't know inputmode, which is the
       right fallback: a desktop preview keeps behaving exactly as before. */
    input.setAttribute('inputmode', 'none');
    var kb = document.getElementById('keyboard');
    function press(ch) { input.value += ch; try { input.focus(); } catch(e){} onInput(); }
    ['1234567890','qwertyuiop','asdfghjkl','zxcvbnm'].forEach(function(r){
      var rowEl = document.createElement('div');
      rowEl.className = 'krow';
      r.split('').forEach(function(ch){
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'key'; b.textContent = ch;
        b.addEventListener('click', function(){ press(ch); });
        rowEl.appendChild(b);
      });
      kb.appendChild(rowEl);
    });
    var act = document.createElement('div');
    act.className = 'krow';
    var back = document.createElement('button');
    back.type = 'button'; back.className = 'key key-wide'; back.textContent = '\\u232B';
    back.addEventListener('click', function(){ input.value = input.value.slice(0, -1); try { input.focus(); } catch(e){} onInput(); });
    var space = document.createElement('button');
    space.type = 'button'; space.className = 'key key-space'; space.textContent = 'space';
    space.addEventListener('click', function(){ press(' '); });
    var clear = document.createElement('button');
    clear.type = 'button'; clear.className = 'key key-wide'; clear.textContent = 'clear';
    clear.addEventListener('click', function(){ input.value = ''; try { input.focus(); } catch(e){} onInput(); });
    act.appendChild(back); act.appendChild(space); act.appendChild(clear);
    kb.appendChild(act);
  } else {
    var kbOff = document.getElementById('keyboard');
    if (kbOff) kbOff.style.display = 'none';
  }

  // ----- initial state + autofocus -----
  render('');
  try { input.focus(); } catch(e){}

  // ----- live sync: poll the source board so edits appear without a reload -----
  // The board's data.json sits next to this page (/api/widgets/<board>/data.json),
  // reached with a relative URL so it works behind any proxy/base path and from a
  // null-origin sandboxed iframe (data.json is CORS-open). We only rebuild + rerender
  // when the data actually changed, so a mid-search view isn't disturbed every tick.
  var SRC_ID = cfg.source_widget_id || '';
  var POLL_MS = 30000;
  var lastSig = JSON.stringify(cfg.categories || []);
  if (SRC_ID) {
    setInterval(function(){
      if (document.hidden) return;
      fetch('../' + encodeURIComponent(SRC_ID) + '/data.json', { cache: 'no-store' })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function(data){
          var cats = data && Array.isArray(data.categories) ? data.categories : [];
          var sig = JSON.stringify(cats);
          if (sig === lastSig) return;      // unchanged -> leave the view alone
          lastSig = sig;
          flat = buildFlat(cats);
          render(input.value);              // refresh results for the current query
        })
        .catch(function(){ /* transient error -> keep last-good data */ });
    }, POLL_MS);
  }
})();
</script>
</body></html>`;
}

// diag-smoothness: a self-contained frame-cadence tester for the ACTUAL panel. Two GPU-composited
// animations (a vertical scroll like the board + a fast sweep) plus a big on-screen HUD (FPS, refresh
// estimate, long-frame count, worst stall, SMOOTH/STALLING verdict) — so a stutter can be read off the
// panel screen with no console. If this stalls on real signage hardware, the hardware is the cause.
function renderDiagSmoothness(config) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smoothness Diagnostic</title><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:#0a0d13;color:#cbd4e4;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;height:100vh}
  .bar{position:absolute;top:0;left:0;right:0;padding:1.4vh 2vw;border-bottom:1px solid #20293a;background:#0f1420;z-index:5}
  .bar h1{font-size:2.2vh;font-weight:700;letter-spacing:.02em}
  .bar p{font-size:1.7vh;color:#6d7789;margin-top:.4vh}
  .bar b{color:#54a6ff}
  .stage{position:absolute;top:0;left:0;right:0;bottom:0}
  .col{position:absolute;top:0;left:0;width:52%;height:100%;overflow:hidden;border-right:1px solid #20293a}
  .roll{position:absolute;left:0;right:0;top:0;will-change:transform;animation:roll 30s linear infinite}
  @keyframes roll{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,-50%,0)}}
  .row{display:flex;align-items:center;padding:1.5vh 2vw;border-bottom:1px solid #20293a;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:2.6vh}
  .row > * + *{margin-left:1.4vw}
  .row .n{color:#54a6ff;min-width:3.2em;font-variant-numeric:tabular-nums}
  .row:nth-child(3n) .n{color:#37d391}
  .sweep{position:absolute;top:0;right:0;width:48%;height:100%;background:repeating-linear-gradient(90deg,#0f1420 0 3vw,#182234 3vw 6vw)}
  .marker{position:absolute;top:0;bottom:0;width:.5vw;background:#f5b451;box-shadow:0 0 3vw #f5b451;will-change:transform;animation:sweep 2s linear infinite}
  @keyframes sweep{from{transform:translateX(0)}to{transform:translateX(calc(48vw - .5vw))}}
  .tag{position:absolute;top:1.5vh;font-family:ui-monospace,monospace;font-size:1.6vh;color:#6d7789;z-index:2}
  .col .tag{left:1.5vw;background:#0a0d13;padding:.4vh .8vw;border-radius:4px}
  .sweep .tag{right:1.5vw}
  .hud{position:absolute;left:50%;bottom:3vh;transform:translateX(-50%);background:rgba(12,16,24,.94);border:1px solid #20293a;border-radius:14px;padding:2.2vh 2.4vw;min-width:64vw;z-index:6;box-shadow:0 1.4vh 4vh rgba(0,0,0,.55)}
  .verdict{display:flex;align-items:center;margin-bottom:1.8vh}
  .verdict > * + *{margin-left:1.4vw}
  .dot{width:1.8vh;height:1.8vh;border-radius:50%;background:#6d7789}
  .verdict.smooth .dot{background:#37d391;box-shadow:0 0 0 .6vh rgba(55,211,145,.16)}
  .verdict.stall .dot{background:#ff5d5d;box-shadow:0 0 0 .6vh rgba(255,93,93,.18)}
  .verdict .txt{font-size:3.4vh;font-weight:750;letter-spacing:.01em}
  .verdict.smooth .txt{color:#37d391}.verdict.stall .txt{color:#ff5d5d}
  .verdict .sub{font-size:1.9vh;color:#6d7789;font-weight:400;margin-left:auto;text-align:right}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);margin-bottom:1.4vh}
  .stat{background:#121826;border:1px solid #20293a;border-radius:10px;padding:1.2vh 1vw;margin:0 .6vw}
  .stat .k{font-size:1.4vh;text-transform:uppercase;letter-spacing:.08em;color:#6d7789}
  .stat .v{font-family:ui-monospace,Menlo,monospace;font-size:4vh;font-variant-numeric:tabular-nums;margin-top:.4vh}
  .stat .v small{font-size:1.8vh;color:#6d7789}
  .log{font-family:ui-monospace,Menlo,monospace;font-size:1.7vh;color:#6d7789;height:2.4vh;overflow:hidden}
  .log b{color:#ff5d5d}
  </style></head><body>
  <div class="bar"><h1>Panel Smoothness Diagnostic</h1><p>Two GPU-composited animations, zero app logic. If the scroll or the yellow bar <b>skips</b> — or the HUD reads STALLING — this <b>panel/hardware</b> is dropping frames.</p></div>
  <div class="stage">
    <div class="col"><div class="tag">TEST 1 &middot; vertical scroll</div><div class="roll" id="roll"></div></div>
    <div class="sweep"><div class="tag">TEST 2 &middot; fast sweep</div><div class="marker"></div></div>
    <div class="hud">
      <div class="verdict" id="verdict"><span class="dot"></span><span class="txt" id="vtxt">measuring&hellip;</span><span class="sub" id="vsub">collecting frames</span></div>
      <div class="grid">
        <div class="stat"><div class="k">FPS now</div><div class="v" id="fps">&ndash;</div></div>
        <div class="stat"><div class="k">Refresh est.</div><div class="v" id="hz">&ndash;<small> Hz</small></div></div>
        <div class="stat"><div class="k">Long frames</div><div class="v" id="long">0<small> &gt;50ms</small></div></div>
        <div class="stat"><div class="k">Worst stall</div><div class="v" id="worst">0<small> ms</small></div></div>
      </div>
      <div class="log" id="log">no stalls yet &middot; a healthy panel shows 0 long frames</div>
    </div>
  </div>
  <script>
  (function(){
    var roll=document.getElementById('roll'),half='',i;
    for(i=1;i<=26;i++){ half+='<div class="row"><span class="n">'+(100+i)+'</span><span class="t">Directory line '+i+'</span></div>'; }
    roll.innerHTML=half+half;
    var last=0,worst=0,longCount=0,recent=[],dts=[],started=0,lastPaint=0;
    var elFps=document.getElementById('fps'),elHz=document.getElementById('hz'),elLong=document.getElementById('long'),
        elWorst=document.getElementById('worst'),elLog=document.getElementById('log'),verdict=document.getElementById('verdict'),
        vtxt=document.getElementById('vtxt'),vsub=document.getElementById('vsub');
    function median(a){ var b=a.slice().sort(function(x,y){return x-y}); return b[Math.floor(b.length/2)]||0; }
    function paint(ts){
      var med=median(dts)||16.7;
      elFps.innerHTML=(1000/med).toFixed(0);
      elHz.innerHTML=(1000/med).toFixed(0)+'<small> Hz</small>';
      elLong.innerHTML=longCount+'<small> &gt;50ms</small>';
      elWorst.innerHTML=worst.toFixed(0)+'<small> ms</small>';
      if(recent.length) elLog.innerHTML=recent.join(' \\u00b7 ');
      var el=ts-started;
      if(el>4000){
        if(longCount===0){ verdict.className='verdict smooth'; vtxt.innerHTML='SMOOTH'; vsub.innerHTML='0 long frames &mdash; this panel animates cleanly'; }
        else { verdict.className='verdict stall'; vtxt.innerHTML='STALLING'; vsub.innerHTML=longCount+' long frame'+(longCount>1?'s':'')+' &mdash; this panel is dropping frames'; }
      } else { vsub.innerHTML='collecting frames&hellip; '+(el/1000).toFixed(0)+'s'; }
    }
    function frame(ts){
      if(!started) started=ts;
      if(last){ var dt=ts-last; dts.push(dt); if(dts.length>180) dts.shift();
        if(dt>50){ longCount++; if(dt>worst) worst=dt;
          recent.unshift('<b>'+dt.toFixed(0)+'ms</b> @ '+((ts-started)/1000).toFixed(0)+'s'); if(recent.length>3) recent.pop(); }
      }
      last=ts;
      if(ts-lastPaint>250){ lastPaint=ts; paint(ts); }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // the player appends ?device=<id> to the render URL so telemetry can be keyed to THIS panel.
    var DEVID=''; try{ var mm=(location.search||'').match(/[?&](?:device|d)=([^&]+)/); if(mm) DEVID=decodeURIComponent(mm[1]); }catch(e){}
    // report the snapshot back to the server (relative 'telemetry' -> /api/widgets/<id>/telemetry).
    // text/plain keeps it a CORS-simple request (no preflight) from the null-origin sandboxed iframe.
    function report(){
      try{
        var med=median(dts)||16.7, now=(typeof performance!=='undefined'&&performance.now)?performance.now():Date.now();
        var payload={device:DEVID,fps:Math.round(1000/med),refreshHz:Math.round(1000/med),longFrames:longCount,worstStallMs:Math.round(worst),
          elapsedS:started?Math.round((now-started)/1000):0,
          verdict:(started&&(now-started>4000))?(longCount?'STALLING':'SMOOTH'):'measuring',
          recent:recent.slice(0,3).map(function(s){return s.replace(/<[^>]+>/g,'');}),
          vp:window.innerWidth+'x'+window.innerHeight,dpr:window.devicePixelRatio||1,ua:(navigator.userAgent||'').slice(0,180)};
        fetch('telemetry',{method:'POST',headers:{'Content-Type':'text/plain'},body:JSON.stringify(payload),keepalive:true})['catch'](function(){});
      }catch(e){}
    }
    setInterval(report,2500);
  })();
  </script></body></html>`;
}

module.exports = router;
module.exports.renderWidgetHtml = renderWidgetHtml;
module.exports.dataResolverFor = dataResolverFor;
module.exports.imageResolverFor = imageResolverFor;
module.exports.widgetIframeSandboxForWorkspace = widgetIframeSandboxForWorkspace;
