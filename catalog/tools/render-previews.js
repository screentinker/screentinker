#!/usr/bin/env node
'use strict';

/*
 * Render every template in a signed offline bundle THROUGH THE REAL SERVER CODE and screenshot it.
 *
 * This is what the reviewer looks at on a pull request (validate.yml "render"), and what a
 * maintainer runs before signing. It never touches a real server or the real catalog key:
 *
 *   - the database and template store live in a throwaway DATA_DIR;
 *   - the bundle must be signed by a THROWAWAY key whose public half is given with --pubkey and
 *     installed as TEMPLATE_CATALOG_PUBLIC_KEY for this process only;
 *   - every template goes through catalog.importOfflineBundle → installFromCatalog →
 *     widget.buildConfig (strict value checks) → widget.renderTemplateWidget, exactly as on a server;
 *   - each document is served from a local HTTP server WITH THE CSP HEADER the server returned, so
 *     a template that needs a host it did not declare, or an inline handler the policy blocks,
 *     fails here the way it would fail on a screen.
 *
 *   node tools/render-previews.js --st <screentinker checkout> --bundle offline.zip --pubkey pub.pem \
 *        --out screenshots/ [--thumbs templates/] [--sizes 1920x200,...] [--chrome /path/to/chrome]
 *
 * Weather templates are bound to a demo Weather data source with realistic cached values, and the
 * page clock is pinned to Tue 6 Oct 2026 10:09 Europe/London so screenshots are reproducible.
 * Exit code 1 if any template failed to install/render or threw a page error / CSP violation.
 * Silent: Chrome runs with --mute-audio.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const ST = path.resolve(arg('st', path.join(__dirname, '..', '..')));
const BUNDLE = arg('bundle') ? path.resolve(arg('bundle')) : null;
const PUBKEY = arg('pubkey');
const OUT = path.resolve(arg('out', 'screenshots'));
const THUMBS = arg('thumbs') ? path.resolve(arg('thumbs')) : null;
const CHROME = arg('chrome', process.env.CHROME_PATH || '');
// Extra zone shapes to screenshot besides full HD, e.g. --sizes 1920x200,1080x1920 (a strip, portrait).
const SIZES = String(arg('sizes', '')).split(',').filter((x) => /^\d{2,4}x\d{2,4}$/.test(x));
if (!BUNDLE || !PUBKEY) {
  console.error('usage: render-previews.js --st <checkout> --bundle <offline.zip> --pubkey <pub.pem> --out <dir> [--thumbs <templates-root>] [--chrome <path>]');
  process.exit(2);
}

/* ---------- a throwaway server environment, BEFORE anything from the server is required ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-render-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'render-previews-' + Date.now();
process.env.TEMPLATE_CATALOG_PUBLIC_KEY = fs.readFileSync(PUBKEY, 'utf8');
process.chdir(path.join(ST, 'server'));

const req = (p) => require(path.join(ST, 'server', p));
const { db } = req('db/database');
const catalog = req('lib/templates/catalog');
const store = req('lib/templates/store');
const tplWidget = req('lib/templates/widget');
const signing = req('lib/templates/signing');
const puppeteer = req('node_modules/puppeteer-core');

const WS = 'ws-render';
const USER = 'u-render';

function seed() {
  db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, 'render@example.invalid', 'platform_admin', 'x')").run(USER);
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('org-render', 'Render', ?)").run(USER);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, 'org-render', 'Render')").run(WS);
}

/* Realistic cached values for the built-in Weather data source (lib/data-sources/weather-resolver.js keys). */
function weatherData(kind) {
  const days = ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const presets = {
    sunny: { t: 18, feel: 17, hum: 58, wind: 11, code: 2, cond: 'Partly cloudy', icon: '⛅',
      d: [[2, 19, 9, 10], [0, 21, 10, 0], [61, 16, 11, 70], [3, 15, 8, 20], [1, 17, 7, 5], [80, 14, 9, 55]] },
    rain: { t: 11, feel: 8, hum: 88, wind: 24, code: 63, cond: 'Moderate rain', icon: '🌧️',
      d: [[63, 12, 8, 90], [61, 13, 9, 75], [3, 14, 8, 30], [2, 15, 7, 10], [0, 16, 6, 0], [95, 13, 9, 80]] },
    snow: { t: -3, feel: -8, hum: 81, wind: 14, code: 73, cond: 'Moderate snowfall', icon: '🌨️',
      d: [[73, -1, -6, 85], [71, -2, -7, 60], [3, 0, -8, 20], [0, 1, -9, 0], [85, -1, -6, 55], [2, 2, -4, 10]] },
  };
  const p = presets[kind];
  const WMO = { 0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    61: ['Slight rain', '🌦️'], 63: ['Moderate rain', '🌧️'], 71: ['Slight snowfall', '🌨️'], 73: ['Moderate snowfall', '🌨️'],
    80: ['Slight rain showers', '🌦️'], 85: ['Slight snow showers', '🌨️'], 95: ['Thunderstorm', '⛈️'] };
  const out = {
    location: kind === 'snow' ? 'Tromsø' : 'Manchester', temperature: p.t, apparent_temperature: p.feel, humidity: p.hum,
    wind_speed: p.wind, condition: p.cond, icon: p.icon, code: p.code, units: 'C', updated: '2026-10-06 10:00',
  };
  p.d.forEach(([code, hi, lo, pp], i) => {
    Object.assign(out, {
      [`day${i}_name`]: days[i], [`day${i}_date`]: `2026-10-${String(6 + i).padStart(2, '0')}`,
      [`day${i}_high`]: hi, [`day${i}_low`]: lo, [`day${i}_condition`]: WMO[code][0], [`day${i}_icon`]: WMO[code][1],
      [`day${i}_code`]: code, [`day${i}_precip_prob`]: pp,
    });
  });
  return out;
}

