'use strict';

/*
 * 3.0 screen share — END TO END in a real browser, with real media.
 *
 * A real server, a real web player page (/player, paired by seeding its storage) and a real sharer
 * page in headless Chrome with fake capture (--use-fake-ui-for-media-stream
 * --use-fake-device-for-media-stream: getDisplayMedia returns Chrome's synthetic "screen"). Asserts
 * what a person in the room would see:
 *
 *   1. the screen shows a meeting-room code; a guest types it on /share and presents;
 *   2. the screen plays the stream fullscreen in a <video> (frames decoded, time advancing) with a
 *      "Shared by <name> · guest" badge, and the sharer's page says it is live;
 *   3. Stop on the sharer's page takes the overlay off the screen and a NEW code comes back;
 *   4. an editor's dashboard-style share (API start + the same client module) also plays, and the
 *      owner's stop (DELETE) ends it on the screen.
 *
 * SKIPS cleanly when no Chrome/Chromium or puppeteer-core is available, so CI without a browser stays
 * green. Peer-to-peer over loopback: no STUN/TURN involved (ICE servers are cleared for the test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}
function findPuppeteer() {
  try { return require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core')); } catch { return null; }
}
const CHROME = process.env.SBX_NO_BROWSER ? null : findChromium();
const puppeteer = findPuppeteer();
const SKIP = !CHROME || !puppeteer ? (!puppeteer ? 'puppeteer-core not installed' : 'no chromium binary found') : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG, browser;
let owner;
const extraBrowsers = [];
const DEV = crypto.randomUUID();
const TOK = 'devtok_' + crypto.randomBytes(16).toString('hex');

const run = (sql, ...a) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

async function waitFor(fn, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(150);
  }
}

before(async () => {
  if (SKIP) return;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-e2e-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    // No STUN: two peers on loopback need only host candidates, and a test must not phone out.
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test', GO2RTC_STUN_URLS: ' ' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  const r = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `owner-${Date.now()}@e2e.test`, password: 'Passw0rd123', name: 'Olive Owner' }),
  });
  const b = await r.json();
  owner = { token: b.token, id: b.user.id, ws: b.current_workspace_id };
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, screen_share_guest) VALUES (?, ?, ?, 'Boardroom TV', ?, 'offline', ?, 1)",
    DEV, owner.id, owner.ws, crypto.randomUUID().slice(0, 6), TOK);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      // Both pages share one browser; keep the background one running at full speed.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ],
  });
});

after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  for (const b of extraBrowsers) { try { await b.close(); } catch { /* already closed */ } }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  if (DATA_DIR) fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function openPlayer() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((cfg) => {
    try { localStorage.setItem('rd_web_player', JSON.stringify(cfg)); } catch (_) { /* */ }
  }, { serverUrl: BASE, deviceId: DEV, deviceToken: TOK, paired: true });
  await page.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
  return page;
}

/** What the player's share <video> is doing right now. */
function videoState(page) {
  return page.evaluate(() => {
    const v = document.getElementById('st-share-video');
    const o = document.getElementById('st-share-overlay');
    if (!v || !o) return null;
    const r = o.getBoundingClientRect();
    return {
      readyState: v.readyState, paused: v.paused, w: v.videoWidth, h: v.videoHeight, t: v.currentTime,
      overlayW: r.width, overlayH: r.height,
      badge: (document.getElementById('st-share-badge') || {}).textContent || '',
    };
  });
}

async function assertPlaying(page, label) {
  const s1 = await waitFor(async () => {
    const s = await videoState(page);
    return s && s.readyState >= 2 && s.w > 0 && !s.paused ? s : null;
  }, 25000, label + ': a playing <video> on the screen');
  await sleep(1200);
  const s2 = await videoState(page);
  assert.ok(s2.t > s1.t, `${label}: video time advances (${s1.t} -> ${s2.t})`);
  assert.equal(s2.overlayW, 1280, 'fullscreen overlay');
  assert.equal(s2.overlayH, 720);
  return s2;
}

