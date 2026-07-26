const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const appConfig = require('../config');
const { PLATFORM_ROLES, ELEVATED_ROLES } = require('../middleware/auth');
// Phase 2.2d: workspace-aware access. Same pattern as devices.js / content.js.
const { accessContext } = require('../lib/tenancy');

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

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate timezone format (e.g. America/New_York, UTC, Etc/GMT+5)
function safeTimezone(tz) {
  if (!tz) return 'UTC';
  return /^[A-Za-z_\-\/+0-9]+$/.test(tz) ? tz : 'UTC';
}

// Validate ISO date string format
function safeDateString(d) {
  if (!d) return '';
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?/.test(d) ? d : '';
}

// Validate URL is http/https
function safeUrl(url) {
  if (!url) return 'about:blank';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? url : 'about:blank';
  } catch { return 'about:blank'; }
}

// Security: widget render output is public and CSP-exempt, so config values that
// get inlined into <style>/CSS must not be able to break out (a config field set
// via the API could otherwise carry `}</style><script>...`). safeCss allows
// colors/gradients but rejects breakout/exfil constructs; safeNumber coerces to
// a finite number (so e.g. font_size can't smuggle markup).
function safeCss(v, fallback) {
  if (typeof v !== 'string') return fallback;
  if (/[<>{}\\;]/.test(v) || /url\s*\(/i.test(v) || /@import/i.test(v) || /expression/i.test(v) || /javascript:/i.test(v)) return fallback;
  return v.trim().slice(0, 200);
}
function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// List widgets accessible to the caller's current workspace, plus any
// platform-template rows (workspace_id IS NULL) shared with all workspaces.
// Phase 2.2d: workspace-scoped. Cross-workspace visibility comes from
// switch-workspace, not a special list branch.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const widgets = db.prepare(
    'SELECT * FROM widgets WHERE (workspace_id = ? OR workspace_id IS NULL) ORDER BY created_at DESC'
  ).all(req.workspaceId);
  res.json(widgets);
});

// Create widget in the caller's current workspace.
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context. Switch to a workspace before creating widgets.' });
  const { widget_type, name, config } = req.body;
  if (!widget_type || !name) return res.status(400).json({ error: 'widget_type and name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, req.user.id, req.workspaceId, widget_type, name, JSON.stringify(config || {}));

  res.status(201).json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
});

// Phase 2.2d: workspace-aware access. Mirrors the device/content pattern.
// Platform-template widgets (workspace_id IS NULL) are readable by anyone
// authenticated and writable only by platform_admin.
function checkWidgetRead(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  if (!widget.workspace_id) return widget;
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(widget.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  return widget;
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
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  return widget;
}

// Get widget
router.get('/:id', (req, res) => {
  const widget = checkWidgetRead(req, res);
  if (!widget) return;
  res.json(widget);
});

// Update widget
router.put('/:id', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;

  const { name, config } = req.body;
  if (name) db.prepare('UPDATE widgets SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
  if (config) db.prepare('UPDATE widgets SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(JSON.stringify(config), req.params.id);

  res.json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id));
});

// Delete widget
router.delete('/:id', (req, res) => {
  const widget = checkWidgetWrite(req, res);
  if (!widget) return;
  db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

const KNOWN_WIDGET_TYPES = new Set(['clock','weather','rss','text','webpage','social','directory-board','directory-search','diag-smoothness']);
function renderWidgetHtml(type, config) {
  config = config || {};
  switch (type) {
    case 'crypto': return renderCrypto();
    case 'world-clock': return renderWorldClock();
    case 'clock': return renderClock(config);
    case 'weather': return renderWeather(config);
    case 'rss': return renderRSS(config);
    case 'text': return renderText(config);
    case 'webpage': return renderWebpage(config);
    case 'social': return renderSocial(config);
    case 'directory-board': return renderDirectoryBoard(config);
    case 'directory-search': return renderDirectorySearch(config);
    case 'diag-smoothness': return renderDiagSmoothness(config);
    default: return '<html><body style="color:white;background:black;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>Unknown widget</h1></body></html>';
  }
}

// Render widget as HTML page
router.get('/:id/render', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');
  const config = JSON.parse(widget.config || '{}');
  // This page is DESIGNED to be embedded by the player, which frames it in a
  // sandboxed (allow-scripts, no allow-same-origin) iframe = a null origin. The
  // global helmet X-Frame-Options: SAMEORIGIN refuses that (null != same), so
  // widgets render blank in the web player. Drop it here; the sandbox - not
  // X-Frame-Options - is what isolates the widget (it can't read the dashboard JWT).
  res.removeHeader('X-Frame-Options');
  // Never cache the render: widget data (clock/weather/rss/directory) changes, and
  // a cached copy from before the X-Frame-Options change would keep showing blank.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/html');
  res.send(renderWidgetHtml(widget.widget_type, config));
});

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
const widgetTelemetry = new Map();
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
  res.json({ ok: true });
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
  const rec = dev ? (widgetTelemetry.get(dev) || null) : (widgetTelemetry.get('w:' + req.params.id) || null);
  res.json(rec);
});

