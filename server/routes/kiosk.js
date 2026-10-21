const express = require('express');
const router = express.Router();
// Abuse backstop (lib/backstop-limiter.js): already counted app-wide; here so this router is never unguarded.
router.use(require('../lib/backstop-limiter'));
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2e: workspace-aware access. Same pattern as content/widgets/folders.
const { denyReadOnly, resourceAccess } = require('../lib/tenancy');

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Button icons are emoji. The defaults used to be stored as numeric HTML entities ('&#128205;'),
// which escapeHtml() then rendered as the literal text "&#128205;" on the screen and in the editor.
// New defaults are real characters; pages already saved with entity strings are decoded here, before
// escaping. Only NUMERIC entities are decoded (to a valid code point) - everything else, '<' and named
// entities included, still goes through escapeHtml() untouched.
function decodeNumericEntities(str) {
  if (typeof str !== 'string') return str;
  const cp = (n) => (Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : null);
  return str
    .replace(/&#(\d{1,7});/g, (m, n) => cp(Number(n)) ?? m)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => cp(parseInt(n, 16)) ?? m);
}

// Validate CSS color values to prevent style injection
function safeColor(val, fallback) {
  if (!val) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(val) || /^[a-zA-Z]+$/.test(val)) return val;
  return fallback;
}

// CSS VALUE escaping. These land inside a <style> block, where escapeHtml() is the WRONG
// tool: it escapes & < > " ' but not { } ;, and inside a raw-text <style> element the entities
// it does produce are never decoded. So escapeHtml neither prevents CSS injection nor renders
// correctly. `red} body{background:url(https://attacker/x)` closes the declaration AND the rule
// and appends arbitrary ones — no XSS (</style> can't be reached), but an attacker-chosen rule
// on every panel showing the page, which is an outbound beacon at minimum.
//
// The check is on STRUCTURE, not a value allowlist: `background` is a free-text field in the
// editor, so legitimate values include linear-gradient(...), rgb(...) and url(...). Those all
// stay; only characters that could end the declaration or open a new rule are refused.
function safeCssValue(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const v = val.trim();
  if (!v) return fallback;
  if (/[{};]/.test(v)) return fallback;          // declaration / rule breakout
  if (/\/\*|\*\//.test(v)) return fallback;        // comments can swallow following declarations
  if (/[\u0000-\u001F]/.test(v)) return fallback;   // control chars, incl. newlines
  if (/<\s*\/?\s*style/i.test(v)) return fallback;  // belt-and-braces against the raw-text edge
  return v;
}

// font-family needs no parentheses, so it gets a tighter allowlist than the general value check:
// family names, the generic keywords, quotes and separators only.
function safeFontFamily(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const v = val.trim();
  if (!v) return fallback;
  return /^[a-zA-Z0-9 ,'"._-]+$/.test(v) ? v : fallback;
}

// Validate CSS numeric values
function safeNumber(val, fallback) {
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

// List kiosk pages in the caller's current workspace plus any platform-template
// rows (workspace_id IS NULL) shared with all workspaces.
// Phase 2.2e: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list branch.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const pages = db.prepare(
    'SELECT * FROM kiosk_pages WHERE (workspace_id = ? OR workspace_id IS NULL) ORDER BY created_at DESC'
  ).all(req.workspaceId);
  res.json(pages);
});

// Phase 2.2e: workspace-aware access. Mirrors widgets/content helpers.
// Platform-template kiosks (workspace_id IS NULL) are readable by anyone
// authenticated and writable only by platform_admin.
function checkKioskRead(req, res) {
  const page = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id);
  if (!page) { res.status(404).json({ error: 'Page not found' }); return null; }
  if (!page.workspace_id) return page;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(page.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return page;
}

function checkKioskWrite(req, res) {
  const page = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id);
  if (!page) { res.status(404).json({ error: 'Page not found' }); return null; }
  if (!page.workspace_id) {
    if (!PLATFORM_ROLES.includes(req.user.role)) {
      res.status(403).json({ error: 'Platform admin required to modify shared kiosk pages' }); return null;
    }
    return page;
  }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(page.workspace_id);
  const ctx = ws && resourceAccess(req, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return page;
}

// Get kiosk page
router.get('/:id', (req, res) => {
  const page = checkKioskRead(req, res);
  if (!page) return;
  res.json(page);
});