test('a guest presents with the code on the screen; the screen plays it; Stop puts the content back', { skip: SKIP, timeout: 120000 }, async () => {
  const player = await openPlayer();
  const codeText = () => player.evaluate(() => {
    const el = document.getElementById('st-share-code');
    const c = el && el.querySelector('[data-share-code]');
    return el && el.style.display !== 'none' && c ? c.textContent : null;
  });
  const code = await waitFor(codeText, 30000, 'the meeting-room code on the screen');
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  const qr = await player.evaluate(() => document.querySelector('#st-share-code img').src);
  assert.match(qr, /^data:image\/png;base64,/);

  const guest = await browser.newPage();
  await guest.goto(BASE + '/share', { waitUntil: 'domcontentloaded' });
  await guest.waitForSelector('#shareCode');
  await guest.type('#shareCode', code.toLowerCase());
  await guest.type('#shareName', 'Erin');
  await guest.click('#shareGo');

  const st = await assertPlaying(player, 'guest share');
  assert.match(st.badge, /Erin/);
  assert.match(st.badge, /guest/);
  await waitFor(() => guest.evaluate(() => !document.getElementById('shareLive').hidden
    && document.getElementById('shareLive').classList.contains('on')), 15000, 'the sharer page says live');
  // While someone is sharing, the screen offers no code.
  assert.equal(await codeText(), null);

  await guest.click('#shareStop');
  await waitFor(async () => (await videoState(player)) === null, 10000, 'the overlay to leave the screen');
  const next = await waitFor(codeText, 10000, 'a fresh code after the share');
  assert.notEqual(next, code, 'the used code is never shown again');
  await waitFor(() => guest.evaluate(() => !document.getElementById('shareForm').hidden), 5000, 'the guest page back on its form');
  await guest.close();
  await player.close();
});

