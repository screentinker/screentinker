#!/usr/bin/env node
'use strict';
/*
 * Screenshots of the Roku app as the simulator draws it, against a real server.
 *
 *   node roku/tests/screenshot-app.js --out <dir> [--chrome /path/to/chromium] [--seconds 60]
 *
 * Runs brs-engine's BROWSER build (the same interpreter as brs-node, plus its SceneGraph renderer
 * drawing to a canvas) in headless Chromium. The page and the ScreenTinker server are put on ONE
 * origin by a small proxy: the engine uses SharedArrayBuffer, which needs cross-origin isolation,
 * and a cross-origin server would then need CORP headers it has no reason to send.
 *
 * Saves: 01-pairing.png, then one frame every few seconds once the display has a playlist
 * (image, video request, server-rendered widget frame), and a layout run if --layout is given.
 * A visual check, not an assertion suite — run-app.js is the assertion suite.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start, packageApp, REPO } = require('./lib/st-server');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'st-roku-shots')));
const CHROME = arg('chrome', process.env.CHROME_PATH || '/snap/bin/chromium');
const SECONDS = Number(arg('seconds', 60));
const ROKU = path.join(REPO, 'roku');
const NM = path.join(ROKU, 'node_modules');
let puppeteer;
try { puppeteer = require(path.join(REPO, 'server/node_modules/puppeteer-core')); } catch { puppeteer = require('puppeteer-core'); }

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head>
<body><canvas id="display" width="1920" height="1080"></canvas><video id="player" style="display:none" crossorigin="anonymous"></video>
<script src="/lib/brs.api.js"></script>
<script>
window.startApp = async function (server) {
  // the app's print lines come out of the engine's worker as "debug"/"print" events, not console
  brs.subscribe("harness", (event, data) => {
    if (event === "debug" || event === "print" || event === "error" || event === "warning") console.log(typeof data === "string" ? data : JSON.stringify(data));
  });
  await brs.initialize({ extensions: new Map([[brs.SupportedExtension.SceneGraph, "./brs-sg.js"]]) }, { debugToConsole: true });
  // initialize() returns before its own common.zip (fonts, certs) has been unpacked; an app started
  // earlier crashes on the first font lookup
  await new Promise((r) => setTimeout(r, 4000));
  const buf = await (await fetch("/app.zip")).arrayBuffer();
  brs.execute("app.zip", buf, { clearDisplayOnExit: false }, new Map([["server", server], ["debug", "1"]]));
};
</script></body></html>`;

function staticServer(zip, target) {
  const files = {
    '/index.html': [Buffer.from(PAGE), 'text/html'],
    '/lib/brs.api.js': [fs.readFileSync(path.join(NM, 'brs-engine/lib/brs.api.js')), 'text/javascript'],
    '/lib/brs.worker.js': [fs.readFileSync(path.join(NM, 'brs-engine/lib/brs.worker.js')), 'text/javascript'],
    '/lib/brs-sg.js': [fs.readFileSync(path.join(NM, 'brs-scenegraph/lib/brs-sg.js')), 'text/javascript'],
    // SceneGraph needs its own common.zip (fonts, locale data) in place of the core one
    '/lib/assets/common.zip': [fs.readFileSync(path.join(NM, 'brs-scenegraph/assets/common.zip')), 'application/zip'],
    '/assets/common.zip': [fs.readFileSync(path.join(NM, 'brs-scenegraph/assets/common.zip')), 'application/zip'],
    '/app.zip': [fs.readFileSync(zip), 'application/zip'],
  };
  const t = new URL(target);
  const srv = http.createServer((req, res) => {
    const iso = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
    const u = req.url.split('?')[0];
    if (process.env.SHOT_DEBUG) console.log('  http> ' + req.method + ' ' + req.url + (files[u] ? ' (static)' : ' (proxy)'));
    if (files[u]) {
      res.writeHead(200, { 'Content-Type': files[u][1], ...iso });
      return res.end(files[u][0]);
    }
    // everything else is the ScreenTinker server, on this origin
    const p = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode, { ...r.headers, ...iso });
      r.pipe(res);
    });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

let logsRef = [];
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'st-roku-shot-'));
  let srv = null;
  let web = null;
  let browser = null;
  try {
    srv = await start();
    await srv.admin();
    const img = await srv.upload(path.join(REPO, 'frontend/assets/icon-512.png'), 'image/png');
    const vid = await srv.upload(srv.testVideo(6), 'video/mp4');
    const clock = await srv.widget('clock', 'Lobby clock', { timezone: 'America/Chicago' });
    const ny = await srv.widget('clock', 'New York', { timezone: 'America/New_York', format: '24h', date_position: 'above', font_size: process.argv.includes('--layout') ? 96 : 160, color: '#60A5FA' });
    const zip = packageApp(work);
    web = await staticServer(zip, srv.base);

    browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    let code = null;
    const logs = [];
    logsRef = logs;
    page.on('console', (m) => {
      const t = m.text();
      logs.push(t);
      if (/\[st\]|ERROR/.test(t) && !t.startsWith('{"level"') && (process.env.SHOT_DEBUG || !/\[st\] eio:/.test(t))) console.log('  roku> ' + t);
      const c = t.match(/\[st\] pairing: code (\d{6})/);
      if (c) code = c[1];
    });
    page.on('pageerror', (e) => console.log('  page error> ' + e.message));
    await page.goto(web.url + '/index.html', { waitUntil: 'load' });
    await page.evaluate((s) => window.startApp(s), web.url);

    for (let i = 0; i < 150 && !code; i++) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1500));
    await page.screenshot({ path: path.join(OUT, '01-pairing.png') });
    if (!code) throw new Error('no pairing code appeared');

    let id;
    if (process.argv.includes('--layout')) {
      // main zone 70% with the video and the icon; a side column with a native clock over the icon
      const lay = await srv.layout('Roku split', [
        { name: 'Main', x: 0, y: 0, w: 70, h: 100 },
        { name: 'Side', x: 70, y: 0, w: 30, h: 100, bg: '#0F172A' },
      ]);
      const [main, side] = lay.zones;
      id = await srv.pairAndAssign(code, [
        { content_id: vid.id, zone_id: main.id }, { content_id: img.id, zone_id: main.id, duration_sec: 6 },
        { widget_id: ny.id, zone_id: side.id, duration_sec: 10 }, { content_id: img.id, zone_id: side.id, duration_sec: 6 },
      ], 'Roku lobby', lay.id);
    } else {
      id = await srv.pairAndAssign(code, [{ content_id: img.id, duration_sec: 6 }, { widget_id: clock.id, duration_sec: 8 }, { widget_id: ny.id, duration_sec: 8 }, { content_id: vid.id }]);
    }
    console.log(`  test> paired ${id}`);
    const end = Date.now() + SECONDS * 1000;
    let n = 2;
    while (Date.now() < end) {
      await new Promise((r) => setTimeout(r, 4000));
      await page.screenshot({ path: path.join(OUT, String(n).padStart(2, '0') + '-playing.png') });
      n++;
    }
    fs.writeFileSync(path.join(OUT, 'console.log'), logs.join('\n'));
    console.log(`screenshots in ${OUT}`);
  } catch (e) {
    console.log('FAIL ' + (e.stack || e.message));
    if (srv) console.log(srv.log().slice(-1500));
    process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(path.join(OUT, 'console.log'), (typeof logsRef !== 'undefined' ? logsRef : []).join('\n')); } catch {}
    if (browser) await browser.close();
    if (web) web.srv.close();
    if (srv) await srv.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
})();
