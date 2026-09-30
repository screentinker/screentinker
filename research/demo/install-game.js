'use strict';
// Imports a template file into the demo server (upgrading it if already installed), makes sure a
// widget of it exists, and puts that widget alone in a playlist named after it (a single-item
// playlist never advances, so a game is never cut off).
const fs = require('fs');
const BASE = 'http://127.0.0.1:3098';
const [,, file, email, password, playlistName] = process.argv;
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
  let w = widgets.find((x) => x.widget_type === 'template' && JSON.parse(x.config || '{}').template === row.key);
  if (!w) w = await call(token, 'POST', `/api/templates/installed/${row.catalog}/${row.id}/use`, { name: row.name, values: {} });
  const pls = await call(token, 'GET', '/api/playlists');
  let pl = (Array.isArray(pls) ? pls : (pls.playlists || [])).find((p) => p.name === playlistName);
  if (!pl) {
    pl = await call(token, 'POST', '/api/playlists', { name: playlistName });
    pl = pl.playlist || pl;
    await call(token, 'POST', `/api/playlists/${pl.id}/items`, { widget_id: w.id, duration_sec: 3600 });
  }
  try { await call(token, 'POST', `/api/playlists/${pl.id}/publish`, {}); } catch (e) { /* optional */ }
  const devs = await call(token, 'GET', '/api/devices');
  console.log(`installed ${row.key} v${row.version} (${row.trust}); widget ${w.id}; playlist "${playlistName}" ${pl.id}`);
  console.log(`render: ${BASE}/api/widgets/${w.id}/render`);
  console.log('devices:', (Array.isArray(devs) ? devs : devs.devices || []).map((d) => `${d.name || d.id} [${d.status}]`).join(', ') || 'none paired');
})().catch((e) => { console.error(e.message); process.exit(1); });
