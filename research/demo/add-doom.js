'use strict';
// Adds the local-only DOOM template to the running demo server, via the real API.
// Needs "Allow unsigned code templates" switched on by an admin first (Templates -> Settings).
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
  const w = await call(token, 'POST', `/api/templates/installed/${row.catalog}/${row.id}/use`, { name: 'DOOM (attract mode)', values: {} });
  const pls = await call(token, 'GET', '/api/playlists');
  const pl = (Array.isArray(pls) ? pls : pls.playlists || []).find((p) => p.name === 'Templates demo');
  if (pl) await call(token, 'POST', `/api/playlists/${pl.id}/items`, { widget_id: w.id, duration_sec: 60 });
  console.log(`installed ${row.key} (${row.trust}), widget ${w.id}`);
  console.log(`${BASE}/api/widgets/${w.id}/render`);
})().catch((e) => { console.error(e.message); process.exit(1); });