test('an editor\'s share (API start + the dashboard client) plays; the owner\'s stop ends it on the screen', { skip: SKIP, timeout: 120000 }, async () => {
  const player = await openPlayer();
  await waitFor(() => player.evaluate(() => !!document.getElementById('st-share-code') && document.getElementById('st-share-code').style.display !== 'none'), 30000, 'player registered');
  // The meeting-room code on screen before the share; it must not survive the share.
  const codeOnScreen = () => player.evaluate(() => {
    const el = document.querySelector('#st-share-code [data-share-code]');
    const box = document.getElementById('st-share-code');
    return box && box.style.display !== 'none' && el ? el.textContent.trim() : null;
  });
  const codeBefore = await codeOnScreen();
  assert.ok(codeBefore, 'a code is on screen before the share');
  const start = await fetch(`${BASE}/api/screen-share/devices/${DEV}`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws, 'Content-Type': 'application/json' }, body: '{}',
  });
  const body = await start.json();
  assert.equal(start.status, 201, JSON.stringify(body));

  const sharer = await browser.newPage();
  await sharer.goto(BASE + '/share', { waitUntil: 'domcontentloaded' });
  await sharer.evaluate(async (b) => {
    const m = await import('/js/lib/screen-share-client.js');
    const stream = await m.pickScreen({ audio: false });
    window.__ended = null;
    window.__states = [];
    window.__sender = new m.ScreenShareSender({
      ticket: b.ticket, wsPath: b.ws_path, iceServers: b.ice_servers, stream,
      onState: (s) => window.__states.push(s), onEnded: (r) => { window.__ended = r; },
    });
    window.__sender.start();
  }, body);

  const st = await assertPlaying(player, 'editor share');
  assert.match(st.badge, /Olive Owner/);
  assert.doesNotMatch(st.badge, /guest/);
  await waitFor(() => sharer.evaluate(() => window.__states.includes('live')), 10000, 'sender state live');

  const del = await fetch(`${BASE}/api/screen-share/devices/${DEV}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws },
  });
  assert.deepEqual(await del.json(), { stopped: true });
  await waitFor(async () => (await videoState(player)) === null, 10000, 'the overlay to leave the screen');
  assert.equal(await waitFor(() => sharer.evaluate(() => window.__ended), 5000, 'sender ended'), 'stopped_by_owner');
  // Ended → a fresh code, never the one shown before the share (no reuse of a code seen in the room).
  const codeAfter = await waitFor(codeOnScreen, 10000, 'a code back on screen after the share');
  assert.notEqual(codeAfter, codeBefore, 'the share ended with a NEW meeting-room code');
  const tracksLive = await sharer.evaluate(() => window.__sender.stream.getTracks().some((t) => t.readyState === 'live'));
  assert.equal(tracksLive, false, 'the capture is stopped when the share ends');
  await sharer.close();
  await player.close();
});

/*
 * The remote viewer (screenshots and the 1 fps live view) must show the SHARE while one is up: the
 * share is a fullscreen overlay outside #playerContainer, and the capture used to look only inside
 * it, so the operator saw the paused playlist (or the status card) instead. Run on a screen opened
 * through its WEB PLAYER URL (/player?k=…, the display link for players that lose their storage),
 * in its own browser context, so no stored identity helps it.
 */
test('the remote viewer shows the share, on a screen opened through its web player URL', { skip: SKIP, timeout: 150000 }, async () => {
  const H = { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws, 'Content-Type': 'application/json' };
  const made = await (await fetch(`${BASE}/api/devices/web-player`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Display link TV' }) })).json();
  const devId = made.device && made.device.id;
  assert.ok(devId && /[?&]k=/.test(made.player_url), 'a display link: ' + JSON.stringify(made));

  const ctx = await browser.createBrowserContext();
  const player = await ctx.newPage();
  await player.setViewport({ width: 1280, height: 720 });
  await player.goto(made.player_url, { waitUntil: 'domcontentloaded' });
  await waitFor(async () => {
    const r = await (await fetch(`${BASE}/api/devices/${devId}`, { headers: H })).json();
    return r && r.status === 'online' && Array.isArray(r.capabilities) && r.capabilities.includes('remote.screen_share') ? r : null;
  }, 40000, 'the display-link screen online and offering screen share');

  const start = await fetch(`${BASE}/api/screen-share/devices/${devId}`, { method: 'POST', headers: H, body: '{}' });
  const body = await start.json();
  assert.equal(start.status, 201, JSON.stringify(body));
  const sharer = await browser.newPage();
  await sharer.goto(BASE + '/share', { waitUntil: 'domcontentloaded' });
  await sharer.evaluate(async (b) => {
    const m = await import('/js/lib/screen-share-client.js');
    const stream = await m.pickScreen({ audio: false });
    window.__sender = new m.ScreenShareSender({ ticket: b.ticket, wsPath: b.ws_path, iceServers: b.ice_servers, stream, onState: () => {}, onEnded: () => {} });
    window.__sender.start();
  }, body);
  await assertPlaying(player, 'share on the display-link screen');

  // What the remote viewer gets: the dashboard socket asks the screen for a frame
  // ('dashboard:request-screenshot') and receives it as 'dashboard:screenshot-ready'.
  const { io } = require('socket.io-client');
  const dash = io(BASE + '/dashboard', { auth: { token: owner.token }, transports: ['websocket'] });
  await new Promise((res, rej) => { dash.once('connect', res); dash.once('connect_error', rej); });
  const frame = new Promise((res) => dash.on('dashboard:screenshot-ready', (m) => { if (m && m.device_id === devId) res(m); }));
  dash.emit('dashboard:request-screenshot', { device_id: devId });
  const m = await Promise.race([frame, sleep(20000).then(() => null)]);
  dash.close();
  assert.ok(m && /^data:image\/jpeg;base64,/.test(m.image_data), 'a screenshot from the screen');
  const shot = Buffer.from(m.image_data.split(',')[1], 'base64');

  // The status card is a flat #111827 field; a share is the shared picture letterboxed on black.
  const { Jimp } = require('jimp');
  const img = await Jimp.read(shot);
  let card = 0, colourful = 0, n = 0;
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y, i) => {
    const r = img.bitmap.data[i], g = img.bitmap.data[i + 1], b = img.bitmap.data[i + 2];
    n++;
    if (Math.abs(r - 17) < 6 && Math.abs(g - 24) < 6 && Math.abs(b - 39) < 6) card++;
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colourful++;
  });
  assert.ok(card / n < 0.2, `not the status card (${Math.round((card / n) * 100)}% card colour)`);
  assert.ok(colourful / n > 0.05, `the shared picture is in the screenshot (${Math.round((colourful / n) * 100)}% colourful pixels)`);

  await fetch(`${BASE}/api/screen-share/devices/${devId}`, { method: 'DELETE', headers: H });
  await sharer.close();
  await ctx.close();
});

/*
 * 3.0 multi share: ONE sharer, TWO web-player screens, both playing the same capture. Each screen is
 * its own browser context (its own storage, like two TVs). Stopping one screen leaves the other
 * playing; the sharer's Stop ends the rest and the capture.
 */
test('multi share: one sharer, two screens, both play; stop one, then stop all', { skip: SKIP, timeout: 150000 }, async () => {
  const H = { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws, 'Content-Type': 'application/json' };
  const DEV2 = crypto.randomUUID();
  const TOK2 = 'devtok_' + crypto.randomBytes(16).toString('hex');
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, 'Lobby TV', ?, 'offline', ?)",
    DEV2, owner.id, owner.ws, crypto.randomUUID().slice(0, 6), TOK2);
  const ctx1 = await browser.createBrowserContext();
  const ctx2 = await browser.createBrowserContext();
  const open = async (ctx, id, tok) => {
    const p = await ctx.newPage();
    await p.setViewport({ width: 1280, height: 720 });
    await p.evaluateOnNewDocument((cfg) => { try { localStorage.setItem('rd_web_player', JSON.stringify(cfg)); } catch (_) { /* */ } },
      { serverUrl: BASE, deviceId: id, deviceToken: tok, paired: true });
    await p.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
    return p;
  };
  const p1 = await open(ctx1, DEV, TOK);
  const p2 = await open(ctx2, DEV2, TOK2);
  for (const id of [DEV, DEV2]) {
    await waitFor(async () => {
      const r = await (await fetch(`${BASE}/api/devices/${id}`, { headers: H })).json();
      return r && r.status === 'online' && Array.isArray(r.capabilities) && r.capabilities.includes('remote.screen_share');
    }, 40000, 'both screens online and offering screen share');
  }
  const start = await fetch(`${BASE}/api/screen-share/shares`, { method: 'POST', headers: H, body: JSON.stringify({ device_ids: [DEV, DEV2] }) });
  const body = await start.json();
  assert.equal(start.status, 201, JSON.stringify(body));
  assert.equal(body.legs.length, 2);

  const sharer = await browser.newPage();
  await sharer.goto(BASE + '/share', { waitUntil: 'domcontentloaded' });
  await sharer.evaluate(async (b) => {
    const m = await import('/js/lib/screen-share-client.js');
    const stream = await m.pickScreen({ audio: false });
    window.__sum = null; window.__legEnded = []; window.__ended = null;
    window.__multi = new m.MultiShareSender({
      legs: b.legs, wsPath: b.ws_path, stream,
      onState: (s) => { window.__sum = s; },
      onLegEnded: (leg, reason) => window.__legEnded.push([leg.deviceId, reason]),
      onEnded: (r) => { window.__ended = r; },
    });
    window.__multi.start();
  }, body);

  await assertPlaying(p1, 'multi share, screen 1');
  await assertPlaying(p2, 'multi share, screen 2');
  await waitFor(() => sharer.evaluate(() => window.__sum && window.__sum.live === 2), 15000, 'both legs live');
  // One capture for both: the sharer's page captured once.
  assert.equal(await sharer.evaluate(() => window.__multi.legs.every((l) => l.sender.stream === window.__multi.stream)), true);

  // The owner stops screen 2 only: it goes back to its content, screen 1 keeps playing.
  await fetch(`${BASE}/api/screen-share/devices/${DEV2}`, { method: 'DELETE', headers: H });
  await waitFor(async () => (await videoState(p2)) === null, 10000, 'screen 2 back to its content');
  await assertPlaying(p1, 'screen 1 after screen 2 stopped');
  await waitFor(() => sharer.evaluate(() => window.__legEnded.length === 1), 5000, 'the sharer told one screen left');
  assert.deepEqual(await sharer.evaluate(() => window.__legEnded[0]), [DEV2, 'stopped_by_owner']);
  assert.equal(await sharer.evaluate(() => window.__ended), null, 'the share goes on');

  // Stop: everywhere, and the capture ends.
  await sharer.evaluate(() => window.__multi.stop());
  await waitFor(async () => (await videoState(p1)) === null, 10000, 'screen 1 back to its content');
  assert.equal(await sharer.evaluate(() => window.__ended), 'stopped_by_sharer');
  assert.equal(await sharer.evaluate(() => window.__multi.stream.getTracks().some((t) => t.readyState === 'live')), false);
  await sharer.close();
  await ctx1.close();
  await ctx2.close();
});

/*
 * The native Pi / Windows / macOS player receives a share in its QtWebEngine RTC page
 * (native/screentinker_native/ui/rtc_page.py). QtWebEngine IS Chromium, so this runs that EXACT
 * page — generated by the native code — in Chromium, with the server as its base URL as TalkVideo.qml
 * loads it, and drives it the way app.py does: a Socket.IO device that turns device:screenshare-start
 * into ST.shareStart(...) and device:screenshare-stop into ST.shareStop(...).
 */
const { spawnSync } = require('node:child_process');
function nativeRtcPage() {
  const nativeDir = path.join(__dirname, '..', '..', 'native');
  const r = spawnSync('python3', ['-I', '-c',
    'import sys; sys.path.insert(0, sys.argv[1]); from screentinker_native.ui.rtc_page import rtc_page; sys.stdout.write(rtc_page("ws://127.0.0.1:9/frames?k=x"))',
    nativeDir], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.includes('ST = {') ? r.stdout : null;
}
const NATIVE_HTML = SKIP ? null : nativeRtcPage();

test('the native player\'s RTC page receives a share: plays fullscreen with the badge, reports per session, stops clean', { skip: SKIP || (!NATIVE_HTML && 'python3 not available to build the native page'), timeout: 120000 }, async () => {
  const H = { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws, 'Content-Type': 'application/json' };
  const NAT = crypto.randomUUID();
  const NTOK = 'devtok_' + crypto.randomBytes(16).toString('hex');
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token) VALUES (?, ?, ?, 'Pi in reception', ?, 'offline', ?)",
    NAT, owner.id, owner.ws, crypto.randomUUID().slice(0, 6), NTOK);

  // Its own browser: the page is served through request interception (as QtWebEngine's loadHtml
  // gives it the server as base URL), and Chrome's Local Network Access checks treat an intercepted
  // response as a public page that may not open a WebSocket to 127.0.0.1. QtWebEngine applies no
  // such check to loadHtml content, so turning it off is the faithful setting, not a loophole.
  const nb = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-features=LocalNetworkAccessChecks'],
  });
  extraBrowsers.push(nb);
  const page = await nb.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[rtc]')) logs.push(t); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url() === BASE + '/__native_rtc') req.respond({ status: 200, contentType: 'text/html', body: NATIVE_HTML });
    else req.continue();
  });
  await page.goto(BASE + '/__native_rtc', { waitUntil: 'load' });
  await waitFor(() => page.evaluate(() => !!(window.ST && window.STScreenShare)), 10000, 'the native page loaded the server\'s receiver');

  // The native app's link: app.py's _share_start / _share_stop, in a few lines.
  const { io } = require('socket.io-client');
  const link = io(`${BASE}/device`, { transports: ['websocket'], reconnection: false, forceNew: true });
  link.on('connect', () => link.emit('device:register', {
    device_id: NAT, device_token: NTOK, capabilities: ['playback.video', 'remote.screen_share'],
    device_info: { app_version: 'native-e2e' },
  }));
  let current = null;
  link.on('device:screenshare-start', (d) => {
    current = d.session_id;
    const opts = { deviceId: NAT, deviceToken: NTOK, serverUrl: BASE, sessionId: d.session_id, sharedBy: d.shared_by, guest: !!d.guest, maxSeconds: d.max_seconds, iceServers: d.ice_servers || [] };
    page.evaluate((o) => window.ST.shareStart(o), opts).catch(() => {});
  });
  link.on('device:screenshare-stop', (d) => {
    page.evaluate((a) => window.ST.shareStop(a[0], a[1]), [d.session_id, d.reason]).catch(() => {});
  });
  await new Promise((res, rej) => { link.once('device:registered', res); link.once('device:auth-error', rej); });

  const start = await fetch(`${BASE}/api/screen-share/devices/${NAT}`, { method: 'POST', headers: H, body: '{}' });
  const body = await start.json();
  assert.equal(start.status, 201, JSON.stringify(body));
  const sharer = await nb.newPage();
  await sharer.goto(BASE + '/share', { waitUntil: 'domcontentloaded' });
  await sharer.evaluate(async (b) => {
    const m = await import('/js/lib/screen-share-client.js');
    const stream = await m.pickScreen({ audio: false });
    window.__sender = new m.ScreenShareSender({ ticket: b.ticket, wsPath: b.ws_path, iceServers: b.ice_servers, stream, onState: () => {}, onEnded: () => {} });
    window.__sender.start();
  }, body);

  let st;
  try { st = await assertPlaying(page, 'native RTC page'); } catch (e) { throw new Error(e.message + ' — page log: ' + logs.join(' | ')); }
  assert.match(st.badge, /Olive Owner/);
  // The QML layer is shown while the title says rtc:share (TalkVideo.qml), unless a trigger is up.
  await waitFor(() => page.evaluate(() => document.title === 'rtc:share'), 3000, 'title rtc:share');
  assert.ok(logs.some((l) => l === `[rtc] share playing ${current} `), 'reports playing with its session id: ' + logs.join(' | '));

  // #845: a trigger on the native screen hides and silences the share (ST.shareSuppress); the
  // session stays connected and comes back when the trigger clears.
  const shareView = () => page.evaluate(() => {
    const o = document.getElementById('st-share-overlay');
    const a = o && o.querySelector('audio');
    return o ? { hidden: getComputedStyle(o).visibility === 'hidden', muted: !!(a && a.muted), live: !!document.querySelector('#st-share-overlay video').srcObject } : null;
  });
  await page.evaluate(() => window.ST.shareSuppress(true));
  let sv = await shareView();
  assert.deepEqual(sv, { hidden: true, muted: true, live: true });
  assert.equal(await page.evaluate(() => window.ST.shareSuppressed()), true);
  await page.evaluate(() => window.ST.shareSuppress(false));
  sv = await shareView();
  assert.equal(sv.hidden, false);
  assert.equal(sv.live, true);
  assert.equal(await page.evaluate(() => window.ST.shareSuppressed()), false);

  await fetch(`${BASE}/api/screen-share/devices/${NAT}`, { method: 'DELETE', headers: H });
  await waitFor(async () => (await videoState(page)) === null, 10000, 'the share leaves the native page');
  await waitFor(() => page.evaluate(() => document.title === 'rtc:idle'), 3000, 'title rtc:idle');
  link.close();
  await nb.close();
});

/*
 * A screen that stops being the display (here: the display is deleted, so the player goes back to a
 * pairing code) must not keep the display's meeting-room code on screen — anyone in front of it could
 * otherwise present to the display it used to be. Reported from a browser showing a pairing code and
 * another display's "Share your screen here" code side by side.
 */
test('a screen that goes back to a pairing code drops the display\'s share code', { skip: SKIP, timeout: 120000 }, async () => {
  const dev2 = crypto.randomUUID();
  const tok2 = 'devtok_' + crypto.randomBytes(16).toString('hex');
  run("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, screen_share_guest) VALUES (?, ?, ?, 'Lobby TV', ?, 'offline', ?, 1)",
    dev2, owner.id, owner.ws, crypto.randomUUID().slice(0, 6), tok2);
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((cfg) => {
    try { localStorage.setItem('rd_web_player', JSON.stringify(cfg)); } catch (_) { /* */ }
  }, { serverUrl: BASE, deviceId: dev2, deviceToken: tok2, paired: true });
  await page.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
  const codeShown = () => page.evaluate(() => {
    const el = document.getElementById('st-share-code');
    return !!(el && el.style.display !== 'none' && el.getBoundingClientRect().width > 0);
  });
  await waitFor(codeShown, 30000, 'the meeting-room code on the screen');

  const del = await fetch(`${BASE}/api/devices/${dev2}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws } });
  assert.ok(del.status < 300, 'display deleted: ' + del.status);
  await waitFor(() => page.evaluate(() => {
    const p = document.getElementById('pairingSection');
    const s = document.getElementById('setupScreen');
    return (p && p.style.display !== 'none') || (s && s.style.display !== 'none');
  }), 30000, 'the player back on its setup / pairing screen');
  await sleep(1500);
  assert.equal(await codeShown(), false, 'the old display\'s share code is gone');
  await page.close();
});
