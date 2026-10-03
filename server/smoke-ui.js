'use strict';

// Browser smoke test. NOT part of `npm test` — it needs a real Chrome, which CI does not have,
// and it boots a server and drives it. Run it deliberately:
//
//     npm run smoke                 (skips cleanly if no Chrome is installed)
//
// It lives OUTSIDE test/ on purpose: `node --test` globs that directory, so a file placed
// there is picked up by `npm test` no matter what the intent was — which is exactly what
// happened the first time, and it broke CI.
//     CHROME=/path/to/chrome npm run smoke
//
// It exists because a whole class of defect is invisible to the unit suite, to a syntax check
// and to review, and only appears in front of a browser. Every check below is here because it
// caught something real:
//
//   * a context menu whose only item read "schedule.ctx_new" — t() returns the KEY when a string
//     is missing, so a missing key ships as user-facing text
//   * pointer handlers stacking on every calendar render — five renders meant five PUTs on one
//     drop, which no unit test would ever notice
//   * the week grid forcing a horizontal scroll on a phone
//   * an uncaught error blanking a view
//
// Keep it fast and keep every assertion tied to a real past failure, or it becomes noise nobody
// runs.

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const VIEWS = ['#/', '#/content', '#/playlists', '#/layouts', '#/widgets', '#/schedule',
  '#/walls', '#/reports', '#/kiosk', '#/designer', '#/activity', '#/members', '#/help', '#/settings'];

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  try { return execSync('which google-chrome chromium 2>/dev/null | head -1').toString().trim() || null; }
  catch { return null; }
}

let puppeteer;
try { puppeteer = require('puppeteer-core'); } catch { puppeteer = null; }

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n         ${detail}`}`);
};