// Render kiosk page (public - accessed by devices)
router.get('/:id/render', (req, res) => {
  const page = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).send('Page not found');

  const config = JSON.parse(page.config || '{}');
  const buttons = config.buttons || [];
  const style = config.style || {};

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { width:100vw; height:100vh; overflow:hidden; font-family:${safeFontFamily(style.fontFamily, '-apple-system,sans-serif')};
    background:${safeCssValue(style.background, '#111827')}; color:${safeColor(style.textColor, '#f1f5f9')}; display:flex; flex-direction:column; }
  .header { padding:40px 60px 20px; text-align:${/^(left|center|right)$/.test(style.headerAlign) ? style.headerAlign : 'center'}; }
  .header h1 { font-size:${safeNumber(style.titleSize, 48)}px; font-weight:700; }
  .header p { font-size:${safeNumber(style.subtitleSize, 20)}px; opacity:0.7; margin-top:8px; }
  .header img { max-height:80px; margin-bottom:16px; }
  .content { flex:1; display:flex; align-items:center; justify-content:center; padding:20px 60px; }
  .button-grid { display:grid; grid-template-columns:repeat(${safeNumber(style.columns, 3)}, 1fr); width:100%; max-width:1200px; }
  .kiosk-btn {
    background:${safeColor(style.buttonBg, '#1e293b')}; border:2px solid ${safeColor(style.buttonBorder, '#334155')};
    border-radius:${safeNumber(style.buttonRadius, 16)}px; padding:${safeNumber(style.buttonPadding, 32)}px;
    text-align:center; cursor:pointer; transition:all 0.2s ease; touch-action:manipulation;
    display:flex; flex-direction:column; align-items:center; justify-content:center; margin:${safeNumber(style.gap, 24) / 2}px;
  }
  .kiosk-btn > * + * { margin-top:12px; }
  .kiosk-btn:hover, .kiosk-btn:active { background:${safeColor(style.buttonHover, '#3b82f6')}; border-color:${safeColor(style.buttonHover, '#3b82f6')}; transform:scale(1.02); }
  .kiosk-btn .icon { font-size:${safeNumber(style.iconSize, 48)}px; }
  .kiosk-btn .label { font-size:${safeNumber(style.labelSize, 20)}px; font-weight:600; }
  .kiosk-btn .sublabel { font-size:${safeNumber(style.sublabelSize, 14)}px; opacity:0.6; }
  .footer { padding:20px 60px; text-align:center; font-size:14px; opacity:0.4; }
  .idle-overlay { position:fixed; top:0; right:0; bottom:0; left:0; background:rgba(0,0,0,0.95); display:none; flex-direction:column;
    align-items:center; justify-content:center; z-index:100; cursor:pointer; }
  .idle-overlay h2 { font-size:48px; margin-bottom:16px; }
  .idle-overlay p { font-size:20px; opacity:0.6; }
  .site-view { position:fixed; top:0; right:0; bottom:0; left:0; display:none; flex-direction:column; background:#fff; z-index:50; }
  .site-bar { display:flex; align-items:center; padding:12px 20px; background:#111827; color:#f1f5f9; }
  .site-back { font:inherit; font-size:22px; font-weight:600; color:inherit; background:#1e293b; border:2px solid #334155;
    border-radius:12px; padding:12px 28px; cursor:pointer; touch-action:manipulation; flex-shrink:0; }
  .site-hint { margin-left:20px; font-size:15px; opacity:0.6; }
  .site-view iframe { flex:1; width:100%; border:0; background:#fff; }
</style>
</head>
<body>
  <div class="header">
    ${config.logoUrl ? `<img src="${escapeHtml(config.logoUrl)}" alt="Logo">` : ''}
    <h1>${escapeHtml(config.title) || 'Welcome'}</h1>
    ${config.subtitle ? `<p>${escapeHtml(config.subtitle)}</p>` : ''}
  </div>
  <div class="content">
    <div class="button-grid">
      ${buttons.map(btn => `
        <div class="kiosk-btn" data-action="${escapeHtml(btn.action) || ''}" data-url="${escapeHtml(btn.url) || ''}" data-page="${escapeHtml(btn.page) || ''}">
          ${btn.icon ? `<div class="icon">${escapeHtml(decodeNumericEntities(btn.icon))}</div>` : ''}
          <div class="label">${escapeHtml(btn.label) || 'Button'}</div>
          ${btn.sublabel ? `<div class="sublabel">${escapeHtml(btn.sublabel)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  </div>
  <div class="footer">${escapeHtml(config.footer) || ''}</div>

  <!-- "Open URL": the address, inside this page, with a way back (see openSite below) -->
  <div class="site-view" id="siteView">
    <div class="site-bar">
      <button type="button" class="site-back" id="siteBack">&#8592; ${escapeHtml(config.siteBackLabel) || 'Back'}</button>
      <span class="site-hint">${escapeHtml(config.siteHint) || 'If this stays blank, the website does not allow being shown inside another page.'}</span>
    </div>
    <iframe id="siteFrame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
  </div>

  <!-- Idle screen (shows after inactivity) -->
  <div class="idle-overlay" id="idleOverlay">
    <h2>${escapeHtml(config.idleTitle) || 'Touch to Begin'}</h2>
    <p>${escapeHtml(config.idleSubtitle) || ''}</p>
  </div>

  <script>
    // Button actions
    document.querySelectorAll('.kiosk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        resetIdleTimer();
        const action = btn.dataset.action;
        const url = btn.dataset.url;
        const page = btn.dataset.page;
        if (action === 'url' && url) openSite(url);
        else if (action === 'page' && page) window.location.href = page;
        else if (action === 'back') window.history.back();
        // Visual feedback
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => btn.style.transform = '', 200);

        // Report touch to server
        if (window.parent !== window) {
          const label = btn.querySelector('.label');
          window.parent.postMessage({ type: 'kiosk-tap', label: label ? label.textContent : '' }, '*');
        }
      });
    });

    /*
     * "Open URL" used to call window.open(), which a screen never honours: the page runs in the
     * player's sandboxed frames (allow-scripts, no popups) and a TV has no second window to show
     * anyway. The address opens HERE instead, full screen under a Back bar, in a frame that is
     * sandboxed the same way as the page itself (a nested frame can never get more than its
     * parent). http(s) only, so a button cannot carry a javascript: URL. A site that refuses to
     * be framed stays blank; the bar says so, since that refusal cannot be detected from here.
     */
    function siteUrl(raw) {
      let u = String(raw || '').trim();
      // "www.example.com" typed without a scheme. (Backslashes doubled: this is inside a template literal.)
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[\\/?#.]/.test(u) && /^[^\\s\\/]+\\.[^\\s\\/]+/.test(u)) u = 'https://' + u;
      try {
        const parsed = new URL(u, window.location.href);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
      } catch (e) { return null; }
    }
    function openSite(raw) {
      const u = siteUrl(raw);
      if (!u) return;
      document.getElementById('siteFrame').src = u;
      document.getElementById('siteView').style.display = 'flex';
    }
    function closeSite() {
      const view = document.getElementById('siteView');
      if (view.style.display !== 'flex') return;
      view.style.display = 'none';
      document.getElementById('siteFrame').src = 'about:blank';
    }
    document.getElementById('siteBack').addEventListener('click', closeSite);

    // Idle screen after ${safeNumber(config.idleTimeout, 60)} seconds of no interaction
    let idleTimer;
    function resetIdleTimer() {
      document.getElementById('idleOverlay').style.display = 'none';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        closeSite();   // the next visitor starts at the home page, not on the last one's website
        document.getElementById('idleOverlay').style.display = 'flex';
      }, ${safeNumber(config.idleTimeout, 60) * 1000});
    }
    // Touches inside the opened website never reach this document; the first one moves focus
    // into its frame, which at least restarts the clock.
    window.addEventListener('blur', resetIdleTimer);
    document.getElementById('idleOverlay').addEventListener('click', resetIdleTimer);
    ['touchstart', 'click', 'mousemove'].forEach(e => document.addEventListener(e, resetIdleTimer));
    resetIdleTimer();

    // Clock update if element exists
    const clockEl = document.getElementById('clock');
    if (clockEl) setInterval(() => { clockEl.textContent = new Date().toLocaleTimeString(); }, 1000);
  </script>
</body></html>`;

  // Embedded by the player in a sandboxed (null-origin) iframe; the global
  // X-Frame-Options: SAMEORIGIN would refuse that and leave it blank.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Create kiosk page in the caller's current workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating kiosk pages.' });
  if (denyReadOnly(req, res)) return;
  const { name, config: pageConfig } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO kiosk_pages (id, user_id, workspace_id, name, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, name, JSON.stringify(pageConfig || getDefaultKioskConfig()));

  res.status(201).json(db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(id));
});

/*
 * A page reaches a screen through a WEBPAGE WIDGET that frames its render URL ("Kiosk: <name>",
 * made by Add Content -> Kiosk). The widget stores the URL relative, or with an origin on older
 * assignments, so this matches the path. These are the widgets a save must re-rev and a delete
 * must not leave behind showing "Page not found".
 */
function kioskWidgetIds(pageId) {
  const like = `%/api/kiosk/${String(pageId).replace(/[\\%_]/g, '\\$&')}/render%`;
  return db.prepare("SELECT id FROM widgets WHERE widget_type = 'webpage' AND config LIKE ? ESCAPE '\\'")
    .all(like).map((r) => r.id);
}

/*
 * Saving a page used to notify nobody. The render is served live, but a player keeps a widget it is
 * already showing mounted (a lone widget is held, never reloaded) until the widget's rev moves, so
 * an edit reached a screen only when the player restarted. Same mechanism as editing the widget
 * itself (routes/widgets.js PUT): bump the rev (widgets.updated_at, +1 so two saves in one second
 * still differ) and push to the screens playing it.
 */
function pushToScreens(req, widgetIds) {
  if (!widgetIds.length) return;
  const placeholders = widgetIds.map(() => '?').join(',');
  // CAST: strftime() returns TEXT, and SQLite's MAX() ranks any text above any number, so without it
  // this would always pick "now" and two saves in one second would share a rev.
  db.prepare(`UPDATE widgets SET updated_at = MAX(updated_at + 1, CAST(strftime('%s','now') AS INTEGER)) WHERE id IN (${placeholders})`)
    .run(...widgetIds);
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    const { devicesPlayingWidget } = require('../lib/devices-playing');
    const devices = new Set();
    for (const id of widgetIds) for (const d of devicesPlayingWidget(id)) devices.add(d);
    for (const d of devices) commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), d, buildPlaylistPayload);
  } catch (e) { /* best-effort; the heartbeat refresh still picks it up */ }
}

// Playlists (draft rows or what is published) and schedules that still play one of these widgets.
// A schedule would otherwise vanish with the widget (schedules.widget_id is ON DELETE CASCADE).
function usedBy(widgetIds) {
  const names = new Set();
  for (const id of widgetIds) {
    const like = `%${id.replace(/[\\%_]/g, '\\$&')}%`;
    for (const p of db.prepare(`
      SELECT DISTINCT p.name FROM playlists p
       WHERE EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.playlist_id = p.id AND pi.widget_id = ?)
          OR p.published_snapshot LIKE ? ESCAPE '\\'
    `).all(id, like)) names.add(p.name);
    for (const sc of db.prepare('SELECT title FROM schedules WHERE widget_id = ?').all(id)) names.add(sc.title);
  }
  return [...names];
}

// Update kiosk page
router.put('/:id', (req, res) => {
  const page = checkKioskWrite(req, res);
  if (!page) return;

  const { name, config: pageConfig } = req.body;
  if (name) db.prepare('UPDATE kiosk_pages SET name = ? WHERE id = ?').run(name, req.params.id);
  if (pageConfig) {
    db.prepare('UPDATE kiosk_pages SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
      .run(JSON.stringify(pageConfig), req.params.id);
    pushToScreens(req, kioskWidgetIds(req.params.id));
  }

  res.json(db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id));
});

/*
 * Delete kiosk page. A page still in a playlist or schedule is refused (named), the same rule as a slide deck:
 * deleting it used to leave its "Kiosk: ..." widget in the playlist, showing "Page not found" on
 * the screen. Once nothing plays it, its widgets go with it, so none is left pointing at nothing.
 */
router.delete('/:id', (req, res) => {
  const page = checkKioskWrite(req, res);
  if (!page) return;
  const widgetIds = kioskWidgetIds(page.id);
  const names = usedBy(widgetIds);
  if (names.length) {
    return res.status(409).json({
      error: `This page is still in use: ${names.join(', ')}. Remove it from there first.`,
      code: 'KIOSK_PAGE_IN_USE',
      used_by: names,
    });
  }
  db.transaction(() => {
    for (const id of widgetIds) db.prepare("DELETE FROM widgets WHERE id = ? AND widget_type = 'webpage'").run(id);
    db.prepare('DELETE FROM kiosk_pages WHERE id = ?').run(req.params.id);
  })();
  res.json({ success: true, removed_widgets: widgetIds.length });
});

function getDefaultKioskConfig() {
  return {
    title: 'Welcome',
    subtitle: 'How can we help you today?',
    footer: '',
    logoUrl: '',
    idleTitle: 'Touch to Begin',
    idleSubtitle: '',
    idleTimeout: 60,
    buttons: [
      { label: 'Directory', sublabel: 'Find a location', icon: '📍', action: 'page', page: '' },
      { label: 'Events', sublabel: 'See what\'s happening', icon: '📅', action: 'page', page: '' },
      { label: 'Map', sublabel: 'Building map', icon: '🗺️', action: 'page', page: '' },
      { label: 'Contact', sublabel: 'Get in touch', icon: '📞', action: 'page', page: '' },
      { label: 'WiFi', sublabel: 'Connect to WiFi', icon: '📶', action: 'page', page: '' },
      { label: 'Help', sublabel: 'Need assistance?', icon: '❔', action: 'page', page: '' },
    ],
    style: {
      background: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)',
      textColor: '#f1f5f9',
      columns: 3,
      buttonBg: '#1e293b',
      buttonBorder: '#334155',
      buttonHover: '#3b82f6',
      buttonRadius: 16,
      buttonPadding: 32,
      gap: 24,
      titleSize: 48,
      iconSize: 48,
      labelSize: 20,
    }
  };
}

module.exports = router;
module.exports.decodeNumericEntities = decodeNumericEntities;
