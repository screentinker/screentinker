const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

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

// Render widget as HTML page
router.get('/:id/render', (req, res) => {
  const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(req.params.id);
  if (!widget) return res.status(404).send('Widget not found');

  const config = JSON.parse(widget.config || '{}');
  let html = '';

  switch (widget.widget_type) {
    case 'clock':
      html = renderClock(config);
      break;
    case 'weather':
      html = renderWeather(config);
      break;
    case 'rss':
      html = renderRSS(config);
      break;
    case 'text':
      html = renderText(config);
      break;
    case 'webpage':
      html = renderWebpage(config);
      break;
    case 'social':
      html = renderSocial(config);
      break;
    default:
      html = '<html><body style="color:white;background:black;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h1>Unknown widget</h1></body></html>';
  }

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
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:${c.background || 'transparent'}; height:100vh; overflow:hidden; }
  ${c.css || ''}
</style></head><body>${c.html || '<p style="color:white;padding:20px">Empty text widget</p>'}</body></html>`;
  // NOTE: c.html is intentionally rendered as raw HTML - this is user-authored content for the text widget
}

function renderWebpage(c) {
  return `<!DOCTYPE html><html><head><style>
  * { margin:0; } body { height:100vh; overflow:hidden; }
  iframe { width:100%; height:100%; border:0; transform:scale(${(c.zoom || 100) / 100}); transform-origin:0 0; }
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

module.exports = router;