// Preview unsaved widget from config (used by editor Preview button)
router.post('/preview', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  let html = renderWidgetHtml(widget_type, config || {});
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
  if (!KNOWN_WIDGET_TYPES.has(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  const id = uuidv4();
  const html = renderWidgetHtml(widget_type, config || {});
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
  res.send(html);
});

function renderClock(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, 'transparent')}; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; overflow:hidden; }
  #time { font-size:${safeNumber(c.font_size, 64)}px; font-weight:700; color:${safeCss(c.color, '#FFFFFF')}; }
  #date { font-size:${Math.max(16, safeNumber(c.font_size, 64) / 3)}px; color:${safeCss(c.color, '#FFFFFF')}; opacity:0.7; margin-top:8px; }
</style></head><body>
<div id="time"></div>
${c.show_date !== false ? '<div id="date"></div>' : ''}
<script>
function update() {
  const opts = { hour12: ${c.format !== '24h'}, timeZone: '${safeTimezone(c.timezone)}', hour:'2-digit', minute:'2-digit', second:'2-digit' };
  document.getElementById('time').textContent = new Date().toLocaleTimeString('en-US', opts);
  ${c.show_date !== false ? `document.getElementById('date').textContent = new Date().toLocaleDateString('en-US', { timeZone: '${safeTimezone(c.timezone)}', weekday:'long', year:'numeric', month:'long', day:'numeric' });` : ''}
}
setInterval(update, 1000); update();
</script></body></html>`;
}

function renderWeather(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, 'transparent')}; display:flex; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; color:${safeCss(c.color, '#FFF')}; }
  .weather { text-align:center; }
  .temp { font-size:${safeNumber(c.font_size, 48)}px; font-weight:700; }
  .location { font-size:18px; opacity:0.7; margin-top:4px; }
  .desc { font-size:16px; opacity:0.6; margin-top:8px; }
  .icon { font-size:64px; }
</style></head><body>
<div class="weather">
  <div class="icon" id="icon"></div>
  <div class="temp" id="temp">--</div>
  <div class="location">${escapeHtml(c.location) || 'Unknown'}</div>
  <div class="desc" id="desc"></div>
</div>
<script>
async function load() {
  try {
    const r = await fetch('https://wttr.in/${encodeURIComponent(c.location || 'New York')}?format=j1');
    const d = await r.json();
    const cur = d.current_condition[0];
    const unit = '${c.units === 'metric' ? 'temp_C' : 'temp_F'}';
    const deg = '${c.units === 'metric' ? '°C' : '°F'}';
    document.getElementById('temp').textContent = cur[unit] + deg;
    document.getElementById('desc').textContent = cur.weatherDesc[0].value;
    const code = parseInt(cur.weatherCode);
    const icons = {113:'☀️',116:'⛅',119:'☁️',122:'☁️',143:'🌫️',176:'🌧️',200:'⛈️',227:'🌨️',260:'🌫️',263:'🌧️',266:'🌧️',293:'🌧️',296:'🌧️',299:'🌧️',302:'🌧️',305:'🌧️',308:'🌧️',311:'🌧️',314:'🌧️',317:'🌧️',320:'🌨️',323:'🌨️',326:'🌨️',329:'🌨️',332:'🌨️',335:'🌨️',338:'🌨️',350:'🌧️',353:'🌧️',356:'🌧️',359:'🌧️',362:'🌨️',365:'🌨️',368:'🌨️',371:'🌨️',374:'🌨️',377:'🌨️',386:'⛈️',389:'⛈️',392:'⛈️',395:'🌨️'};
    document.getElementById('icon').textContent = icons[code] || '🌡️';
  } catch(e) { document.getElementById('desc').textContent = 'Weather unavailable'; }
}
load(); setInterval(load, 600000);
</script></body></html>`;
}

