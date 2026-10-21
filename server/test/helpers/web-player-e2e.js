'use strict';

/*
 * A real server and a real headless Chrome running the real web player, for the bugs that only
 * show up there: a playlist change that reaches the player but never reaches the SCREEN (#632), a
 * player URL whose key is ignored because the browser kept old storage (#630), a start-with-sound
 * option that has to be judged by the browser itself (#627).
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, the same as the other browser suites,
 * so CI without a browser stays green. Each suite gets its own port and data directory.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./free-port');

const SERVER_DIR = path.join(__dirname, '..', '..');

function findChrome() {
  const candidates = [
    process.env.CHROME,
    process.env.CHROMIUM_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
  return null;
}
function findPuppeteer() {
  try { return require(path.join(SERVER_DIR, 'node_modules/puppeteer-core')); } catch { return null; }
}

const CHROME = findChrome();
const puppeteer = findPuppeteer();
const SKIP = (!CHROME || !puppeteer) ? (!puppeteer ? 'puppeteer-core not installed' : 'no Chrome binary found') : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(stepMs);
  }
  return last;
}

/** Boot a server with a fresh data directory and one signed-up account. `env` overrides the defaults. */
async function startServer(tag, env = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(os.tmpdir(), `st-${tag}-` + crypto.randomBytes(4).toString('hex'));
  const log = dataDir + '.log';
  const fd = fs.openSync(log, 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    // The server asks a screen for a fresh screenshot shortly after pairing or a content change
    // (lib/preview-refresh.js), deferred to a 60 s gap per screen. Those unprompted asks land on the
    // players these e2e tests drive, and a test counting "Screenshot requested" then counts one it
    // never sent (display-links-e2e "and not the other one"). None of these tests is about preview
    // refresh, so it is off for them (PREVIEW_REFRESH=off); preview-refresh-e2e starts its own server.
    env: { PREVIEW_REFRESH: 'off', ...process.env, DATA_DIR: dataDir, SELF_HOSTED: 'true', PORT: String(port), NODE_ENV: 'test', ...env },
    stdio: ['ignore', fd, fd],
  });
  const up = await waitFor(async () => {
    try { return (await fetch(base + '/api/status')).ok; } catch { return false; }
  }, 30000);
  if (!up) { try { proc.kill('SIGKILL'); } catch { /* */ } throw new Error('server did not boot:\n' + fs.readFileSync(log, 'utf8').slice(-2000)); }

  const reg = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `e2e${Date.now()}${crypto.randomBytes(2).toString('hex')}@x.test`, password: 'Passw0rd123' }),
  }).then((r) => r.json());
  if (!reg.token) throw new Error('could not sign up: ' + JSON.stringify(reg));
  const token = reg.token;

  async function api(method, p, body) {
    const r = await fetch(base + '/api' + p, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
    return json;
  }
  async function upload(file, mime) {
    const fdata = new FormData();
    fdata.append('file', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
    const r = await fetch(base + '/api/content', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fdata });
    const j = await r.json();
    if (!r.ok) throw new Error('upload failed: ' + JSON.stringify(j));
    return Array.isArray(j) ? j[0] : (j.items ? j.items[0] : (j.content || j));
  }
  /** A display made from the dashboard with a player link, as POST /api/devices/web-player does. */
  async function webPlayerDisplay(name) {
    const r = await api('POST', '/devices/web-player', { name });
    return { id: r.device.id, key: r.enrol_key };
  }

  return {
    base, api, upload, webPlayerDisplay, dataDir, token,
    stop() { try { proc.kill('SIGKILL'); } catch { /* */ } },
  };
}

async function launch(extraArgs = []) {
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--mute-audio', ...extraArgs],
  });
}

/** A page that records uncaught errors, so a test can assert the player never threw. */
async function playerPage(browser) {
  const page = await browser.newPage();
  page.errors = [];
  page.logs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => page.logs.push(m.text()));
  return page;
}

/** Read player state. Top-level `let`s of the classic script are reachable from evaluate. */
function player(page, expr) {
  return page.evaluate(expr).catch(() => undefined);
}

module.exports = { SKIP, sleep, waitFor, startServer, launch, playerPage, player };
