'use strict';

/*
 * 3.0 display links, END TO END in headless Chrome: "remote view works everywhere".
 *
 * The bug report: the same display link opened in two browsers took turns (each registration
 * evicted the other, the evicted one reconnected ~45 s later and evicted back), and two different
 * links in one browser shared one localStorage identity. Each test drives the real web player and
 * asks every screen for a frame the way the remote viewer does ('dashboard:request-screenshot' on
 * the dashboard socket), so "it answers with its own frame" is checked, not assumed.
 *
 *   a. two links in two tabs of ONE browser context: both play their own content, both survive a
 *      reload of either tab, each answers its own screenshot (red / blue);
 *   b. the SAME link in two contexts: the second opening is a MIRROR listed under the original,
 *      both play, both answer screenshots, a playlist change reaches both, no eviction loop, the
 *      same context reopening comes back as the same mirror, removing the mirror stops it, and a
 *      full plan says so on the screen;
 *   c. a display paired by code gets a link from the device page (the real dashboard UI), without
 *      disturbing its player, and the link identifies the same display;
 *   d. plain /player keeps its stored identity across this upgrade (old keys untouched), and a
 *      link page from before the upgrade moves its identity into its own namespace.
 *
 * Skips cleanly without Chrome / puppeteer-core. Firefox cannot run here; nothing in the design is
 * browser-specific (localStorage, sessionStorage, Socket.IO, a per-install id), see docs/web-player.md.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SKIP, waitFor, sleep, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

let srv, browser, tmp, red, blue, green;

const dbRun = (sql, ...a) => {
  const D = require('better-sqlite3');
  const d = new D(path.join(srv.dataDir, 'db', 'remote_display.db'));
  try { return d.prepare(sql)[/^\s*select/i.test(sql) ? 'all' : 'run'](...a); } finally { d.close(); }
};
const serverLog = () => fs.readFileSync(srv.dataDir + '.log', 'utf8');
const count = (re) => (serverLog().match(re) || []).length;

async function solidPng(file, rgba) {
  const { Jimp } = require('jimp');
  const img = new Jimp({ width: 320, height: 180, color: rgba });
  fs.writeFileSync(file, await img.getBuffer('image/png'));
  return file;
}

/** Upload `file` and make it the only thing `deviceId` plays. Returns the content id. */
async function playOn(deviceId, file) {
  const c = await srv.upload(file, 'image/png');
  const pl = await srv.api('POST', '/playlists', { name: 'P ' + path.basename(file) + ' ' + Date.now() });
  await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: c.id });
  await srv.api('POST', `/playlists/${pl.id}/publish`);
  await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: deviceId });
  return c.id;
}

