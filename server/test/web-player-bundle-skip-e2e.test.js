'use strict';

/*
 * #649 — an HTML bundle tells the player to skip it:
 *
 *   parent.postMessage({ type: 'screentinker:skip', reason: 'offline' }, '*')
 *
 * In a real headless Chrome running the real web player against a real server, with real bundle
 * zips uploaded through the content API and flattened by the server, exactly as a screen gets them.
 * Asks for: a skip moves on at once and leaves no play behind; only the bundle on screen is heard
 * (not another frame, not a frame the bundle embeds, not a bundle that has already been replaced);
 * a skip is honoured once per item per pass, so a playlist where everything skips does not spin;
 * and in a layout a skip moves only its own zone.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { SKIP, sleep, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

// A 2x2 PNG, written out per image so each upload is its own content row.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bskip-'));

/* A stored (method 0) zip of the given files: enough for the server's bundle validator. */
function zip(files) {
  const crc32 = (b) => zlib.crc32(b) >>> 0;
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'); const nb = Buffer.from(name, 'utf8'); const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x2100, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    locals.push(lh, nb, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x2100, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nb);
    offset += lh.length + nb.length + data.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>b</title></head><body style="background:#123">${body}</body></html>`;
// Asks at once, before its own load event, with a reason that needs sanitising.
const SKIP_NOW = page(`<h1>skip now</h1><script>parent.postMessage({ type: 'screentinker:skip', reason: 'offline\\n  now' }, '*');</script>`);
// Asks at once and keeps asking — a bundle that never has anything to show.
const SKIP_ALWAYS = page(`<h1>always</h1><script>
  function s() { parent.postMessage({ type: 'screentinker:skip', reason: 'empty' }, '*'); }
  s(); setInterval(s, 250);</script>`);
// Never asks itself, but embeds a frame that tries to, at the player's window directly.
const NESTED = page(`<h1>quiet</h1><iframe id="child" srcdoc="<script>function s(){try{top.postMessage({type:'screentinker:skip'},'*')}catch(e){}} s(); setInterval(s,250);</script>"></iframe>`);

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('bundle-skip');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function bundle(name, html) {
  const f = path.join(TMP, `${name}-${crypto.randomBytes(3).toString('hex')}.zip`);
  fs.writeFileSync(f, zip({ 'index.html': html }));
  const c = await srv.upload(f, 'application/zip');
  assert.equal(c.mime_type, 'application/vnd.screentinker.bundle+zip', 'the upload became a bundle');
  return c;
}
async function image(name) {
  const f = path.join(TMP, `${name}-${crypto.randomBytes(3).toString('hex')}.png`);
  fs.writeFileSync(f, PNG);
  return srv.upload(f, 'image/png');
}
async function playlistOn(display, items, extra) {
  const pl = await srv.api('POST', '/playlists', { name: 'P ' + crypto.randomBytes(3).toString('hex') });
  for (const it of items) await srv.api('POST', `/playlists/${pl.id}/items`, it);
  await srv.api('POST', `/playlists/${pl.id}/publish`);
  if (extra) await extra();
  await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: display.id });
  return pl;
}
/*
 * The player in a fresh context. Before any player script runs: count every skip message that
 * reaches the player's window (so "ignored" is proven to be ignored, not undelivered), and keep
 * every iframe the stage ever held (so a replaced bundle's frame can be brought back).
 */
async function open(display) {
  const ctx = await browser.createBrowserContext();
  const p = await playerPage(ctx);
  await p.evaluateOnNewDocument(() => {
    window.__skipMsgs = 0;
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'screentinker:skip') window.__skipMsgs++; });
    window.__frames = [];

    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.tagName === 'IFRAME' && window.__frames.indexOf(n) < 0) window.__frames.push(n);
    }).observe(document, { childList: true, subtree: true });
  });
  await p.goto(`${srv.base}/player?k=${encodeURIComponent(display.key)}`, { waitUntil: 'domcontentloaded' });
  return { ctx, page: p };
}
function db() {
  const Database = require('better-sqlite3');
  return new Database(path.join(srv.dataDir, 'db', 'remote_display.db'), { readonly: true });
}
function playRows(deviceId, contentId) {
  const ro = db();
  try { return ro.prepare('SELECT * FROM play_logs WHERE device_id = ? AND content_id = ? ORDER BY id').all(deviceId, contentId); }
  finally { ro.close(); }
}
const skippedLogs = (p) => p.logs.filter((l) => l.startsWith('[bundle] skipped'));
const playingLogs = (p) => p.logs.filter((l) => l.startsWith('Playing:'));

describe('#649 a bundle can ask the web player to skip it', { skip: SKIP }, () => {
  test('a skip advances at once, logs the sanitised reason, and leaves no play behind', async () => {
    const d = await srv.webPlayerDisplay('Skip now');
    const lead = await image('lead');
    const b = await bundle('skip-now', SKIP_NOW);
    const img = await image('after');
    // It opens on an image, so the bundle starts on a registered socket: a screen's very first
    // play_start can race its own registration and be dropped, which would prove nothing here.
    await playlistOn(d, [{ content_id: lead.id, duration_sec: 3 }, { content_id: b.id, duration_sec: 60 }, { content_id: img.id, duration_sec: 60 }]);
    const { ctx, page: p } = await open(d);
    try {
      assert.ok(await waitFor(() => player(p, 'playlist.length === 3 && currentIndex === 1 || currentIndex === 2'), 30000), 'past the lead image');
      const t0 = Date.now();
      // The bundle's duration is a minute: only the skip can have moved it on within seconds.
      assert.ok(await waitFor(() => player(p, 'currentIndex === 2'), 10000), 'the player moved past the bundle');
      assert.ok(Date.now() - t0 < 5000, 'at once');
      assert.equal(await player(p, 'socket && socket.connected'), true, 'online, so plays are reported live');
      const lines = skippedLogs(p);
      assert.equal(lines.length, 1, `one skip: ${JSON.stringify(lines)}`);
      assert.match(lines[0], /"skip-now-[0-9a-f]+\.zip" — offline now$/, 'the reason is logged, on one line');

      // Proof of play: the image's play is recorded; the bundle's start was retracted.
      assert.ok(await waitFor(() => playRows(d.id, img.id).length >= 1, 10000), 'the next item is recorded');
      await sleep(1500);
      assert.deepEqual(playRows(d.id, b.id), [], 'the skipped bundle is not a play');
      // And the throttle was wound back: the next item's start, a moment later, was not dropped.
      assert.equal(playRows(d.id, img.id).length, 1);
      assert.deepEqual(p.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });

  test('another frame, a frame inside the bundle, and a replaced bundle are not heard', async () => {
    const d = await srv.webPlayerDisplay('Not heard');
    const quiet = await bundle('nested', NESTED);
    const img = await image('second');
    const skipper = await bundle('skip-first', SKIP_NOW);
    const lead = await image('lead2');
    await playlistOn(d, [
      { content_id: lead.id, duration_sec: 3 },
      { content_id: skipper.id, duration_sec: 60 },
      { content_id: quiet.id, duration_sec: 8 },
      { content_id: img.id, duration_sec: 60 },
    ]);
    const { ctx, page: p } = await open(d);
    try {
      // The first bundle skips itself (heard), landing on the quiet one whose child keeps asking.
      assert.ok(await waitFor(() => player(p, 'playlist.length === 4 && currentIndex === 2'), 30000), 'on the quiet bundle');
      const startedAt = Date.now();
      // A frame that is no bundle at all, on the player's own page, asking too.
      await p.evaluate(() => {
        const f = document.createElement('iframe');
        f.setAttribute('sandbox', 'allow-scripts');
        f.srcdoc = "<script>setInterval(function(){parent.postMessage({type:'screentinker:skip'},'*')},250)</script>";
        document.body.appendChild(f);
      });
      // ⚠️ AND THE FRAME OF THE BUNDLE THAT ALREADY SKIPPED, put back on the page: same element,
      // same document, asking again — it is no longer the bundle on screen.
      const back = await p.evaluate(() => {
        const old = window.__frames.find((f) => f.getAttribute('srcdoc') && f.getAttribute('srcdoc').includes('skip now'));
        if (!old) return false;
        document.body.appendChild(old);
        return true;
      });
      assert.ok(back, 'precondition: the replaced bundle frame was found and re-attached');

      await sleep(5000);
      assert.equal(await player(p, 'currentIndex'), 2, 'the quiet bundle was not skipped by anyone else');
      const msgs = await player(p, 'window.__skipMsgs');
      assert.ok(msgs >= 10, `the other frames' messages did reach the player's window (${msgs})`);
      assert.ok(p.frames().length >= 4, 'the nested child, the foreign frame and the re-attached one are all running');
      assert.equal(skippedLogs(p).length, 1, `only the first bundle's own skip was honoured: ${JSON.stringify(skippedLogs(p))}`);
      // The quiet bundle then plays its normal duration.
      assert.ok(await waitFor(() => player(p, 'currentIndex === 3'), 10000), 'the quiet bundle ran its duration');
      assert.ok(Date.now() - startedAt >= 6000, 'and not early');
      assert.ok(await waitFor(() => playRows(d.id, quiet.id).length === 1, 5000), 'the quiet bundle IS a play');
      assert.deepEqual(playRows(d.id, skipper.id), [], 'the skipped one is not');
      assert.deepEqual(p.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });

  test('once per item per pass: a playlist where everything skips does not spin', async () => {
    const d = await srv.webPlayerDisplay('All skip');
    const a = await bundle('always-a', SKIP_ALWAYS);
    const b = await bundle('always-b', SKIP_ALWAYS);
    await playlistOn(d, [{ content_id: a.id, duration_sec: 4 }, { content_id: b.id, duration_sec: 4 }]);
    const { ctx, page: p } = await open(d);
    try {
      assert.ok(await waitFor(() => player(p, 'playlist.length === 2 && isPlaying'), 30000), 'playing');
      const from = playingLogs(p).length;
      const t0 = Date.now();
      await sleep(12000);
      const renders = playingLogs(p).length - from;
      const skips = skippedLogs(p).length;
      /*
       * A, B skip; A again is a repeat and plays its 4 s (ending the pass); B, A skip; B plays 4 s...
       * so about one full item per 4 s and two skips around each. Without the guard this is
       * hundreds of renders: the two bundles hand the screen back and forth as fast as they load.
       */
      assert.ok(renders <= 12, `${renders} renders in ${Date.now() - t0} ms — the playlist is spinning`);
      assert.ok(skips >= 2 && skips <= 10, `${skips} honoured skips`);
      assert.ok(p.logs.some((l) => /skip ignored for ".*": it already skipped this pass/.test(l)), 'a repeat was refused');
      // Something is on screen: a bundle that plays out its duration, not a black stage.
      assert.ok(await player(p, '!!document.querySelector("#playerContainer iframe")'), 'a bundle is showing');

      // Proof of play: every bundle row left behind is a full run, never a retracted skip.
      await sleep(1500);
      const rows = [...playRows(d.id, a.id), ...playRows(d.id, b.id)].filter((r) => r.ended_at != null);
      assert.ok(rows.length >= 1, 'the full runs are recorded: ' + JSON.stringify([...playRows(d.id, a.id), ...playRows(d.id, b.id)]));
      for (const r of rows) assert.ok(r.duration_sec >= 3, `a ${r.duration_sec}s row — a skip was counted as a play`);
      assert.deepEqual(p.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });

  test('a one-item playlist cannot skip: it keeps showing the bundle without reloading it', async () => {
    const d = await srv.webPlayerDisplay('Alone');
    const a = await bundle('alone', SKIP_ALWAYS);
    await playlistOn(d, [{ content_id: a.id, duration_sec: 30 }]);
    const { ctx, page: p } = await open(d);
    try {
      assert.ok(await waitFor(() => player(p, 'playlist.length === 1 && !!document.querySelector("#playerContainer iframe")'), 30000));
      const from = playingLogs(p).length;
      await sleep(5000);
      assert.equal(playingLogs(p).length - from, 0, 'never re-rendered');
      assert.equal(skippedLogs(p).length, 0);
      assert.equal(p.logs.filter((l) => /skip ignored .*nothing else to play/.test(l)).length, 1, 'said why, once');
      assert.ok(await waitFor(() => playRows(d.id, a.id).length === 1, 5000), 'and it is a play');
    } finally { await ctx.close(); }
  });

  test('in a layout, a skip moves only its own zone', async () => {
    const d = await srv.webPlayerDisplay('Zones');
    const L = await srv.api('POST', '/layouts', { name: 'Two zones', zones: [
      { name: 'Left', x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
      { name: 'Right', x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 }] });
    const zid = (n) => L.zones.find((z) => z.name === n).id;
    const b = await bundle('zone-skip', SKIP_NOW);
    const [l2, r1, r2] = [await image('l2'), await image('r1'), await image('r2')];
    await playlistOn(d, [
      { content_id: b.id, zone_id: zid('Left'), duration_sec: 60 },
      { content_id: l2.id, zone_id: zid('Left'), duration_sec: 60 },
      { content_id: r1.id, zone_id: zid('Right'), duration_sec: 60 },
      { content_id: r2.id, zone_id: zid('Right'), duration_sec: 60 },
    ], () => srv.api('PUT', `/devices/${d.id}`, { layout_id: L.id }));
    const { ctx, page: p } = await open(d);
    try {
      const zones = () => player(p, `[...document.querySelectorAll('#playerContainer > .zone')].map((z) => ({
        img: (z.querySelector('img') || {}).src || null, frame: !!z.querySelector('iframe') }))`);
      assert.ok(await waitFor(() => player(p, 'layout && layout.zones && layout.zones.length === 2 && document.querySelectorAll("#playerContainer > .zone").length === 2'), 30000), 'the layout is drawn');
      const moved = await waitFor(async () => {
        const z = await zones();
        return z && z.some((x) => x.img && x.img.includes(l2.filepath)) ? z : null;
      }, 10000);
      assert.ok(moved, `the left zone moved on to its next item: ${JSON.stringify(await zones())}`);
      assert.ok(moved.some((x) => x.img && x.img.includes(r1.filepath)), 'the right zone is still on its FIRST item');
      assert.ok(!moved.some((x) => x.frame), 'the skipped bundle is gone');
      assert.equal(skippedLogs(p).length, 1);
      assert.match(skippedLogs(p)[0], /in zone "Left" — offline now$/);
      assert.deepEqual(p.errors, [], 'the player threw');
    } finally { await ctx.close(); }
  });
});
