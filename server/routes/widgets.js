const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const appConfig = require('../config');

// For preview only: inline /api/content/:id/file and /thumbnail URLs as data URIs,
// scoped to the current user. Lets the srcdoc preview iframe show logos/bg images
// before the widget is saved (post-save they're reachable via the widget-reference gate).
const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10MB cap — base64 expands ~1.33x
const MIME_RE = /^image\/[a-zA-Z0-9.+-]+$/;
function inlineUserContent(html, userId) {
  return html.replace(/\/api\/content\/([a-f0-9-]+)\/(file|thumbnail)/gi, (match, id, kind) => {
    const c = db.prepare('SELECT filepath, thumbnail_path, mime_type, user_id FROM content WHERE id = ?').get(id);
    if (!c || c.user_id !== userId) return match;
    const filename = kind === 'thumbnail' ? c.thumbnail_path : c.filepath;
    if (!filename) return match;
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

// List widgets
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const widgets = db.prepare(
    `SELECT * FROM widgets ${isAdmin ? '' : 'WHERE user_id = ? OR user_id IS NULL'} ORDER BY created_at DESC`
  ).all(...(isAdmin ? [] : [req.user.id]));
  res.json(widgets);
});

// Create widget
router.post('/', (req, res) => {
  const { widget_type, name, config } = req.body;
  if (!widget_type || !name) return res.status(400).json({ error: 'widget_type and name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO widgets (id, user_id, widget_type, name, config) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.user.id, widget_type, name, JSON.stringify(config || {}));

  res.status(201).json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(id));
});

// Helper: check widget ownership
function checkWidgetAccess(req, res) {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) { res.status(404).json({ error: 'Widget not found' }); return null; }
  // Allow access if: admin, owner, no owner (public), or render route (no req.user)
  if (req.user && !['admin','superadmin'].includes(req.user.role) && widget.user_id && widget.user_id !== req.user.id) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return widget;
}

// Get widget
router.get('/:id', (req, res) => {
  const widget = checkWidgetAccess(req, res);
  if (!widget) return;
  res.json(widget);
});

// Update widget
router.put('/:id', (req, res) => {
  const widget = checkWidgetAccess(req, res);
  if (!widget) return;

  const { name, config } = req.body;
  if (name) db.prepare('UPDATE widgets SET name = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(name, req.params.id);
  if (config) db.prepare('UPDATE widgets SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?').run(JSON.stringify(config), req.params.id);

  res.json(db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id));
});

// Delete widget
router.delete('/:id', (req, res) => {
  const widget = checkWidgetAccess(req, res);
  if (!widget) return;
  db.prepare('DELETE FROM widgets WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

const KNOWN_WIDGET_TYPES = new Set(['clock','weather','rss','text','webpage','social','directory-board']);
function renderWidgetHtml(type, config) {
  config = config || {};
  switch (type) {
    case 'clock': return renderClock(config);
    case 'weather': return renderWeather(config);
    case 'rss': return renderRSS(config);
    case 'text': return renderText(config);
    case 'webpage': return renderWebpage(config);
    case 'social': return renderSocial(config);
    case 'directory-board': return renderDirectoryBoard(config);
    default: return '<html><body style="color:white;background:black;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>Unknown widget</h1></body></html>';
  }
}

// Render widget as HTML page
router.get('/:id/render', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');
  const config = JSON.parse(widget.config || '{}');
  res.setHeader('Content-Type', 'text/html');
  res.send(renderWidgetHtml(widget.widget_type, config));
});

// Preview unsaved widget from config (used by editor Preview button)
router.post('/preview', (req, res) => {
  const { widget_type, config } = req.body || {};
  if (!widget_type || typeof widget_type !== 'string') return res.status(400).json({ error: 'widget_type required' });
  if (!KNOWN_WIDGET_TYPES.has(widget_type)) return res.status(400).json({ error: 'Unknown widget_type' });
  let html = renderWidgetHtml(widget_type, config || {});
  if (req.user && req.user.id) html = inlineUserContent(html, req.user.id);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

function renderClock(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${c.background || 'transparent'}; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; overflow:hidden; }
  #time { font-size:${c.font_size || 64}px; font-weight:700; color:${c.color || '#FFFFFF'}; }
  #date { font-size:${Math.max(16, (c.font_size || 64) / 3)}px; color:${c.color || '#FFFFFF'}; opacity:0.7; margin-top:8px; }
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
  body { background:${c.background || 'transparent'}; display:flex; align-items:center; justify-content:center; height:100vh; font-family:-apple-system,sans-serif; color:${c.color || '#FFF'}; }
  .weather { text-align:center; }
  .temp { font-size:${c.font_size || 48}px; font-weight:700; }
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
  body { background:${c.background || '#000'}; height:100vh; overflow:hidden; font-family:-apple-system,sans-serif; }
  .ticker { display:flex; align-items:center; height:100%; white-space:nowrap; animation:scroll ${c.scroll_speed || 30}s linear infinite; }
  .item { display:inline-block; padding:0 40px; font-size:${c.font_size || 24}px; color:${c.color || '#FFF'}; }
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
    const items = d.items?.slice(0, ${c.max_items || 10}) || [];
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
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${c.background || 'transparent'}; width:100vw; height:100vh; overflow:hidden; }
  ${c.css || ''}
</style></head><body>${html}</body></html>`;
  // NOTE: c.html is intentionally rendered as raw HTML - this is user-authored content for the text widget
}

function renderWebpage(c) {
  const zoom = (c.zoom || 100) / 100;
  const invZoom = 100 / (c.zoom || 100) * 100;
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; } body { height:100vh; overflow:hidden; }
  iframe { width:${invZoom}%; height:${invZoom}%; border:0; transform:scale(${zoom}); transform-origin:0 0; }
</style></head><body>
<iframe src="${escapeHtml(safeUrl(c.url))}" sandbox="allow-scripts allow-same-origin"></iframe>
${c.refresh_interval > 0 ? `<script>setInterval(()=>document.querySelector('iframe').src=document.querySelector('iframe').src,${c.refresh_interval * 1000});</script>` : ''}
</body></html>`;
}

function renderSocial(c) {
  return `<!DOCTYPE html><html><head><style>
  body { background:${c.background || '#000'}; color:${c.color || '#FFF'}; font-family:-apple-system,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
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
  .track { position:absolute; top:0; left:0; right:0; will-change: transform; }
  .block { padding:0 48px 24px; }
  .block + .block { padding-top:24px; }

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

  .gap { height:120px; }

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
      <div class="track" id="track"></div>
    </div>
    <footer class="footer" id="footer"></footer>
  </div>

<script>
(function(){
  var cfg = ${configJson};
  var SPEEDS = { slow: 20, medium: 45, fast: 75 };

  if (cfg.theme === 'light') document.body.classList.add('light');
  var GAP_PX = 100;
  var MIN_SCROLL_PX_SEC = 5; // anti-burn-in minimum when content fits

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
  if (cfg.title) {
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

  function buildBlock() {
    var block = document.createElement('div');
    block.className = 'block';
    var cats = Array.isArray(cfg.categories) ? cfg.categories : [];
    cats.forEach(function(cat){
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
      block.appendChild(catEl);
    });
    return block;
  }

  var track = document.getElementById('track');
  var baseBlock = buildBlock();
  track.appendChild(baseBlock);

  // ----- measure + clone enough copies to fill (seamless loop) -----
  function setupScroll() {
    // remove any previous clones (on resize)
    while (track.children.length > 1) track.removeChild(track.lastChild);
    var gap = document.createElement('div');
    gap.className = 'gap';
    track.appendChild(gap);

    var baseH = baseBlock.getBoundingClientRect().height;
    var cycleH = baseH + GAP_PX; // distance to translate per loop
    var viewH = scroller.getBoundingClientRect().height || window.innerHeight;

    // Clone enough times so track fills scroller + at least one full cycle
    // Minimum 1 clone (so we can loop). Target: track_height >= view + cycle.
    var cloneCount = Math.max(1, Math.ceil((viewH + cycleH) / cycleH));
    for (var i = 0; i < cloneCount; i++) {
      track.appendChild(buildBlock());
      if (i < cloneCount - 1) {
        var g = document.createElement('div');
        g.className = 'gap';
        track.appendChild(g);
      }
    }

    // speed
    var contentFits = baseH <= viewH;
    var speedName = cfg.scroll_speed || 'medium';
    var speedPxSec = SPEEDS[speedName] || SPEEDS.medium;
    if (contentFits) speedPxSec = MIN_SCROLL_PX_SEC;

    var duration = cycleH / speedPxSec;

    // inject keyframes
    var oldStyle = document.getElementById('scroll-kf');
    if (oldStyle) oldStyle.remove();
    var style = document.createElement('style');
    style.id = 'scroll-kf';
    style.textContent =
      '@keyframes dir-scroll { from { transform: translateY(0); } to { transform: translateY(-' + cycleH + 'px); } }' +
      '.track { animation: dir-scroll ' + duration + 's linear infinite; }';
    document.head.appendChild(style);
  }

  // wait for images (logo + bgs) to load before measuring, so heights are correct
  var pendingImgs = Array.from(document.images).filter(function(i){ return !i.complete; });
  if (pendingImgs.length === 0) {
    setupScroll();
  } else {
    var done = 0;
    pendingImgs.forEach(function(i){
      var onDone = function(){ done++; if (done === pendingImgs.length) setupScroll(); };
      i.addEventListener('load', onDone, { once:true });
      i.addEventListener('error', onDone, { once:true });
    });
    // hard timeout so we never hang
    setTimeout(function(){ if (document.getElementById('scroll-kf') == null) setupScroll(); }, 5000);
  }

  // re-layout on resize (debounced)
  var rT;
  window.addEventListener('resize', function(){
    clearTimeout(rT);
    rT = setTimeout(function(){ layoutScroller(); setupScroll(); }, 250);
  });

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

module.exports = router;