(async () => {
  const chrome = findChrome();
  if (!puppeteer || !chrome) {
    console.log(`SKIP: ui smoke needs puppeteer-core${chrome ? '' : ' and a Chrome binary'}.`);
    console.log('      npm i -D puppeteer-core   # and install Chrome, or set CHROME=/path/to/chrome');
    process.exit(0);
  }

  const DATA_DIR = path.join(os.tmpdir(), 'st-smoke-' + crypto.randomBytes(4).toString('hex'));
  const PORT = 4000 + Math.floor(Math.random() * 900);
  const BASE = `http://127.0.0.1:${PORT}`;
  const logFile = path.join(os.tmpdir(), 'st-smoke.log');
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'production' },
    stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
  });
  const stop = () => { try { srv.kill('SIGKILL'); } catch { /* */ } };
  process.on('exit', stop);

  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) { console.error('server did not start:\n' + fs.readFileSync(logFile, 'utf8').slice(-1500)); stop(); process.exit(1); }

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text())) errors.push(m.text().slice(0, 140)); });

  await page.goto(BASE + '/app#/login', { waitUntil: 'networkidle2' });
  const registered = await page.evaluate(async () => {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'smoke' + Date.now() + '@x.test', password: 'Passw0rd123' }) });
    const d = await r.json();
    if (d.token) localStorage.setItem('token', d.token);
    return !!d.token;
  });
  check('an account can be created', registered);

  // ---- every view: renders, no raw keys, no uncaught errors ----------------------------------
  const rawKeyOffenders = [];
  for (const hash of VIEWS) {
    const before = errors.length;
    await page.goto(BASE + '/app' + hash, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 900));
    const info = await page.evaluate(() => {
      const bare = [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0)
        .map(e => (e.textContent || '').trim())
        // A bare i18n key: dotted, lower-case, no spaces. Version strings (v1.2.3) are excluded.
        .filter(s => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(s) && !/^v?\d/.test(s));
      return { chars: (document.body.innerText || '').trim().length, bare: [...new Set(bare)] };
    });
    check(`renders ${hash}`, info.chars > 60, `only ${info.chars} chars of text`);
    if (info.bare.length) rawKeyOffenders.push(`${hash}: ${info.bare.join(', ')}`);
    check(`no uncaught error on ${hash}`, errors.length === before, errors.slice(before).join(' | '));
  }
  check('no untranslated keys rendered as text', rawKeyOffenders.length === 0, rawKeyOffenders.join('\n         '));

  // ---- a background picture can be added to a directory board WITHOUT leaving the form ---------
  //
  // ⚠️ THE REPORT THIS CAME FROM: "someone couldn't upload a background picture". They were right.
  // The picker was read-only and its own empty state said so — "Upload images first from Content
  // Library" — so the only route to a background was to abandon a half-filled widget form, cross to
  // another view, upload, and come back. Nothing threw, nothing failed, and no unit test could see
  // it, because the feature simply was not there. This drives the real dialog in a real browser.
  await page.goto(BASE + '/app#/widgets', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  // ---- every widget type can actually be OPENED for editing ------------------------------------
  //
  // ⚠️ Weather and Social could not be, for sixteen days. Both config forms interpolate esc() into
  // their HTML, and esc was never imported into views/widgets.js — so building the form threw
  // ReferenceError and the modal never appeared. Rendering the widgets VIEW proves nothing about
  // this: the throw is inside a click handler. One click per type is the whole guard.
  const formsBefore = errors.length;
  const formResults = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    for (const type of ['clock', 'weather', 'rss', 'text', 'webpage', 'social',
      'directory-board', 'directory-search', 'transition']) {
      const card = document.querySelector(`[data-create-type="${type}"]`);
      if (!card) { out[type] = 'no tile'; continue; }
      const form = document.getElementById('widgetConfigForm');
      if (form) form.innerHTML = '';        // so a form left over from the last type cannot pass for this one
      try { card.click(); } catch (e) { out[type] = 'threw: ' + e.message; continue; }
      await sleep(250);
      const f = document.getElementById('widgetConfigForm');
      out[type] = f && f.children.length ? 'ok' : 'empty form';
      const modal = document.getElementById('widgetModal');
      if (modal) modal.style.display = 'none';
    }
    return out;
  });
  const badForms = Object.entries(formResults).filter(([, v]) => v !== 'ok');
  check('every widget type opens its config form', badForms.length === 0,
    badForms.map(([k, v]) => `${k}: ${v}`).join(', '));
  check('no uncaught error while opening the widget forms', errors.length === formsBefore,
    errors.slice(formsBefore).join(' | '));

  const picker = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const card = q('[data-create-type="directory-board"]');
    if (!card) return { err: 'no directory-board tile in the widget type grid' };
    card.click();
    await sleep(200);
    const add = q('#wBgAdd');
    if (!add) return { err: 'the directory-board form has no "Add Background Image" button' };
    add.click();
    await sleep(400);

    const opened = {
      hasUploadButton: !!q('#cpUploadBtn'),
      hasFileInput: !!q('#cpFile'),
      // t() returns the KEY itself when a string is missing, so a new key ships as visible text.
      bareKeys: [...document.querySelectorAll('#cpBox *')]
        .filter(e => e.children.length === 0)
        .map(e => (e.textContent || '').trim())
        .filter(s => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(s)),
    };
    if (!opened.hasFileInput) return { ...opened, err: 'the picker has no file input' };

    // A real PNG, magic bytes and all — the server sniffs content, not the filename.
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'smoke-backdrop.png', { type: 'image/png' }));
    const input = q('#cpFile');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));

    // Wait for the upload to land as a tile in the grid.
    let tiles = 0;
    for (let i = 0; i < 60 && tiles === 0; i++) { await sleep(250); tiles = document.querySelectorAll('#cpList [data-pick-id]').length; }
    const status = (q('#cpStatus') || {}).textContent || '';
    const selectedAfterUpload = document.querySelectorAll('#cpList [data-check]')
      .length ? [...document.querySelectorAll('#cpList [data-check]')].filter(e => e.style.display !== 'none').length : 0;

    const done = q('#cpDone');
    if (done) done.click();
    await sleep(400);
    return {
      ...opened,
      tiles,
      status,
      selectedAfterUpload,
      onBoard: document.querySelectorAll('#wBgList img').length,
    };
  });

  check('the picker offers an upload', !picker.err && picker.hasUploadButton && picker.hasFileInput,
    picker.err || 'no upload control in the image picker — the whole point of the report');
  check('an uploaded picture lands in the picker', picker.tiles > 0,
    `no tile appeared after the upload (status: ${picker.status || 'none'})`);
  check('the uploaded picture comes back selected', picker.selectedAfterUpload > 0,
    'the file uploaded but was not selected, so Done would return nothing');
  check('it reaches the directory board', picker.onBoard > 0,
    'the picker resolved but no background image is on the widget form');
  check('the picker renders no untranslated keys', (picker.bareKeys || []).length === 0,
    (picker.bareKeys || []).join(', '));


  // ---- an HTML bundle uploads, flattens, runs, and stays out of the player's origin -------------
  //
  // ⚠️ THE ISOLATION HALF OF THIS IS THE POINT. A bundle is operator-uploaded HTML that runs its own
  // scripts, and the only thing between it and the player's localStorage — which holds the device
  // token — is the frame's sandbox attribute. That is worth asserting in a real browser rather than
  // trusting, and it has to be asserted with the RIGHT property: `location.origin` returns the
  // origin of the URL, not of the document, so it reads as the real host even inside an opaque
  // frame. `self.origin` and an actual localStorage access are what answer the question.
  const bundleZip = (() => {
    const files = {
      'index.html': '<!doctype html><link rel="stylesheet" href="s.css"><h1 id="h">waiting</h1><script src="p.js"></script>',
      's.css': 'body{background:rgb(1,2,3)}',
      'p.js': "document.getElementById('h').textContent='ran';"
        + "var r={st:'bundle-ran',viaPreview:location.hash==='#preview',selfOrigin:String(self.origin),bg:getComputedStyle(document.body).backgroundColor};"
        + "try{localStorage.setItem('x','1');r.storage='READABLE'}catch(e){r.storage='blocked'}"
        + "try{r.parentDom=String(parent.document.title)}catch(e){r.parentDom='blocked'}"
        + "try{parent.postMessage(r,'*')}catch(e){}",
    };
    const zlib = require('node:zlib');
    const locals = [], central = [];
    let offset = 0;
    for (const [name, data] of Object.entries(files)) {
      const raw = Buffer.from(data), nb = Buffer.from(name);
      const crc = zlib.crc32 ? zlib.crc32(raw) >>> 0 : 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(nb.length, 26);
      locals.push(lh, nb, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x800, 8); ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24);
      ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      ch.writeUInt32LE(offset, 42);
      central.push(ch, nb);
      offset += lh.length + nb.length + raw.length;
    }
    const cd = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]).toString('base64');
  })();

  await page.goto(BASE + '/app#/content', { waitUntil: 'networkidle2' });
  const bundleResult = await page.evaluate(async (b64) => {
    const auth = { Authorization: 'Bearer ' + localStorage.getItem('token') };
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('files', new File([bytes], 'smoke-bundle.zip', { type: 'application/zip' }));
    const up = await fetch('/api/content', { method: 'POST', headers: auth, body: fd });
    if (!up.ok) return { err: 'upload ' + up.status + ' ' + (await up.text()).slice(0, 120) };
    const row = await up.json();

    // The public render gate needs the content referenced by a playlist, exactly like /file.
    const pl = await (await fetch('/api/playlists', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'smoke bundle' }) })).json();
    await fetch(`/api/playlists/${pl.id}/items`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_id: row.id, duration_sec: 15 }) });

    const got = new Promise((r) => {
      window.addEventListener('message', (e) => { if (e.data && e.data.st === 'bundle-ran') r(e.data); });
      setTimeout(() => r(null), 9000);
    });
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');   // exactly what the player sets
    f.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
    f.src = `/api/content/${row.id}/bundle?rev=${row.updated_at || 0}`;
    document.body.appendChild(f);
    const msg = await got;

    /*
     * ⚠️ AND THE DASHBOARD'S OWN PREVIEW, WHICH TAKES A DIFFERENT ROUTE. The public /bundle URL is
     * gated on the content being in a playlist; a just-uploaded bundle is not, which is exactly the
     * "preview shows an empty box" trap the directory-board backgrounds had. The library mints an
     * ephemeral session instead — and that path needed its own dashboard-CSP exemption, which is
     * invisible until something actually mounts it.
     */
    const got2 = new Promise((r) => {
      window.addEventListener('message', (e) => { if (e.data && e.data.st === 'bundle-ran' && e.data.viaPreview) r(e.data); });
      setTimeout(() => r(null), 9000);
    });
    let previewErr = null, session = null;
    try {
      const pr = await fetch(`/api/content/${row.id}/bundle-preview`, { method: 'POST', headers: auth });
      if (!pr.ok) previewErr = 'mint ' + pr.status;
      else session = await pr.json();
    } catch (e) { previewErr = String(e && e.message); }
    if (session) {
      const f2 = document.createElement('iframe');
      f2.setAttribute('sandbox', 'allow-scripts');
      f2.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
      // Mark it so the two frames' messages cannot be confused for one another.
      f2.src = session.url + '#preview';
      document.body.appendChild(f2);
    }
    const previewMsg = await got2;

    return { contentId: row.id, mime: row.mime_type, entry: row.bundle_entry, msg, previewErr, previewUrl: session && session.url, previewMsg };
  }, bundleZip);

  check('an HTML bundle uploads and is typed as one', !bundleResult.err
    && bundleResult.mime === 'application/vnd.screentinker.bundle+zip' && bundleResult.entry === 'index.html',
    bundleResult.err || `mime=${bundleResult.mime} entry=${bundleResult.entry}`);
  check('a flattened bundle RUNS its own scripts in the player\'s sandbox',
    !!(bundleResult.msg && bundleResult.msg.bg === 'rgb(1, 2, 3)'),
    bundleResult.msg ? `no stylesheet applied (bg=${bundleResult.msg.bg})` : 'the bundle never reported back — it did not run');
  check('a bundle previews from the content library before it is assigned anywhere',
    !bundleResult.previewErr && !!bundleResult.previewMsg && bundleResult.previewMsg.bg === 'rgb(1, 2, 3)',
    bundleResult.previewErr || (bundleResult.previewUrl
      ? 'the preview session minted but the frame never ran — check the dashboard CSP exemption'
      : 'no preview session was minted'));
  check('⚠️ and it CANNOT reach the player origin', !!(bundleResult.msg
    && bundleResult.msg.selfOrigin === 'null'
    && bundleResult.msg.storage === 'blocked'
    && bundleResult.msg.parentDom === 'blocked'),
    bundleResult.msg
      ? `origin=${bundleResult.msg.selfOrigin} storage=${bundleResult.msg.storage} parent=${bundleResult.msg.parentDom}`
      : 'no report');


  // ---- a bundle plays OFFLINE, and the CSP trap that decides how it is mounted ----------------
  //
  // ⚠️ TWO CLAIMS, BOTH MEASURED, BECAUSE BOTH LOOK FINE WHEN THEY ARE BROKEN.
  //
  // 1. The player mounts a bundle by fetching it SAME-ORIGIN and setting srcdoc, not by pointing
  //    iframe.src at it. That is the whole offline story: a URL-mounted sandboxed frame is an
  //    opaque-origin client and the service worker does not control it (sw.js records the
  //    measurement), so a src= mount never reaches the Cache API. The fetch does.
  // 2. srcdoc INHERITS THE PARENT'S CSP. It runs on /player, which is CSP-exempt, and is silently
  //    script-dead on any page that has a policy — which is why the dashboard preview navigates to
  //    an ephemeral URL instead. Both directions are asserted here; getting this backwards produces
  //    a page that renders, is styled, and does nothing.
  const playerPage = await browser.newPage();
  await playerPage.goto(BASE + '/player', { waitUntil: 'networkidle2' });
  const sw = await playerPage.evaluate(async () => {
    if (!navigator.serviceWorker) return 'no serviceWorker';
    try { await navigator.serviceWorker.register('/sw.js'); } catch (e) { return 'register failed'; }
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 40 && !navigator.serviceWorker.controller; i++) await new Promise(s => setTimeout(s, 250));
    return navigator.serviceWorker.controller ? 'controlling' : 'not controlling';
  });

  const bundleId = bundleResult.contentId;
  const mountOnPlayer = await playerPage.evaluate(async (id) => {
    const got = new Promise((r) => {
      window.addEventListener('message', (e) => { if (e.data && e.data.st === 'bundle-ran') r(e.data); });
      setTimeout(() => r(null), 9000);
    });
    const html = await (await fetch(`/api/content/${id}/bundle?rev=0`, { credentials: 'omit' })).text();
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts');
    f.style.cssText = 'position:fixed;left:-9999px;width:640px;height:360px';
    f.srcdoc = html;
    document.body.appendChild(f);
    return await got;
  }, bundleId);

  check('a bundle runs when mounted as srcdoc on the player', !!(mountOnPlayer && mountOnPlayer.bg === 'rgb(1, 2, 3)'),
    mountOnPlayer ? `mounted but wrong style (${mountOnPlayer.bg})` : 'the srcdoc frame never ran — check that /player is still CSP-exempt');
  check('⚠️ and is still isolated from the player origin',
    !!(mountOnPlayer && mountOnPlayer.selfOrigin === 'null' && mountOnPlayer.storage === 'blocked'),
    mountOnPlayer ? `origin=${mountOnPlayer.selfOrigin} storage=${mountOnPlayer.storage}` : 'no report');

  // Now cut the network and ask for the same render again.
  await playerPage.setOfflineMode(true);
  const offline = await playerPage.evaluate(async (id) => {
    const out = {};
    try { await fetch('/api/status'); out.control = 'REACHED SERVER — offline mode did not take'; }
    catch (e) { out.control = 'network down'; }
    try {
      const r = await fetch(`/api/content/${id}/bundle?rev=0`, { credentials: 'omit' });
      const t = await r.text();
      out.served = r.ok; out.hasScript = /data:text\/javascript/.test(t);
    } catch (e) { out.served = false; out.err = String(e.message); }
    return out;
  }, bundleId);
  await playerPage.setOfflineMode(false);
  /*
   * ⚠️ UNREGISTER BEFORE LEAVING. sw.js takes scope '/' deliberately (server.js serves it from the
   * root so it can control the whole origin), so a worker registered here keeps intercepting every
   * later page in this run — which wedged the calendar reload below the first time. The worker is
   * the thing under test, not a fixture; it does not get to outlive its test.
   */
  await playerPage.evaluate(async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* best effort */ }
  });
  await playerPage.close();

  check('⚠️ the bundle render survives the network going away', sw === 'controlling'
    && offline.control === 'network down' && offline.served === true && offline.hasScript === true,
    `worker=${sw} control=${offline.control} served=${offline.served} hasScript=${offline.hasScript} ${offline.err || ''}`);


  // ---- a second workspace can be created, from the UI, by an ordinary signup -------------------
  //
  // ⚠️ THE BUG THIS GUARDS IS AN ABSENCE, WHICH IS THE HARDEST KIND TO NOTICE. Production had 313
  // organizations and 313 workspaces — one each, all named "Default" — which reads like nobody
  // wanted a second one and actually meant no route existed to create one. Everything underneath
  // (scoping, invites, the switcher, the JWT context) was built and working the whole time. So the
  // assertion that matters is not "the endpoint returns 201" but "a person who just signed up can
  // find it and use it", which is the part that was missing.
  await page.goto(BASE + '/app#/', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  const affordance = await page.evaluate(() => {
    const btn = document.querySelector('[data-create-workspace]');
    return { present: !!btn, visible: !!(btn && btn.offsetParent !== null) };
  });
  check('a new signup is offered "New workspace" in the switcher', affordance.present && affordance.visible,
    affordance.present ? 'the control exists but is not visible' : 'no [data-create-workspace] in the switcher');

  const modalOpened = await page.evaluate(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const btn = document.querySelector('[data-create-workspace]');
    if (!btn) return { err: 'no create control' };
    btn.click();
    for (let i = 0; i < 40 && !document.getElementById('createWsName'); i++) await sleep(100);
    const input = document.getElementById('createWsName');
    if (!input) return { err: 'the modal never opened' };
    // t() returns the KEY itself when a string is missing, so a new key ships as visible text.
    const bare = [...document.querySelectorAll('.modal *')]
      .filter((e) => e.children.length === 0)
      .map((e) => (e.textContent || '').trim())
      .filter((s) => /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(s));
    return { ok: true, bare };
  });
  check('the create dialog opens and is fully translated', !modalOpened.err && (modalOpened.bare || []).length === 0,
    modalOpened.err || 'untranslated keys rendered: ' + (modalOpened.bare || []).join(', '));

  if (!modalOpened.err) {
    await page.evaluate(() => {
      document.getElementById('createWsName').value = 'Retail Floor';
      document.getElementById('createWsName').dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('createWsSave').click();
    });
    // The modal switches into the new workspace and reloads, so wait the navigation out.
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));

    const after = await page.evaluate(async () => {
      const me = await (await fetch('/api/auth/me', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } })).json();
      return {
        current: me.current_workspace && me.current_workspace.name,
        count: (me.accessible_workspaces || []).length,
        names: (me.accessible_workspaces || []).map((w) => w.name).sort(),
      };
    });
    check('the new workspace exists and the operator is left standing in it', after.count === 2
      && after.current === 'Retail Floor',
      `workspaces=${after.count} (${(after.names || []).join(', ')}) current=${after.current} — landing back in the OLD one reads as "nothing happened"`);

    // And with two of them the switcher must become a real dropdown carrying both.
    const rows = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.workspace-switcher-item')];
      const create = document.querySelector('[data-create-workspace]');
      const menu = document.querySelector('.workspace-switcher-menu');
      return {
        items: items.length,
        hasCreate: !!create,
        // ⚠️ It must live UNDER the selector, not among the things being chosen between. Inside the
        // menu it reads as a workspace you can switch to, and every item in there is required to
        // carry data-search or the filter throws on the first keystroke.
        createInsideMenu: !!(create && menu && menu.contains(create)),
        everyItemFilterable: items.every((i) => typeof i.dataset.search === 'string' && !!i.dataset.workspaceId),
      };
    });
    check('the switcher lists both workspaces and still offers a third', rows.items === 2 && rows.hasCreate,
      `rows=${rows.items} create=${rows.hasCreate}`);
    check('⚠️ "New workspace" sits under the selector, not among the workspaces', !rows.createInsideMenu
      && rows.everyItemFilterable,
      `insideMenu=${rows.createInsideMenu} everyItemFilterable=${rows.everyItemFilterable}`);
  }


  // ---- the slide editor's AI panel is wired, and reports the server's reason -------------------
  //
  // ⚠️ THE MODEL IS NOT UNDER TEST — there is no AI endpoint configured here, and asserting on
  // generated content would be asserting on a language model. What IS testable, and is the part
  // that breaks silently, is the wiring: the control exists, the empty-prompt guard fires without
  // a round trip, and a real failure surfaces the SERVER'S words rather than a blank status line.
  // "AI is not configured" is a sentence an operator can act on; a silent no-op is not.
  await page.goto(BASE + '/app#/slides', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  // Create the deck, THEN reload — assigning location.hash to the hash you are already on fires no
  // hashchange, so the list would never re-render and the new deck would never appear.
  const made = await page.evaluate(async () => {
    const auth = { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' };
    const deck = await (await fetch('/api/slide-decks', {
      method: 'POST', headers: auth, body: JSON.stringify({ name: 'AI smoke deck' }) })).json();
    return deck && deck.id ? { id: deck.id } : { err: 'could not create a deck: ' + JSON.stringify(deck).slice(0, 120) };
  });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 900));

  const ai = await page.evaluate(async (deck) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    if (deck.err) return { err: deck.err };
    // The list renders an "Edit" button carrying data-open=<deckId>; that is the way in.
    let openBtn = null;
    for (let i = 0; i < 40 && !openBtn; i++) {
      openBtn = [...document.querySelectorAll('[data-open]')].find((b) => b.dataset.open === deck.id);
      if (!openBtn) await sleep(150);
    }
    if (!openBtn) return { err: 'the new deck never appeared in the list' };
    openBtn.click();
    for (let i = 0; i < 40 && !document.getElementById('aiPrompt'); i++) await sleep(150);

    const prompt = document.getElementById('aiPrompt');
    const btn = document.getElementById('aiGenBtn');
    const cfg = document.getElementById('aiCfgBtn');
    const status = document.getElementById('aiStatus');
    if (!prompt || !btn) return { err: 'the editor opened but has no AI controls' };

    // 1. empty prompt: refused locally, no request made.
    btn.click();
    await sleep(200);
    const emptyMsg = (status.textContent || '').trim();

    // 2. a real prompt with no AI configured: the server's reason must reach the status line.
    prompt.value = 'autumn sale, 40% off, bold';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    btn.click();
    /*
     * ⚠️ WAIT FOR A NON-EMPTY RESULT, not merely for the text to CHANGE. aiGenerate clears the
     * status line before it starts the request, so "different from the last message" is satisfied
     * instantly by the empty string and the poll reads nothing.
     */
    let failMsg = '';
    for (let i = 0; i < 80; i++) {
      await sleep(150);
      const cur = (status.textContent || '').trim();
      if (cur && cur !== emptyMsg) { failMsg = cur; break; }
    }

    return { ok: true, hasCfg: !!cfg, emptyMsg, failMsg };
  }, made);

  check('the slide editor offers AI generation', !ai.err && ai.hasCfg,
    ai.err || 'the prompt/generate/settings controls are not all present');
  check('an empty prompt is refused without a round trip', !ai.err && /first|prompt|say/i.test(ai.emptyMsg || ''),
    `status said ${JSON.stringify(ai.emptyMsg)}`);
  check("⚠️ a generation failure shows the SERVER'S reason, not a blank line",
    !ai.err && /not configured|endpoint|AI/i.test(ai.failMsg || ''),
    `status said ${JSON.stringify(ai.failMsg)} — a silent no-op here is indistinguishable from a broken button`);

  // ---- the calendar binds its pointer handlers ONCE -------------------------------------------
  await page.goto(BASE + '/app#/schedule', { waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise(r => setTimeout(r, 1200));
  const cdp = await page.target().createCDPSession();
  const countListeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.getElementById("calendar")' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter(l => l.type === 'pointerdown').length;
  };
  const first = await countListeners();
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => document.getElementById('nextWeek')?.click());
    await new Promise(r => setTimeout(r, 500));
  }
  const later = await countListeners();
  check('calendar handlers do not stack per render', first === 1 && later === 1,
    `pointerdown listeners: ${first} then ${later} — each extra one repeats the drag's PUT`);

  // ---- a phone-width viewport must not scroll sideways -----------------------------------------
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  const overflowing = [];
  for (const hash of ['#/', '#/schedule', '#/content', '#/settings']) {
    await page.goto(BASE + '/app' + hash, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 900));
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
    if (m.doc > m.win + 4) overflowing.push(`${hash} (${m.doc}px in ${m.win}px)`);
  }
  check('no horizontal overflow at phone width', overflowing.length === 0, overflowing.join(', '));

  await browser.close();
  stop();

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