function renderRSS(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${safeCss(c.background, '#000')}; height:100vh; overflow:hidden; font-family:-apple-system,sans-serif; }
  .ticker { display:flex; align-items:center; height:100%; white-space:nowrap; animation:scroll ${safeNumber(c.scroll_speed, 30)}s linear infinite; }
  .item { display:inline-block; padding:0 40px; font-size:${safeNumber(c.font_size, 24)}px; color:${safeCss(c.color, '#FFF')}; }
  .item .title { font-weight:600; }
  .item .sep { margin:0 20px; opacity:0.3; }
  @keyframes scroll { 0%{transform:translateX(100vw)} 100%{transform:translateX(-100%)} }
</style></head><body>
<div class="ticker" id="ticker"><div class="item">Loading feed...</div></div>
<script>
async function load() {
  try {
    const r = await fetch('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent('${escapeHtml(c.feed_url) || ''}'));
    const d = await r.json();
    const items = d.items?.slice(0, ${safeNumber(c.max_items, 10)}) || [];
    // NOTE: RSS feed titles are external content - using textContent instead of innerHTML to prevent XSS
    document.getElementById('ticker').innerHTML = items.map(i => {
      const el = document.createElement('span'); el.textContent = i.title;
      return '<div class="item"><span class="title">' + el.innerHTML + '</span></div><div class="item sep">•</div>';
    }).join('') || '<div class="item">No items</div>';
  } catch(e) { document.getElementById('ticker').innerHTML = '<div class="item">Feed unavailable</div>'; }
}
load(); setInterval(load, 300000);
</script></body></html>`;
}

function renderText(c) {
  // Designer preview uses fontSize/10 vw, but older published HTML used fontSize*10.8 px.
  // Convert any px-based font sizes to vw so they scale to any viewport: px / 108 = vw
  let html = c.html || '<p style="color:white;padding:20px">Empty text widget</p>';
  html = html.replace(/font-size:\s*([\d.]+)px/g, (match, px) => {
    return `font-size:${(parseFloat(px) / 108).toFixed(2)}vw`;
  });
  // Security: c.html / c.css are intentionally raw user-authored content, but the
  // render is public and same-origin with the dashboard - injected <script> could
  // otherwise read the dashboard's localStorage JWT. Render the user content inside
  // a sandboxed iframe with NO allow-same-origin: scripts still run (so legit
  // widget markup works) but in a null origin that can't touch the app's storage.
  const inner = `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:100vw; height:100vh; overflow:hidden; }
  ${c.css || ''}
</style></head><body>${html}</body></html>`;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; }
  html, body { width:100vw; height:100vh; overflow:hidden; background:${safeCss(c.background, 'transparent')}; }
  iframe { width:100%; height:100%; border:0; display:block; }
</style></head><body><iframe sandbox="allow-scripts" srcdoc="${escapeHtml(inner)}"></iframe></body></html>`;
}

function renderWebpage(c) {
  const zoom = (c.zoom || 100) / 100;
  const invZoom = 100 / (c.zoom || 100) * 100;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; } body { height:100vh; overflow:hidden; }
  iframe { width:${invZoom}%; height:${invZoom}%; border:0; transform:scale(${zoom}); transform-origin:0 0; }