/** A page in a NEW WINDOW of `ctx` (so it is visible), with the same error/log capture as playerPage. */
async function openWindow(ctx, url) {
  const cdp = await browser.target().createCDPSession();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, browserContextId: ctx.id, width: 640, height: 360 });
  await cdp.detach();
  const target = await ctx.waitForTarget((t) => t._targetId === targetId || (t._getTargetInfo && t._getTargetInfo().targetId === targetId));
  const page = await target.page();
  page.errors = [];
  page.logs = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => page.logs.push(m.text()));
  await page.setViewport({ width: 640, height: 360 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

let dash;
async function dashboardSocket() {
  if (dash && dash.connected) return dash;
  const { io } = require('socket.io-client');
  dash = io(srv.base + '/dashboard', { auth: { token: srv.token }, transports: ['websocket'] });
  await new Promise((res, rej) => { dash.once('connect', res); dash.once('connect_error', rej); });
  return dash;
}

/** What the remote viewer gets for `deviceId`: the mean colour of the screen's frame, or null. */
async function screenshotColour(deviceId) {
  const s = await dashboardSocket();
  const frame = new Promise((res) => {
    const h = (m) => { if (m && m.device_id === deviceId) { s.off('dashboard:screenshot-ready', h); res(m); } };
    s.on('dashboard:screenshot-ready', h);
    setTimeout(() => { s.off('dashboard:screenshot-ready', h); res(null); }, 20000);
  });
  s.emit('dashboard:request-screenshot', { device_id: deviceId });
  const m = await frame;
  if (!m || !/^data:image\//.test(m.image_data || '')) return null;
  const { Jimp } = require('jimp');
  const img = await Jimp.read(Buffer.from(m.image_data.split(',')[1], 'base64'));
  let r = 0, g = 0, b = 0, n = 0;
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, (x, y, i) => { r += img.bitmap.data[i]; g += img.bitmap.data[i + 1]; b += img.bitmap.data[i + 2]; n++; });
  const out = { r: r / n, g: g / n, b: b / n };
  if (process.env.DL_DEBUG) console.log("[colour]", deviceId, JSON.stringify(out), img.bitmap.width, img.bitmap.height);
  return out;
}
/*
 * Asked until it matches (or 30 s): a first load reloads itself once when its service worker takes
 * control, and a frame requested in that second shows the status card, not the content.
 */
const shows = (deviceId, pred) => waitFor(async () => pred(await screenshotColour(deviceId)), 30000, 1000);
const isRed = (c) => c && c.r > 150 && c.g < 90 && c.b < 90;
const isBlue = (c) => c && c.b > 150 && c.r < 90 && c.g < 90;
const isGreen = (c) => c && c.g > 120 && c.r < 90 && c.b < 90;

async function deviceRow(id) {
  try { return await srv.api('GET', `/devices/${id}`); } catch { return null; }
}
const connectedAs = (page, id) => player(page, `!!(socket && socket.connected) && config.deviceId === ${JSON.stringify(id)}`);
const playingContent = (page, contentId) => player(page, `playlist.length === 1 && playlist[0].content_id === ${JSON.stringify(contentId)}`);

before(async () => {
  if (SKIP) return;
  // PREVIEW_REFRESH=off: the server would otherwise ask each screen for a screenshot ~8 s after a change, and one
  // landing during the remote-view checks below counted as a request that reached "the other" screen (CI flake).
  srv = await startServer('display-links', { PREVIEW_REFRESH: 'off' });
  browser = await launch(['--autoplay-policy=no-user-gesture-required',
    // Several pages share one browser; keep the background ones running at full speed.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-media-'));
  red = await solidPng(path.join(tmp, 'red.png'), 0xdd1111ff);
  blue = await solidPng(path.join(tmp, 'blue.png'), 0x1111ddff);
  green = await solidPng(path.join(tmp, 'green.png'), 0x11bb11ff);
});
after(async () => {
  try { if (dash) dash.close(); } catch { /* */ }
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('display links: remote view works everywhere', { skip: SKIP }, () => {
  test('a. two display links in two windows of one browser (one storage): each plays, survives reloads and answers its own screenshot', { timeout: 180000 }, async () => {
    const d1 = await srv.webPlayerDisplay('Tab one');
    const d2 = await srv.webPlayerDisplay('Tab two');
    const c1 = await playOn(d1.id, red);
    const c2 = await playOn(d2.id, blue);
    const ctx = await browser.createBrowserContext();
    try {
      const p1 = await playerPage(ctx);
      await p1.setViewport({ width: 640, height: 360 });
      await p1.goto(`${srv.base}/player?k=${encodeURIComponent(d1.key)}`, { waitUntil: 'domcontentloaded' });
      // Its own WINDOW in the same context (same localStorage, same service worker): two displays on
      // two monitors from one browser. A second TAB would be a hidden page, and a hidden page is not
      // a screen anybody watches (Chrome also stops loading its images reliably, which is not this).
      const p2 = await openWindow(ctx, `${srv.base}/player?k=${encodeURIComponent(d2.key)}`);

      const bothRight = async () => (await connectedAs(p1, d1.id)) && (await connectedAs(p2, d2.id))
        && (await playingContent(p1, c1)) && (await playingContent(p2, c2));
      assert.ok(await waitFor(bothRight, 40000), 'both tabs play their own display');

      // Each display has its own storage namespace; neither touched the plain /player keys.
      const keys = await p1.evaluate(() => Object.keys(localStorage));
      assert.equal(keys.filter((k) => k.startsWith('rd_web_player::')).length, 2, 'two namespaced identities: ' + keys.join(','));
      assert.ok(!keys.includes('rd_web_player'), 'no shared identity key');
      const fps = await Promise.all([p1, p2].map((p) => p.evaluate(() => generateBrowserFingerprint())));
      assert.notEqual(fps[0], fps[1], 'two installs, two per-install fingerprints');

      assert.ok(await shows(d1.id, isRed), 'display one answers with its own (red) frame');
      assert.ok(await shows(d2.id, isBlue), 'display two answers with its own (blue) frame');

      for (const p of [p1, p2, p1]) {
        await p.reload({ waitUntil: 'domcontentloaded' });
        assert.ok(await waitFor(bothRight, 40000), 'both tabs still right after a reload');
      }
      assert.ok(await shows(d1.id, isRed), 'display one, after reloads');
      assert.ok(await shows(d2.id, isBlue), 'display two, after reloads');
      for (const id of [d1.id, d2.id]) assert.equal((await deviceRow(id)).status, 'online');
      assert.equal(count(new RegExp(`Evicting prior socket \\S+ for device (${d1.id}|${d2.id})`, 'g')), 0, 'no evictions between the tabs');
      assert.deepEqual([...p1.errors, ...p2.errors], [], 'the player threw');
    } finally { await ctx.close(); }
  });

  test('b. the same link in two browsers: the second is a mirror, both play and answer remote view; remove and plan limit', { timeout: 300000 }, async () => {
    const d = await srv.webPlayerDisplay('Lobby');
    const cRed = await playOn(d.id, red);
    const link = `${srv.base}/player?k=${encodeURIComponent(d.key)}`;
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const ctxC = await browser.createBrowserContext();
    try {
      const pA = await playerPage(ctxA);
      await pA.goto(link, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await connectedAs(pA, d.id)) && (await playingContent(pA, cRed)), 40000), 'the first opening is the display');

      const pB = await playerPage(ctxB);
      await pB.goto(link, { waitUntil: 'domcontentloaded' });
      const mirror = await waitFor(async () => {
        const row = await deviceRow(d.id);
        return row && row.mirrors && row.mirrors.length === 1 ? row.mirrors[0] : null;
      }, 40000);
      assert.ok(mirror, 'the second opening is listed as a mirror of the original');
      assert.match(mirror.name, /^Lobby \(mirror 1\)$/);
      assert.match(mirror.location, /Chrome on \w+ · 127\.0\.0\.1/);
      assert.ok(await waitFor(async () => (await connectedAs(pB, mirror.id)) && (await playingContent(pB, cRed)), 40000), 'the mirror plays the original\'s content');
      const mrow = await deviceRow(mirror.id);
      assert.equal(mrow.mirror_source.id, d.id, 'the mirror names its original');
      assert.equal(mrow.mirror_fingerprint, undefined, 'the owning fingerprint never leaves the server');

      // Both stay up: no tug-of-war for 30 s.
      const evictRe = new RegExp(`Evicting prior socket \\S+ for device (${d.id}|${mirror.id})`, 'g');
      const evictionsBefore = count(evictRe);
      for (let i = 0; i < 6; i++) {
        await sleep(5000);
        assert.ok(await connectedAs(pA, d.id), `original still connected at +${(i + 1) * 5}s`);
        assert.ok(await connectedAs(pB, mirror.id), `mirror still connected at +${(i + 1) * 5}s`);
      }
      assert.equal(count(evictRe), evictionsBefore, 'no evictions in 30 s');

      // Remote view: each one answers for itself (the page that captured logs the request).
      assert.ok(await shows(d.id, isRed), 'the original answers remote view');
      assert.ok(await shows(mirror.id, isRed), 'the mirror answers remote view');
      const asked = (p) => p.logs.filter((l) => l === 'Screenshot requested').length;
      // Screen verification can still ask a screen for its own occasional screenshot, so one stray request on
      // the other page is not proof of misrouting: try up to three times. A real misroute fails every time.
      for (const [id, mine, other] of [[d.id, pA, pB], [mirror.id, pB, pA]]) {
        let clean = false;
        for (let attempt = 0; attempt < 3 && !clean; attempt++) {
          const [m0, o0] = [asked(mine), asked(other)];
          assert.ok(await screenshotColour(id), 'a frame for ' + id);
          assert.ok(asked(mine) >= m0 + 1, 'the request reached the screen it was for');
          clean = asked(other) === o0;
        }
        assert.ok(clean, `a screenshot request for ${id} reached the other screen on three tries in a row`);
      }

      // A playlist change on the original reaches both.
      const cBlue = await playOn(d.id, blue);
      assert.ok(await waitFor(async () => (await playingContent(pA, cBlue)) && (await playingContent(pB, cBlue)), 30000), 'the change reached both');
      assert.ok(await shows(mirror.id, isBlue), 'the mirror shows the new content');

      // The same browser reopening the link comes back as the same mirror.
      await pB.close();
      const pB2 = await playerPage(ctxB);
      await pB2.goto(link, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => connectedAs(pB2, mirror.id), 40000), 'reopened as the same mirror');
      assert.equal((await deviceRow(d.id)).mirrors.length, 1, 'no second mirror row');
      assert.ok(await connectedAs(pA, d.id), 'the original was never disturbed');

      // Removing the mirror stops that opening, and it stays stopped (no re-registration).
      await srv.api('DELETE', `/devices/${mirror.id}`);
      assert.ok(await waitFor(() => player(pB2, `!!document.getElementById('st-mirror-hold') && /removed/.test(document.getElementById('st-mirror-hold').textContent)`), 20000), 'the mirror says it was removed');
      await sleep(8000);
      assert.ok(!(await player(pB2, '!!(socket && socket.connected)')), 'the removed mirror is not connected');
      assert.equal((await deviceRow(d.id)).mirrors.length, 0, 'and was not recreated');
      assert.ok(await connectedAs(pA, d.id), 'the original plays on');

      // Plan limit: with no screen to spare the new opening says so instead of failing silently.
      const users = dbRun('SELECT plan_id FROM users');
      const planIds = [...new Set(users.map((u) => u.plan_id).filter(Boolean))];
      const old = dbRun(`SELECT id, max_devices FROM plans WHERE id IN (${planIds.map(() => '?').join(',')})`, ...planIds);
      const screens = dbRun('SELECT COUNT(*) AS n FROM devices')[0].n;
      dbRun(`UPDATE plans SET max_devices = ? WHERE id IN (${planIds.map(() => '?').join(',')})`, screens, ...planIds);
      try {
        const pC = await playerPage(ctxC);
        await pC.goto(link, { waitUntil: 'domcontentloaded' });
        assert.ok(await waitFor(() => player(pC, `!!document.getElementById('st-mirror-hold') && /plan/.test(document.getElementById('st-mirror-hold').textContent)`), 30000),
          'the screen explains that the plan has no screen to spare');
        assert.equal((await deviceRow(d.id)).mirrors.length, 0, 'no mirror was made');
        assert.ok(await connectedAs(pA, d.id), 'the original plays on');
      } finally {
        for (const p of old) dbRun('UPDATE plans SET max_devices = ? WHERE id = ?', p.max_devices, p.id);
      }
      assert.deepEqual([...pA.errors, ...pB2.errors], [], 'the player threw');
    } finally { await ctxA.close(); await ctxB.close(); await ctxC.close(); }
  });

  test('c. a display paired by code gets a link on its device page; the link is the same display', { timeout: 180000 }, async () => {
    const ctxP = await browser.createBrowserContext();
    const ctxD = await browser.createBrowserContext();
    const ctxL = await browser.createBrowserContext();
    try {
      const pP = await playerPage(ctxP);
      await pP.goto(`${srv.base}/player`, { waitUntil: 'domcontentloaded' });
      const code = await waitFor(() => player(pP, 'socket && socket.connected && config.pairingCode'), 30000);
      assert.ok(code, 'the player shows a pairing code');
      const paired = await srv.api('POST', '/provision/pair', { pairing_code: code, name: 'Code paired' });
      const id = (paired.device && paired.device.id) || paired.id || paired.device_id;
      assert.ok(id, 'paired: ' + JSON.stringify(paired));
      assert.ok(await waitFor(() => connectedAs(pP, id), 30000), 'the code-paired player is the display');
      const tokenBefore = dbRun('SELECT device_token FROM devices WHERE id = ?', id)[0].device_token;
      const cGreen = await playOn(id, green);
      assert.ok(await waitFor(() => playingContent(pP, cGreen), 30000));

      // The dashboard's device page: Web player tab -> Create a web player link.
      const dashPage = await ctxD.newPage();
      await dashPage.setViewport({ width: 1400, height: 1000 });
      await dashPage.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
      await dashPage.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
      await dashPage.goto(`${srv.base}/app#/device/${id}`, { waitUntil: 'domcontentloaded' });
      await dashPage.waitForSelector('.tab[data-tab="webplayer"]', { timeout: 30000 });
      await dashPage.click('.tab[data-tab="webplayer"]');
      await dashPage.waitForSelector('#enrolCreateBtn', { visible: true, timeout: 15000 });
      await dashPage.click('#enrolCreateBtn');
      await dashPage.waitForSelector('#enrolUrl', { timeout: 15000 });
      const url = await dashPage.$eval('#enrolUrl', (el) => el.value);
      assert.match(url, /\/player\?k=/);

      // Creating the link did not disturb the player it already has.
      await sleep(4000);
      assert.ok(await connectedAs(pP, id), 'the code-paired player is still connected');
      assert.equal(await player(pP, 'config.deviceToken'), tokenBefore, 'and kept its token');
      assert.equal(dbRun('SELECT device_token FROM devices WHERE id = ?', id)[0].device_token, tokenBefore, 'the server kept it too');

      // That player goes away; the link opened elsewhere IS the same display (not a mirror, not new).
      await pP.close();
      await sleep(1500);
      const pL = await playerPage(ctxL);
      await pL.goto(url.replace(/^https?:\/\/[^/]+/, srv.base), { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await connectedAs(pL, id)) && (await playingContent(pL, cGreen)), 40000), 'the link plays as the same display');
      assert.equal((await deviceRow(id)).mirrors.length, 0);
      assert.ok(await shows(id, isGreen), 'and answers its remote view');
    } finally { await ctxP.close(); await ctxD.close(); await ctxL.close(); }
  });

  test('d. plain /player keeps its stored identity across the upgrade; an old link page moves into its namespace', { timeout: 120000 }, async () => {
    const plain = await srv.webPlayerDisplay('Plain player');
    const plainTok = dbRun('SELECT device_token FROM devices WHERE id = ?', plain.id)[0].device_token;
    const linked = await srv.webPlayerDisplay('Old link page');
    const linkedTok = dbRun('SELECT device_token FROM devices WHERE id = ?', linked.id)[0].device_token;

    const ctx = await browser.createBrowserContext();
    try {
      // Storage exactly as a player from before this change left it.
      const seed = await ctx.newPage();
      await seed.goto(`${srv.base}/api/status`);
      await seed.evaluate((s) => {
        localStorage.setItem('rd_web_player', JSON.stringify({ serverUrl: s.base, deviceId: s.id, deviceToken: s.tok, paired: true }));
        localStorage.setItem('st_install_id', 'legacy-install-plain');
        localStorage.setItem('st_group_sync', 'null');
      }, { base: srv.base, id: plain.id, tok: plainTok });
      const p = await playerPage(ctx);
      await p.goto(`${srv.base}/player`, { waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(() => connectedAs(p, plain.id), 30000), 'plain /player registered as its stored display');
      const st = await p.evaluate(() => ({ keys: Object.keys(localStorage), cfg: JSON.parse(localStorage.getItem('rd_web_player')), install: localStorage.getItem('st_install_id') }));
      assert.equal(st.cfg.deviceId, plain.id);
      assert.equal(st.cfg.deviceToken, plainTok);
      assert.equal(st.install, 'legacy-install-plain', 'its install id (and so its fingerprint) is unchanged');
      assert.ok(!st.keys.some((k) => k.includes('::')), 'plain /player never writes namespaced keys: ' + st.keys.join(','));
      await p.close();

      // A link page from before the upgrade: its identity sits in the un-namespaced keys, tagged with its key.
      const ctx2 = await browser.createBrowserContext();
      try {
        const seed2 = await ctx2.newPage();
        await seed2.goto(`${srv.base}/api/status`);
        await seed2.evaluate((s) => {
          localStorage.setItem('rd_web_player', JSON.stringify({ serverUrl: s.base, deviceId: s.id, deviceToken: s.tok, paired: true, enrolKey: s.key }));
          localStorage.setItem('st_install_id', 'legacy-install-link');
        }, { base: srv.base, id: linked.id, tok: linkedTok, key: linked.key });
        const q = await playerPage(ctx2);
        await q.goto(`${srv.base}/player?k=${encodeURIComponent(linked.key)}`, { waitUntil: 'domcontentloaded' });
        assert.ok(await waitFor(() => connectedAs(q, linked.id), 30000), 'the link page is its display');
        const st2 = await q.evaluate(() => ({ keys: Object.keys(localStorage), sfx: SCREEN_SUFFIX }));
        assert.ok(st2.sfx.startsWith('::'), 'a link page has a namespace');
        assert.ok(!st2.keys.includes('rd_web_player'), 'the old identity moved out of the shared key');
        assert.equal(await q.evaluate((k) => localStorage.getItem(k), 'st_install_id' + st2.sfx), 'legacy-install-link', 'with its install id');
        assert.equal(JSON.parse(await q.evaluate((k) => localStorage.getItem(k), 'rd_web_player' + st2.sfx)).deviceId, linked.id);
      } finally { await ctx2.close(); }
    } finally { await ctx.close(); }
  });
});
