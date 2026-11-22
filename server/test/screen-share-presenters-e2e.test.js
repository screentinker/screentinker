'use strict';

/*
 * 3.0 screen share, SEVERAL PEOPLE AT ONCE and PHONES — end to end in headless Chrome with real
 * media (fake capture and a fake camera: --use-fake-ui-for-media-stream
 * --use-fake-device-for-media-stream), a real server and the real web player page. What a room
 * would see:
 *
 *   - the QR on the screen encodes /share?code=<the code on screen>, and follows the code;
 *     opening that link fills the code in on /share
 *   - two guests join with codes read off the screen (the second code appears after the first
 *     join, in the small corner badge) -> the player shows TWO tiles side by side, both playing
 *   - the room is full (platform limit 2) -> no code on screen
 *   - the first presenter's page spotlights the other -> one tile, full screen; back to tiles
 *   - the first presenter removes the other -> one tile; the removed guest's page says so and the
 *     code they used is refused; a slot is free -> a code is back on screen
 *   - a phone (mobile emulation, no getDisplayMedia) is offered its CAMERA (and, on Android, the
 *     ScreenTinker app), and its camera share plays on the screen next to the first presenter
 *   - everyone leaves -> the overlay is gone and a fresh code is on screen
 *
 * SKIPS cleanly without Chrome/puppeteer-core, like screen-share-e2e.test.js.
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
  for (const c of [process.env.CHROMIUM_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}
function findPuppeteer() {
  try { return require(path.join(__dirname, '..', 'node_modules', 'puppeteer-core')); } catch { return null; }
}
const CHROME = process.env.SBX_NO_BROWSER ? null : findChromium();
const puppeteer = findPuppeteer();
const SKIP = !CHROME || !puppeteer ? (!puppeteer ? 'puppeteer-core not installed' : 'no chromium binary found') : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc, BASE, DATA_DIR, LOG, browser, owner;
const DEV = crypto.randomUUID();
const TOK = 'devtok_' + crypto.randomBytes(16).toString('hex');

const run = (sql, ...a) => { const r = new (require('better-sqlite3'))(path.join(DATA_DIR, 'db', 'remote_display.db')); try { return r.prepare(sql).run(...a); } finally { r.close(); } };

// ⚠️ A page that navigates under us is "not yet", not a failure. On a fresh profile the player's
// service worker activates and reloads the page once ("reloading for fresh code"); a check that runs
// during that reload threw "Execution context was destroyed" and failed CI at random.
const NAVIGATING = /Execution context was destroyed|Cannot find context with specified id|Target closed|detached Frame/i;

async function waitFor(fn, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) {
      if (!NAVIGATING.test(String(e && e.message))) throw e;
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(150);
  }
}

before(async () => {
  if (SKIP) return;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-presenters-e2e-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
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
  run(`INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, status, device_token, screen_share_guest, screen_share_multi)
       VALUES (?, ?, ?, 'Meeting room', ?, 'offline', ?, 1, 1)`, DEV, owner.id, owner.ws, crypto.randomUUID().slice(0, 6), TOK);
  // The platform limit: two at once, so "full" is reached with two presenters.
  const lim = await fetch(BASE + '/api/admin/screen-share', {
    method: 'PUT', headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.ws, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_presenters: 2 }),
  });
  assert.equal(lim.status, 200);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ],
  });
});

after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
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

// The visible tiles on the screen: where they are, whether each is playing, and its label.
function tiles(player) {
  return player.evaluate(() => [...document.querySelectorAll('#st-share-overlay .st-share-tile')]
    .filter((el) => el.style.display !== 'none')
    .map((el) => {
      const r = el.getBoundingClientRect();
      const v = el.querySelector('video');
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        playing: !!(v && v.readyState >= 2 && v.videoWidth > 0 && !v.paused), t: v ? v.currentTime : 0,
        badge: (el.querySelector('.st-share-badge') || {}).textContent || '',
      };
    }));
}

async function playingTiles(player, n, what) {
  const a = await waitFor(async () => { const ts = await tiles(player); return ts.length === n && ts.every((x) => x.playing) ? ts : null; }, 30000, what);
  await sleep(1000);
  const b = await tiles(player);
  assert.equal(b.length, n, what + ': still ' + n);
  for (let i = 0; i < n; i++) assert.ok(b[i].t > a[i].t, `${what}: tile ${i} time advances`);
  return b;
}

// The code on screen right now (null when none), whether its badge is the compact one, and its QR.
function codeOnScreen(player) {
  return player.evaluate(() => {
    const box = document.getElementById('st-share-code');
    const el = box && box.querySelector('[data-share-code]');
    if (!box || box.style.display === 'none' || !el) return null;
    return { code: el.textContent.trim(), compact: box.hasAttribute('data-compact'), qr: (box.querySelector('img') || {}).src || '' };
  });
}

// The QR the server must have drawn for this code: the same library and options, so equal images
// mean the QR encodes exactly /share?code=<code>.
async function expectedQr(code) {
  return require('qrcode').toDataURL(`${BASE}/share?code=${code.replace('-', '')}`, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
}

async function guestPage(code, name, { phone = false } = {}) {
  let page;
  if (phone) {
    const ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    await page.emulate(puppeteer.KnownDevices['Pixel 5']);
    // A phone browser: a camera, but no screen capture.
    await page.evaluateOnNewDocument(() => {
      try { Object.defineProperty(MediaDevices.prototype, 'getDisplayMedia', { value: undefined, configurable: true }); } catch (_) { /* */ }
    });
  } else page = await browser.newPage();
  await page.goto(`${BASE}/share?code=${code.replace('-', '')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#shareCode');
  await waitFor(() => page.evaluate(() => document.getElementById('shareCode').value), 5000, 'the code filled in from the link');
  await page.$eval('#shareName', (el) => { el.value = ''; });
  await page.type('#shareName', name);
  return page;
}

test('several presenters: tiles, spotlight, remove, full, a phone camera, the QR', { skip: SKIP, timeout: 240000 }, async () => {
  const player = await openPlayer();
  const c1 = await waitFor(() => codeOnScreen(player), 30000, 'a code on the screen');
  assert.equal(c1.compact, false, 'nobody sharing: the full badge');
  assert.equal(c1.qr, await expectedQr(c1.code), 'the QR encodes /share?code=<the code on screen>');

  // Guest 1 opens the QR's link: the code is filled in, and dropped from the address bar.
  const ada = await guestPage(c1.code, 'Ada');
  assert.equal(await ada.evaluate(() => document.getElementById('shareCode').value), c1.code);
  assert.equal(await ada.evaluate(() => location.search), '');
  await ada.click('#shareGo');
  await playingTiles(player, 1, 'one presenter');
  assert.deepEqual((await tiles(player)).map((x) => [x.w, x.h]), [[1280, 720]], 'one presenter: full screen');

  // The second code appears after the first join, small, in a corner; the QR follows it.
  const c2 = await waitFor(async () => { const c = await codeOnScreen(player); return c && c.code !== c1.code ? c : null; }, 10000, 'a new code after the first join');
  assert.equal(c2.compact, true, 'while sharing: the small corner badge');
  assert.equal(c2.qr, await expectedQr(c2.code));

  const bo = await guestPage(c2.code, 'Bo');
  await bo.click('#shareGo');
  const two = await playingTiles(player, 2, 'two presenters');
  assert.deepEqual(two.map((x) => [x.x, x.y, x.w, x.h]), [[0, 0, 640, 720], [640, 0, 640, 720]], 'side by side on a landscape screen');
  assert.match(two[0].badge, /Ada/);
  assert.match(two[1].badge, /Bo/);
  await waitFor(async () => (await codeOnScreen(player)) === null, 10000, 'full: no code on screen');

  // The first presenter's page lists the room with controls; the second's has none.
  await waitFor(() => ada.evaluate(() => document.querySelectorAll('#shareRoomList li button').length >= 2), 10000, 'Ada sees controls');
  assert.equal(await bo.evaluate(() => document.querySelectorAll('#shareRoomList li button').length), 0, 'Bo has no controls');
  const clickFor = (page, who, nth) => page.evaluate((w, n) => {
    const li = [...document.querySelectorAll('#shareRoomList li')].find((x) => x.querySelector('.who') && x.querySelector('.who').textContent.startsWith(w));
    li.querySelectorAll('button')[n].click();
  }, who, nth);

  // Spotlight Bo: one tile, full screen.
  await clickFor(ada, 'Bo', 0);
  await waitFor(async () => { const ts = await tiles(player); return ts.length === 1 && /Bo/.test(ts[0].badge) && ts[0].w === 1280 ? ts : null; }, 10000, 'Bo full screen');
  // Back to tiles.
  await waitFor(() => ada.evaluate(() => [...document.querySelectorAll('#shareRoomList li')].some((li) => /Bo/.test(li.textContent) && li.querySelector('small'))), 5000, 'Ada sees the spotlight');
  await clickFor(ada, 'Bo', 0);
  await waitFor(async () => (await tiles(player)).length === 2, 10000, 'two tiles again');

  // Remove Bo: his page says so; one tile; a slot free -> a code back.
  await clickFor(ada, 'Bo', 1);
  await waitFor(async () => { const ts = await tiles(player); return ts.length === 1 && /Ada/.test(ts[0].badge); }, 10000, 'Bo gone from the screen');
  await waitFor(() => bo.evaluate(() => !document.getElementById('shareForm').hidden), 10000, 'Bo back on the form');
  const boMsg = await bo.evaluate(() => document.getElementById('shareMsg').textContent);
  assert.match(boMsg, /removed/i);
  // He tries the code he joined with: refused.
  await bo.type('#shareCode', c2.code);
  await bo.click('#shareGo');
  await waitFor(() => bo.evaluate(() => /not valid/.test(document.getElementById('shareMsg').textContent)), 15000, 'the old code refused');
  await bo.close();
  const c3 = await waitFor(async () => { const c = await codeOnScreen(player); return c && ![c1.code, c2.code].includes(c.code) ? c : null; }, 10000, 'a code back once a slot is free');
  assert.equal(c3.compact, true);

  // A phone: no "Share my screen" in its browser; its camera and (Android) the app instead.
  const pia = await guestPage(c3.code, 'Pia', { phone: true });
  const offer = await pia.evaluate(() => ({
    screen: !document.getElementById('shareGo').hidden,
    camera: !document.getElementById('shareCameraBox').hidden,
    app: !document.getElementById('shareApp').hidden,
    note: document.getElementById('shareScreenNote').textContent,
  }));
  assert.deepEqual([offer.screen, offer.camera, offer.app], [false, true, true]);
  assert.match(offer.note, /camera/i);
  const link = await pia.evaluate(async (code) => (await import('/js/lib/screen-share-client.js')).managerAppLink(location.origin, code), c3.code);
  assert.equal(link, `intent://share?server=${encodeURIComponent(BASE)}&code=${c3.code.replace('-', '')}#Intent;scheme=screentinker;package=com.screentinker.manager;S.browser_fallback_url=${encodeURIComponent('https://play.google.com/store/apps/details?id=com.screentinker.manager')};end`);
  await pia.click('#shareCamera');
  const withCam = await playingTiles(player, 2, 'Ada + Pia\'s camera');
  assert.match(withCam[1].badge, /Pia/);
  await waitFor(() => pia.evaluate(() => !document.getElementById('shareFlip').hidden), 10000, 'the phone offers "Switch camera"');
  // Switching camera keeps the share going.
  await pia.click('#shareFlip');
  await sleep(1500);
  await playingTiles(player, 2, 'still two after the camera switch');

  // Everyone leaves: content again and a fresh code.
  await ada.click('#shareStop');
  await playingTiles(player, 1, 'Pia alone');
  await pia.click('#shareStop');
  await waitFor(() => player.evaluate(() => !document.getElementById('st-share-overlay')), 10000, 'the overlay gone');
  const last = await waitFor(async () => { const c = await codeOnScreen(player); return c && !c.compact && c.code !== c3.code ? c : null; }, 10000, 'a fresh full code');
  assert.equal(last.qr, await expectedQr(last.code));
  await ada.close();
  await pia.browserContext().close();
  await player.close();
});