</style></head><body>
<iframe src="${escapeHtml(safeUrl(c.url))}" sandbox="allow-scripts"></iframe>
${c.refresh_interval > 0 ? `<script>setInterval(()=>document.querySelector('iframe').src=document.querySelector('iframe').src,${c.refresh_interval * 1000});</script>` : ''}
</body></html>`;
}

function renderSocial(c) {
  return `<!DOCTYPE html><html><head><style>
  body { background:${safeCss(c.background, '#000')}; color:${safeCss(c.color, '#FFF')}; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
</style></head><body>
<div style="text-align:center">
  <p style="font-size:24px">Social Feed</p>
  <p style="opacity:0.5;margin-top:8px">${escapeHtml(c.platform) || 'twitter'}: ${escapeHtml(c.query) || ''}</p>
  <p style="opacity:0.3;margin-top:16px;font-size:13px">Configure API key in widget settings</p>
</div></body></html>`;
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

  .page { position:fixed; inset:0; overflow:hidden; transition: transform 1.5s ease; will-change: transform; }

  .bg-layer { position:absolute; inset:0; z-index:0; }
  .bg-img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; transition: opacity 2s ease-in-out; }
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

  .entries { display:grid; gap:14px 36px; }
  .entries[data-cols="auto"] { grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); }
  .entries[data-cols="1"] { grid-template-columns: 1fr; }
  .entries[data-cols="2"] { grid-template-columns: repeat(2, 1fr); }
  .entries[data-cols="3"] { grid-template-columns: repeat(3, 1fr); }
  .entries[data-cols="4"] { grid-template-columns: repeat(4, 1fr); }

  .entry { font-size:38px; line-height:1.35; color:#fff; display:flex; gap:14px; align-items:baseline; }
  .entry .id { font-weight:600; min-width:3.5em; flex-shrink:0; }
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

  .entry { display:flex; gap:14px; align-items:baseline; padding:10px 8px; font-size:30px; line-height:1.3; border-radius:8px; }
  .entry:nth-child(even) { background:rgba(255,255,255,0.03); }
  body.light .entry:nth-child(even) { background:rgba(0,0,0,0.03); }
  .entry .id { font-weight:700; min-width:2.6em; flex-shrink:0; }
  .entry .text { display:flex; flex-direction:column; flex:1; min-width:0; }
  .entry .nm { font-weight:400; }
  .entry .sub { font-size:0.6em; opacity:0.6; margin-top:3px; }
  .entry.available, .entry.available .id { color:#00ff00; }
  body.light .entry.available, body.light .entry.available .id { color:#059669; }

  .keyboard { flex:0 0 auto; padding:8px 12px 14px; background:rgba(0,0,0,0.25); user-select:none; }
  body.light .keyboard { background:rgba(0,0,0,0.05); }
  .krow { display:flex; gap:6px; justify-content:center; margin-bottom:6px; }
  .key {
    flex:1 1 0; max-width:96px; min-width:0; height:56px; font-size:24px; text-transform:uppercase;
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
    .key { height:46px; font-size:20px; }
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
  .row{display:flex;align-items:center;gap:1.4vw;padding:1.5vh 2vw;border-bottom:1px solid #20293a;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:2.6vh}
  .row .n{color:#54a6ff;min-width:3.2em;font-variant-numeric:tabular-nums}
  .row:nth-child(3n) .n{color:#37d391}
  .sweep{position:absolute;top:0;right:0;width:48%;height:100%;background:repeating-linear-gradient(90deg,#0f1420 0 3vw,#182234 3vw 6vw)}
  .marker{position:absolute;top:0;bottom:0;width:.5vw;background:#f5b451;box-shadow:0 0 3vw #f5b451;will-change:transform;animation:sweep 2s linear infinite}
  @keyframes sweep{from{transform:translateX(0)}to{transform:translateX(calc(48vw - .5vw))}}
  .tag{position:absolute;top:1.5vh;font-family:ui-monospace,monospace;font-size:1.6vh;color:#6d7789;z-index:2}
  .col .tag{left:1.5vw;background:#0a0d13;padding:.4vh .8vw;border-radius:4px}
  .sweep .tag{right:1.5vw}
  .hud{position:absolute;left:50%;bottom:3vh;transform:translateX(-50%);background:rgba(12,16,24,.94);border:1px solid #20293a;border-radius:14px;padding:2.2vh 2.4vw;min-width:64vw;z-index:6;box-shadow:0 1.4vh 4vh rgba(0,0,0,.55)}
  .verdict{display:flex;align-items:center;gap:1.4vw;margin-bottom:1.8vh}
  .dot{width:1.8vh;height:1.8vh;border-radius:50%;background:#6d7789}
  .verdict.smooth .dot{background:#37d391;box-shadow:0 0 0 .6vh rgba(55,211,145,.16)}
  .verdict.stall .dot{background:#ff5d5d;box-shadow:0 0 0 .6vh rgba(255,93,93,.18)}
  .verdict .txt{font-size:3.4vh;font-weight:750;letter-spacing:.01em}
  .verdict.smooth .txt{color:#37d391}.verdict.stall .txt{color:#ff5d5d}
  .verdict .sub{font-size:1.9vh;color:#6d7789;font-weight:400;margin-left:auto;text-align:right}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1.2vw;margin-bottom:1.4vh}
  .stat{background:#121826;border:1px solid #20293a;border-radius:10px;padding:1.2vh 1vw}
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


function renderCrypto() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Crypto Ticker</title>
  <style>
    :root{ --bg: #0b0f17; --panel: rgba(15, 20, 31, 0.78); --panel-2: rgba(255,255,255,0.04); --text: #e8eefc; --muted: #8b96ad; --line: rgba(255,255,255,0.08); --green: #2fe38a; --red: #ff5d73; --shadow: 0 20px 60px rgba(0,0,0,.45); }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: radial-gradient(circle at top left, rgba(122,162,255,0.14), transparent 30%), radial-gradient(circle at bottom right, rgba(47,227,138,0.10), transparent 28%), linear-gradient(180deg, #090d14, #0b0f17 40%, #090d14); font-family: Inter, system-ui, sans-serif; color: var(--text); }
    .wrap { width: 100vw; height: 100vh; padding: 28px; display: flex; align-items: center; justify-content: center; }
    .card { width: min(1200px, 100%); border: 1px solid var(--line); border-radius: 24px; background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)); box-shadow: var(--shadow); backdrop-filter: blur(18px); overflow: hidden; position: relative; }
    .header { padding: 22px 24px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent); }
    .title h1 { margin: 0; font-size: 18px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
    .title p { margin: 0; color: var(--muted); font-size: 13px; }
    .status { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 13px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: var(--green); box-shadow: 0 0 16px rgba(47,227,138,.75); animation: pulse 1.8s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { transform: scale(0.95); opacity: 0.85; } 50% { transform: scale(1.2); opacity: 1; } }
    .ticker { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; }
    .coin { padding: 22px 24px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); min-height: 132px; background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent); }
    .coin:nth-child(4n) { border-right: none; }
    .coin-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 16px; }
    .name { display: flex; align-items: center; gap: 12px; }
    .badge { width: 40px; height: 40px; border-radius: 14px; display: grid; place-items: center; font-weight: 800; color: #fff; background: linear-gradient(135deg, rgba(122,162,255,0.95), rgba(47,227,138,0.8)); box-shadow: 0 10px 30px rgba(122,162,255,0.18); }
    .symbol { font-size: 16px; font-weight: 700; margin: 0; }
    .full { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .price { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; margin: 0; }
    .change { margin-top: 10px; display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; font-size: 13px; font-weight: 700; background: var(--panel-2); border: 1px solid var(--line); }
    .up { color: var(--green); } .down { color: var(--red); }
    .footer { padding: 14px 24px; color: var(--muted); font-size: 12px; background: rgba(255,255,255,0.02); overflow: hidden; white-space: nowrap; }
    .marquee span { display: inline-block; padding-left: 100%; animation: scroll 26s linear infinite; }
    @keyframes scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-100%); } }
  </style>
</head>
<body>
  <div class="wrap"><div class="card">
    <div class="header">
      <div class="title"><h1>Live Crypto Ticker</h1><p>Premium market snapshot</p></div>
      <div class="status"><span class="dot"></span><span id="updated">Updating…</span></div>
    </div>
    <div class="ticker" id="ticker"><div class="coin">Loading…</div></div>
    <div class="footer"><div class="marquee"><span id="marqueeText">Fetching live data…</span></div></div>
  </div></div>
  <script>
    const assets = [
      { id: "bitcoin", symbol: "BTC", name: "Bitcoin" },
      { id: "ethereum", symbol: "ETH", name: "Ethereum" },
      { id: "solana", symbol: "SOL", name: "Solana" },
      { id: "ripple", symbol: "XRP", name: "XRP" }
    ];
    const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    function fallbackData() { return assets.map((a, i) => { const base = [118000, 3700, 172, 0.62][i]; const delta = (Math.random() * 4 - 2); return { id: a.id, symbol: a.symbol, name: a.name, price: base * (1 + delta / 100), change24h: delta }; }); }
    function render(items) {
      document.getElementById("ticker").innerHTML = items.map((c, i) => {
        const isUp = c.change24h >= 0; const accent = ["#7aa2ff", "#2fe38a", "#ffb86b", "#c77dff"][i % 4];
        return `<div class="coin">
          <div class="coin-top"><div class="name"><div class="badge" style="background: linear-gradient(135deg, ${accent}, rgba(255,255,255,0.18));">${c.symbol[0]}</div>
          <div><p class="symbol">${c.symbol}</p><div class="full">${c.name}</div></div></div></div>
          <p class="price">${fmt.format(c.price)}</p>
          <div class="change ${isUp ? 'up' : 'down'}"><span>${isUp ? '▲' : '▼'} ${(c.change24h>=0?'+':'')+c.change24h.toFixed(2)}%</span></div>
        </div>`;
      }).join("");
      document.getElementById("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
      document.getElementById("marqueeText").textContent = items.map(c => `${c.symbol} ${fmt.format(c.price)} • ${(c.change24h>=0?'+':'')+c.change24h.toFixed(2)}%`).join("   •   ");
    }
    async function loadData() {
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${assets.map(a=>a.id).join(',')}&vs_currencies=usd&include_24hr_change=true`);
        const data = await res.json();
        const items = assets.map(a => ({ ...a, price: data[a.id]?.usd || 0, change24h: data[a.id]?.usd_24h_change || 0 }));
        if (!items.some(x => x.price)) throw new Error("No price"); render(items);
      } catch (e) { render(fallbackData()); }
    }
    loadData(); setInterval(loadData, 30000);
  </script>
