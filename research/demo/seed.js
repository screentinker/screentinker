'use strict';
// Seeds the demo server over its real API, the way the dashboard would.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DEMO = process.argv[2];
const BASE = 'http://127.0.0.1:3098';
const EMAIL = 'demo@screentinker.local';
const PASSWORD = 'Demo-' + crypto.randomBytes(6).toString('base64url');

async function call(token, method, url, body, raw) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${text.slice(0, 300)}`);
  return json;
}

(async () => {
  const reg = await call(null, 'POST', '/api/auth/register', { email: EMAIL, password: PASSWORD, name: 'Demo Admin' });
  let token = reg.token || (await call(null, 'POST', '/api/auth/login', { email: EMAIL, password: PASSWORD })).token;

  // The offline bundle: exactly the air-gapped path (no network needed).
  await call(token, 'POST', '/api/templates/import?kind=bundle', fs.readFileSync(path.join(DEMO, 'offline.zip')), true);
  const lib = await call(token, 'GET', '/api/templates/library');
  for (const c of lib.catalogs) for (const t of c.templates) {
    await call(token, 'POST', '/api/templates/install', { catalog: c.id, id: t.id });
  }

  // A weather source. Its first fetch goes to Open-Meteo; if this machine cannot reach it, the
  // weather templates show their "waiting for data" state instead.
  let ds = null;
  try {
    ds = await call(token, 'POST', '/api/data-sources', { name: 'London weather', type: 'weather', config: { location: 'London', units: 'metric', locale: 'en', interval_min: 15 } });
  } catch (e) { console.log('weather source: ' + e.message); }
  const slug = ds && (ds.slug || (ds.data_source && ds.data_source.slug));

  const uses = [
    ['official/lobby-welcome', 'Lobby welcome', {}],
    ['official/news-ticker', 'News ticker', {}],
    ['official/weather-forecast', 'Weather forecast', slug ? { weather: slug } : null],
    ['official/weather-html', 'Weather (animated)', slug ? { weather: slug } : {}],
  ];
  const widgets = [];
  for (const [key, name, values] of uses) {
    if (!values) continue;
    const [cat, id] = key.split('/');
    try { widgets.push(await call(token, 'POST', `/api/templates/installed/${cat}/${id}/use`, { name, values })); }
    catch (e) { console.log(`${name}: ${e.message}`); }
  }
  try {
    const pl = await call(token, 'POST', '/api/playlists', { name: 'Templates demo' });
    const pid = pl.id || (pl.playlist && pl.playlist.id);
    for (const w of widgets) await call(token, 'POST', `/api/playlists/${pid}/items`, { widget_id: w.id, duration_sec: 12 });
  } catch (e) { console.log('playlist: ' + e.message); }

  console.log(`\nDashboard: ${BASE}/app   (or http://<this-machine-ip>:3098/app)`);
  console.log(`Login:     ${EMAIL}`);
  console.log(`Password:  ${PASSWORD}`);
  console.log('\nFull-screen renders (what a screen shows):');
  for (const w of widgets) console.log(`  ${w.name.padEnd(20)} ${BASE}/api/widgets/${w.id}/render`);
})().catch((e) => { console.error(e.message); process.exit(1); });