function seedWeather() {
  for (const kind of ['sunny', 'rain', 'snow']) {
    db.prepare(`INSERT INTO data_sources (id, workspace_id, slug, name, type, config, cached_data, last_fetched_at, last_status)
      VALUES (?, ?, ?, ?, 'weather', ?, ?, strftime('%s','now'), 'ok')`)
      .run(`ds-${kind}`, WS, `weather-${kind}`, `Weather (${kind})`, JSON.stringify({ location: 'Manchester', units: 'metric' }), JSON.stringify(weatherData(kind)));
  }
}

function resolveData(slug, key) {
  const map = req('lib/data-sources/service').getWorkspaceDataMapSync(WS);
  const d = map[slug] || map[String(slug).toLowerCase()];
  return d && d[key] !== undefined && d[key] !== null ? d[key] : null;
}

/* The variants each template is shown in: the defaults, plus one screenshot per demo weather. */
function variants(manifest) {
  const dsParams = manifest.params.filter((p) => p.type === 'data_source');
  if (!dsParams.length) return [{ suffix: '', values: {} }];
  const bind = (slug) => Object.fromEntries(dsParams.map((p) => [p.name, slug]));
  return [
    { suffix: '', values: bind('weather-sunny') },
    { suffix: '-rain', values: bind('weather-rain') },
    { suffix: '-snow', values: bind('weather-snow') },
  ];
}