</body></html>`;
}

function renderWorldClock() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>World Clock</title>
  <style>
    :root{ --bg: #090c12; --line: rgba(255,255,255,0.08); --text: #eef3ff; --muted: #93a0b8; --accent: #7aa2ff; --glow: rgba(122,162,255,0.18); }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: radial-gradient(circle at 20% 20%, rgba(122,162,255,0.14), transparent 26%), radial-gradient(circle at 80% 80%, rgba(47,227,138,0.10), transparent 24%), linear-gradient(180deg, #070a10, #090c12 50%, #070a10); color: var(--text); font-family: Inter, system-ui, sans-serif; }
    .wrap { width: 100vw; height: 100vh; display: grid; place-items: center; padding: 28px; }
    .panel { width: min(980px, 100%); border-radius: 28px; border: 1px solid var(--line); background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)); box-shadow: 0 22px 70px rgba(0,0,0,.48); backdrop-filter: blur(18px); overflow: hidden; position: relative; }
    .top { display: flex; justify-content: space-between; align-items: center; padding: 22px 24px; border-bottom: 1px solid var(--line); }
    .brand h1 { margin: 0; font-size: 22px; font-weight: 800; }
    .kicker { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
    .clock-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); }
    .clock { background: rgba(10, 14, 22, 0.72); padding: 26px 24px; min-height: 176px; display: flex; flex-direction: column; justify-content: space-between; }
    .city h2 { margin: 0; font-size: 18px; font-weight: 700; }
    .tz { color: var(--muted); font-size: 12px; }
    .time { font-size: 54px; line-height: 1; font-weight: 800; letter-spacing: -0.05em; }
    .date { margin-top: 10px; color: var(--muted); font-size: 13px; }
    .accent { margin-top: 18px; height: 4px; width: 72px; border-radius: 999px; background: linear-gradient(90deg, var(--accent), rgba(47,227,138,0.95)); box-shadow: 0 0 24px var(--glow); }
  </style>
</head>
<body>
  <div class="wrap"><section class="panel">
    <div class="top"><div class="brand"><div class="kicker">Global time</div><h1>Minimal World Clock</h1></div><div class="kicker">Live</div></div>
    <div class="clock-grid">
      <div class="clock" data-tz="America/New_York"><div class="city"><h2>New York</h2><div class="tz">America/New_York</div></div><div><div class="time">--:--</div><div class="date">---</div><div class="accent"></div></div></div>
      <div class="clock" data-tz="Europe/London"><div class="city"><h2>London</h2><div class="tz">Europe/London</div></div><div><div class="time">--:--</div><div class="date">---</div><div class="accent"></div></div></div>
      <div class="clock" data-tz="Asia/Tokyo"><div class="city"><h2>Tokyo</h2><div class="tz">Asia/Tokyo</div></div><div><div class="time">--:--</div><div class="date">---</div><div class="accent"></div></div></div>
    </div>
  </section></div>
  <script>
    const clocks = [...document.querySelectorAll(".clock")];
    function updateClocks() {
      const now = new Date();
      clocks.forEach((c, i) => {
        const tz = c.dataset.tz;
        c.querySelector(".time").textContent = now.toLocaleTimeString("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        c.querySelector(".date").textContent = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "2-digit" }).format(now);
        c.querySelector(".accent").style.background = `linear-gradient(90deg, hsl(${220 + i*28} 90% 72%), hsl(${255 + i*28} 85% 60%))`;
      });
    }
    updateClocks(); setInterval(updateClocks, 1000);
  </script>
</body></html>`;
}
