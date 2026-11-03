'use strict';
/*
 * A PAIRED web player that boots while its server is unreachable must not show the setup form.
 *
 * Reported from an LG panel on "Play via URL": after the network dropped, the browser reloaded the
 * page and it came back on "Server URL / Connect" with "Connection failed: xhr poll error" under it.
 * The form was hidden only when a cached playlist was restored, so a paired screen with nothing to
 * restore looked unpaired and invited a re-pair. Now it shows the connecting card and keeps retrying.
 *
 * The page is served by a live server (so its scripts load) while the player's configured server URL
 * is a dead port, which is exactly what an offline panel sees: page from the worker, socket failing.
 *
 * SKIPS cleanly when no Chrome/Chromium or puppeteer-core is available.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('./helpers/free-port');

function findChromium() {
  const candidates = [process.env.CHROMIUM_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
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
let proc, BASE, DEAD, DATA_DIR, LOG, browser;

before(async () => {
  if (SKIP) return;
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-offline-boot-e2e-'));
  LOG = path.join(DATA_DIR, 'server.log');
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  DEAD = `http://127.0.0.1:${await freePort()}`;   // nothing listens here
  const logFd = fs.openSync(LOG, 'a');
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 160 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error('server did not boot: ' + fs.readFileSync(LOG, 'utf8').slice(-2000));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});

after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (proc) await new Promise((r) => { proc.once('exit', r); proc.kill('SIGKILL'); });
  if (DATA_DIR) fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

async function bootOffline(route, cfg) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument((c) => { try { localStorage.setItem('rd_web_player', JSON.stringify(c)); } catch (_) { /* */ } }, cfg);
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded' });
  // Past the 5 s tap overlay, so connect() has run and failed at least once.
  await sleep(7500);
  const state = await page.evaluate(() => {
    const vis = (id) => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
    return {
      setup: vis('setupScreen'),
      status: vis('statusOverlay'),
      statusText: (document.getElementById('statusOverlay') || {}).textContent || '',
      setupStatus: (document.getElementById('setupStatus') || {}).textContent || '',
    };
  });
  await page.close();
  return state;
}

for (const route of ['/player', '/player/legacy']) {
  test(`${route}: a paired player booting with its server unreachable shows "Connecting", not the setup form`, { skip: SKIP }, async () => {
    const s = await bootOffline(route, { serverUrl: DEAD, deviceId: 'dev-offline-1', deviceToken: 'devtok_x', paired: true });
    assert.equal(s.setup, false, 'setup form must stay hidden for a paired screen: ' + JSON.stringify(s));
    assert.equal(s.status, true, 'the connecting card is up');
    assert.match(s.statusText, /Connecting/);
    assert.match(s.setupStatus, /Connection failed/, 'the socket really did fail (the scenario is real, not vacuous)');
  });

  test(`${route}: an UNPAIRED player still shows the setup form`, { skip: SKIP }, async () => {
    const s = await bootOffline(route, { serverUrl: DEAD });
    assert.equal(s.setup, true, JSON.stringify(s));
  });
}
