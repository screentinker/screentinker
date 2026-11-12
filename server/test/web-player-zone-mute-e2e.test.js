'use strict';

/*
 * Web player: mute in a layout, END TO END in headless Chrome against a real server.
 *
 * Two bugs, both in the player's live mute path (server/player/index.html):
 *   1. an item muted in a layout zone kept playing with sound, live and after a reload, because a
 *      zone's media took its mute from the zone order only and never read the item's flag;
 *   2. muting the FIRST playlist item (here a picture in the side zone) silenced the music zone,
 *      because the live toggle set one page-wide override checked against playlist[currentIndex],
 *      which in layout mode is just the first item.
 *
 * Skips cleanly without Chrome / puppeteer-core.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SKIP, waitFor, startServer, launch, playerPage, player } = require('./helpers/web-player-e2e');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-zone-mute-'));
// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A short mono 16-bit WAV of a quiet tone, made here so the test needs no ffmpeg. */
function wav(seconds = 20, rate = 8000) {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let srv, browser;
before(async () => {
  if (SKIP) return;
  srv = await startServer('zone-mute');
  browser = await launch(['--autoplay-policy=no-user-gesture-required']);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

async function file(name, buf, mime) {
  const f = path.join(TMP, `${name}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(f, buf);
  return srv.upload(f, mime);
}

describe('web player mute in a layout', { skip: SKIP }, () => {
  test('a zone item follows its own mute, and muting another item leaves the music alone', async () => {
    const L = await srv.api('POST', '/layouts', { name: 'Menu and music', zones: [
      { name: 'Main', x_percent: 0, y_percent: 0, width_percent: 70, height_percent: 100 },
      { name: 'Side', x_percent: 70, y_percent: 0, width_percent: 30, height_percent: 100 },
    ] });
    const zid = (n) => L.zones.find((z) => z.name === n).id;
    const pic = await file('menu.png', PNG, 'image/png');
    const music = await file('music.wav', wav(), 'audio/wav');
    const d = await srv.webPlayerDisplay('Cafe');
    const pl = await srv.api('POST', '/playlists', { name: 'Cafe' });
    // The picture is the FIRST item, so it is what playlist[currentIndex] points at.
    const picItem = await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: pic.id, zone_id: zid('Side'), duration_sec: 60 });
    const musicItem = await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: music.id, zone_id: zid('Main'), duration_sec: 60 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('PUT', `/devices/${d.id}`, { layout_id: L.id });
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });
    const idOf = (x) => x.id || (x.item && x.item.id);
    const mute = (it, on) => srv.api('PUT', `/playlists/${pl.id}/items/${idOf(it)}`, { muted: on });

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}&autoplay_audio=1`, { waitUntil: 'domcontentloaded' });
      const musicMuted = () => player(page, `(() => {
        const v = [...document.querySelectorAll('#playerContainer > .zone video')].find((e) => (e.currentSrc || e.src).includes(${JSON.stringify(music.filepath || music.id)}));
        return v ? v.muted : 'none';
      })()`);
      assert.ok(await waitFor(async () => (await musicMuted()) === false, 30000), `the music zone plays with sound (got ${await musicMuted()})`);

      // Bug 2: muting the first item (the picture) must not touch the music zone.
      await mute(picItem, true);
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await musicMuted(), false, 'muting the picture left the music playing with sound');

      // Bug 1, live: muting the music item silences it, un-muting brings it back.
      await mute(musicItem, true);
      assert.ok(await waitFor(async () => (await musicMuted()) === true, 10000), 'muting the music item silences the zone');
      await mute(musicItem, false);
      assert.ok(await waitFor(async () => (await musicMuted()) === false, 10000), 'un-muting brings its sound back');

      // Bug 1, after a reload: a muted zone item starts muted.
      await mute(musicItem, true);
      assert.ok(await waitFor(async () => (await musicMuted()) === true, 10000));
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.ok(await waitFor(async () => (await musicMuted()) === true, 30000), `still muted after a reload (got ${await musicMuted()})`);
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally { await ctx.close(); }
  });

  test('full screen: a live mute and un-mute still reach the item playing', async () => {
    const music = await file('solo.wav', wav(), 'audio/wav');
    const d = await srv.webPlayerDisplay('Lobby');
    const pl = await srv.api('POST', '/playlists', { name: 'Lobby' });
    const it = await srv.api('POST', `/playlists/${pl.id}/items`, { content_id: music.id, duration_sec: 60 });
    await srv.api('POST', `/playlists/${pl.id}/publish`);
    await srv.api('POST', `/playlists/${pl.id}/assign`, { device_id: d.id });
    const mute = (on) => srv.api('PUT', `/playlists/${pl.id}/items/${it.id || (it.item && it.item.id)}`, { muted: on });

    const ctx = await browser.createBrowserContext();
    try {
      const page = await playerPage(ctx);
      await page.goto(`${srv.base}/player?k=${encodeURIComponent(d.key)}&autoplay_audio=1`, { waitUntil: 'domcontentloaded' });
      const muted = () => player(page, 'currentVideoEl ? currentVideoEl.muted : "none"');
      assert.ok(await waitFor(async () => (await muted()) === false, 30000), `plays with sound (got ${await muted()})`);
      await mute(true);
      assert.ok(await waitFor(async () => (await muted()) === true, 10000), 'a live mute silences it');
      await mute(false);
      assert.ok(await waitFor(async () => (await muted()) === false, 10000), 'a live un-mute brings it back');
      assert.deepEqual(page.errors, [], 'the player never threw');
    } finally { await ctx.close(); }
  });
});
