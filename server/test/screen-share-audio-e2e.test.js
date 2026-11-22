'use strict';

/*
 * Screen share SOUND reaches the screen, on a screen nobody has touched.
 *
 * Reported from alpha: "I selected share audio but audio isn't being sent". The several-presenters
 * work started every presenter's <audio> MUTED and unmuted the one whose sound plays a moment later.
 * Browsers let muted media autoplay, but unmuting it from script without a user gesture pauses it
 * (Chrome's autoplay policy), so on an unattended screen the sound never played. These tests run
 * WITHOUT --autoplay-policy=no-user-gesture-required, which the other share suites pass and which
 * hid exactly this.
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

// ⚠️ A page that navigates under us is "not yet", not a failure (the player's service worker
// reloads the page once on a fresh profile; a check during that reload threw at random in CI).
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
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-share-audio-e2e-'));
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


async function openPlayer() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((cfg) => {
    try { localStorage.setItem('rd_web_player', JSON.stringify(cfg)); } catch (_) { /* */ }
  }, { serverUrl: BASE, deviceId: DEV, deviceToken: TOK, paired: true });
  await page.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
  return page;
}

function codeOnScreen(player) {
  return player.evaluate(() => {
    const box = document.getElementById('st-share-code');
    const el = box && box.querySelector('[data-share-code]');
    return box && box.style.display !== 'none' && el ? el.textContent.trim() : null;
  });
}

// Every presenter's sound element on the screen: has a live track, unmuted, and actually playing.
function sound(player) {
  return player.evaluate(() => [...document.querySelectorAll('#st-share-overlay audio')].map((a) => ({
    track: !!(a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live')),
    muted: a.muted, paused: a.paused, t: a.currentTime,
  })));
}

async function cameraWithSound(code, name) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/share?code=${code.replace('-', '')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#shareCode');
  await waitFor(() => page.evaluate(() => document.getElementById('shareCode').value), 5000, 'the code filled in');
  await page.$eval('#shareName', (el) => { el.value = ''; });
  await page.type('#shareName', name);
  await page.$eval('#shareAudio', (el) => { el.checked = true; });
  await waitFor(() => page.evaluate(() => !document.getElementById('shareCameraBox').hidden), 5000, 'the camera option');
  await page.click('#shareCamera');
  return page;
}

test('a share with sound plays its sound on a screen nobody has touched', { skip: SKIP, timeout: 120000 }, async () => {
  const player = await openPlayer();
  const code = await waitFor(() => codeOnScreen(player), 30000, 'a meeting-room code');
  await cameraWithSound(code, 'Ada');
  const a = await waitFor(async () => { const s = await sound(player); return s.length === 1 && s[0].track && !s[0].paused ? s : null; }, 30000, 'the sound playing');
  assert.equal(a[0].muted, false, 'the only presenter is heard');
  await sleep(1500);
  const b = await sound(player);
  assert.ok(!b[0].paused && b[0].t > a[0].t, 'the sound keeps playing');

  // A second presenter with sound: the newest is heard, the first is muted, and both keep running.
  const code2 = await waitFor(() => codeOnScreen(player), 15000, 'a fresh code for a second presenter');
  await cameraWithSound(code2, 'Bo');
  const two = await waitFor(async () => { const s = await sound(player); return s.length === 2 && s.every((x) => x.track) && s.filter((x) => !x.muted).length === 1 ? s : null; }, 30000, 'two presenters, one heard');
  const heard = two.find((x) => !x.muted);
  assert.equal(heard.paused, false, 'the heard presenter is playing, not paused by the unmute');
});
