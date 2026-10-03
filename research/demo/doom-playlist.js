'use strict';
// Upgrades the demo's DOOM template from a .sttemplate and makes a playlist with ONLY that widget:
// a single-item playlist never advances, so a game is not cut off mid-level.
const fs = require('fs');
const BASE = 'http://127.0.0.1:3098';
const [,, file, email, password] = process.argv;
async function call(token, method, url, body, raw) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
}
(async () => {
  const { token } = await call(null, 'POST', '/api/auth/login', { email, password });
  const row = await call(token, 'POST', '/api/templates/import', fs.readFileSync(file), true);
  const widgets = await call(token, 'GET', '/api/widgets');
  const w = widgets.find((x) => x.widget_type === 'template' && JSON.parse(x.config || '{}').template === row.key);
  const pls = await call(token, 'GET', '/api/playlists');
  const list = Array.isArray(pls) ? pls : (pls.playlists || []);
  let pl = list.find((p) => p.name === 'DOOM');
  if (!pl) {
    pl = await call(token, 'POST', '/api/playlists', { name: 'DOOM' });
    pl = pl.playlist || pl;
    await call(token, 'POST', `/api/playlists/${pl.id}/items`, { widget_id: w.id, duration_sec: 3600 });
  }
  try { await call(token, 'POST', `/api/playlists/${pl.id}/publish`, {}); } catch (e) { /* not every build needs it */ }
  console.log(`installed ${row.key} v${row.version}; widget ${w.id}; playlist "DOOM" ${pl.id}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