async function main() {
  seed();
  const pem = signing.officialPublicKey().export({ type: 'spki', format: 'pem' });
  console.log(`throwaway catalog key_id ${signing.keyId(pem)} (data dir ${TMP})`);
  const r = await catalog.importOfflineBundle(fs.readFileSync(BUNDLE));
  console.log(`offline bundle: catalog ${r.catalog}, serial ${r.serial}, ${r.templates} templates, ${r.packages} packages kept`);
  seedWeather();

  const docs = [];
  let failures = 0;
  const index = catalog.cachedIndex('official');
  for (const t of index.templates) {
    try {
      const row = await catalog.installFromCatalog('official', t.id, null, USER);
      const env = store.loadPackage(row.sha256);
      for (const v of variants(env.manifest)) {
        const config = tplWidget.buildConfig(row.id, v.values, WS);
        const wid = `w-${t.id}${v.suffix}`;
        db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'template', ?, ?)")
          .run(wid, USER, WS, t.id, JSON.stringify(config));
        const widget = db.prepare('SELECT * FROM widgets WHERE id = ?').get(wid);
        const out = tplWidget.renderTemplateWidget(widget, { resolveData, resolveImage: () => null, resolveFont: () => null });
        docs.push({ id: t.id, name: `${t.id}${v.suffix}`, kind: row.kind, trust: row.trust, version: row.version, ...out });
        console.log(`installed ${row.id}@${row.version} (${row.kind}, ${row.trust}) → rendered ${wid}: ${out.html.length} bytes`);
      }
    } catch (e) {
      failures++;
      console.error(`FAILED ${t.id}: ${e.message}`);
    }
  }

  /* A tiny server that sends each document with the CSP the server chose, plus the bundled fonts
   * with the CORS header the real /fonts mount sends (slides are opaque-origin documents). */
  const fontsDir = path.join(ST, 'server', 'fonts');
  const srv = http.createServer((q, s) => {
    const u = new URL(q.url, 'http://x');
    if (u.pathname.startsWith('/fonts/')) {
      const f = path.join(fontsDir, path.basename(u.pathname));
      if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
      s.writeHead(200, { 'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*' });
      return s.end(fs.readFileSync(f));
    }
    const d = docs.find((x) => `/w/${x.name}` === u.pathname);
    if (!d) { s.writeHead(404); return s.end(); }
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': d.csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    s.end(d.html);
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const browser = await puppeteer.launch({
    executablePath: CHROME || undefined, headless: true,
    args: ['--no-sandbox', '--mute-audio', '--disable-gpu', '--font-render-hinting=none', '--hide-scrollbars'],
  });
  fs.mkdirSync(OUT, { recursive: true });
  const FIXED = Date.UTC(2026, 9, 6, 9, 9, 0);   // 10:09 in London
  const notes = new Set();
  for (const d of docs) {
    const page = await browser.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error' || /favicon/.test((m.location() || {}).url || '')) return;
      // Chromium does not implement the CSP `webrtc` directive the server sends (only WebKit does)
      // and says so on every load; that is the server's policy, not the template's fault.
      if (/Unrecognized Content-Security-Policy directive 'webrtc'/.test(m.text())) { notes.add(m.text()); return; }
      problems.push(`console: ${m.text()}`);
    });
    page.on('requestfailed', (rq) => { if (!rq.url().startsWith('data:')) problems.push(`request failed: ${rq.url().slice(0, 120)} ${rq.failure() && rq.failure().errorText}`); });
    await page.emulateTimezone('Europe/London');
    await page.evaluateOnNewDocument((t) => {
      const R = Date; const off = t - R.now();
      // eslint-disable-next-line no-global-assign
      window.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + off); } static now() { return R.now() + off; } };
    }, FIXED);
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(`${base}/w/${d.name}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await new Promise((res) => setTimeout(res, 2600));   // let entrance motion finish
    const shot = path.join(OUT, `${d.name}.png`);
    await page.screenshot({ path: shot });
    if (THUMBS && !d.name.includes('-rain') && !d.name.includes('-snow')) {
      const thumb = path.join(THUMBS, d.id, 'thumbnail.png');
      await page.screenshot({ path: thumb, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 0.25 } });
      console.log(`  thumbnail ${path.relative(process.cwd(), thumb)} (${fs.statSync(thumb).size} bytes)`);
    }
    console.log(`${d.name}: ${shot}${problems.length ? `  PROBLEMS:\n    ${problems.join('\n    ')}` : ''}`);
    if (!d.name.includes('-rain') && !d.name.includes('-snow')) {
      for (const size of SIZES) {
        const [w, h] = size.split('x').map(Number);
        await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
        await page.reload({ waitUntil: 'networkidle0' });
        await new Promise((res) => setTimeout(res, 2600));
        const extra = path.join(OUT, `${d.name}@${size}.png`);
        await page.screenshot({ path: extra });
        console.log(`${d.name}@${size}: ${extra}`);
      }
    }
    if (problems.length) failures++;
    await page.close();
  }
  await browser.close();
  srv.close();
  for (const n of notes) console.log(`note: ${n} (browser, not template)`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures) { console.error(`${failures} problem(s)`); process.exit(1); }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
