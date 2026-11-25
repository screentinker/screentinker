'use strict';

/*
 * The schedule dialog's screen, playlist and content pickers, browsed by group / folder in a real
 * dashboard (components/folder-select.js). What is pinned:
 *
 *   - the screen picker lists groups as folders; a screen in two groups is under both, a screen in
 *     none is under "No group";
 *   - the content picker walks NESTED content folders (a parent shows its subtree), the playlist
 *     picker walks the playlist library's folders (#796);
 *   - search finds folders as well as items;
 *   - what is picked is what is SAVED (the hidden <select> stays the source of truth), and a value
 *     written by code (`select.value = x`, as every open/edit path does) repaints the button — the
 *     next New shows the reset values, not the last schedule's picks;
 *   - leaving the view takes the pickers' document listeners with it: visiting again and again does
 *     not grow the count (each one would pin its lists and detached DOM).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let browser, srv;
before(async () => { if (SKIP) return; browser = await launch(); srv = await startServer('sched-pickers'); });
after(async () => { if (browser) await browser.close(); if (srv) srv.stop(); });

async function uploadPng(name) {
  const f = path.join(os.tmpdir(), name);
  fs.writeFileSync(f, PNG);
  try { return await srv.upload(f, 'image/png'); } finally { fs.unlinkSync(f); }
}

test('schedule dialog: browse screens by group, playlists and content by folder, and save the picks', { skip: SKIP }, async () => {
  // Screens and groups: Lobby-1 in two groups, Lobby-2 in one, Back-office in none.
  const s1 = await srv.webPlayerDisplay('Lobby-1');
  const s2 = await srv.webPlayerDisplay('Lobby-2');
  const s3 = await srv.webPlayerDisplay('Back-office');
  const gFloor = await srv.api('POST', '/groups', { name: 'Ground floor' });
  const gRecep = await srv.api('POST', '/groups', { name: 'Reception' });
  await srv.api('POST', `/groups/${gFloor.id}/devices`, { device_id: s1.id });
  await srv.api('POST', `/groups/${gFloor.id}/devices`, { device_id: s2.id });
  await srv.api('POST', `/groups/${gRecep.id}/devices`, { device_id: s1.id });

  // Content: Campaigns › Winter (nested), plus an unfiled file.
  const fCamp = await srv.api('POST', '/folders', { name: 'Campaigns' });
  const fWinter = await srv.api('POST', '/folders', { name: 'Winter', parent_id: fCamp.id });
  const snow = await uploadPng('snow-banner.png');
  const loose = await uploadPng('loose-file.png');
  await srv.api('PUT', `/content/${snow.id}`, { folder_id: fWinter.id });

  // Playlists: one filed in a library folder, one at the root.
  const plMorning = await srv.api('POST', '/playlists', { name: 'Morning loop' });
  await srv.api('POST', '/playlists', { name: 'Evening loop' });
  const plFolder = await srv.api('POST', '/library-folders/playlist/folders', { name: 'Daypart' });
  await srv.api('POST', '/library-folders/playlist/move', { ids: [plMorning.id], folder_id: (plFolder.folder || plFolder).id });

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000 });
    // Count the live `mousedown` listeners on document (added minus removed).
    await page.evaluateOnNewDocument(() => {
      window.__docDown = 0;
      const add = Document.prototype.addEventListener;
      const rem = Document.prototype.removeEventListener;
      Document.prototype.addEventListener = function (type, ...rest) { if (this === document && type === 'mousedown') window.__docDown += 1; return add.call(this, type, ...rest); };
      Document.prototype.removeEventListener = function (type, ...rest) { if (this === document && type === 'mousedown') window.__docDown -= 1; return rem.call(this, type, ...rest); };
    });
    await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); localStorage.setItem('st_ui_mode', 'advanced'); }, srv.token);
    await page.goto(`${srv.base}/app#/schedule`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await waitFor(() => page.$('#addScheduleBtn').then(Boolean), 20000), 'schedule page loaded');
    await page.evaluate(() => document.getElementById('addScheduleBtn').click());
    assert.ok(await waitFor(() => page.$eval('#scheduleModal', (m) => m.style.display === 'flex').catch(() => false), 10000), 'dialog open');

    // The plain selects are hidden; a browsable field stands in for each.
    const fields = await page.$$eval('#scheduleModal .fsel', (els) => els.length);
    assert.equal(fields, 3, 'screen, playlist and content are browsable');
    assert.equal(await page.$eval('#schedDeviceSelect', (s) => s.hidden), true);

    const fieldOf = (selectId) => `#${selectId} + .fsel`;
    const openField = (selectId) => page.$eval(`${fieldOf(selectId)} .fsel-trigger`, (b) => b.click());
    const chips = (selectId) => page.$$eval(`${fieldOf(selectId)} .fsel-chip`, (cs) => cs.map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
    const rows = (selectId) => page.$$eval(`${fieldOf(selectId)} .fsel-row .fsel-label`, (rs) => rs.map((r) => r.textContent));
    const clickChip = (selectId, label) => page.$$eval(`${fieldOf(selectId)} .fsel-chip`, (cs, l) => {
      const c = cs.find((x) => x.textContent.trim().startsWith(l)); if (!c) throw new Error('no chip ' + l); c.click();
    }, label);
    const clickRow = (selectId, label) => page.$$eval(`${fieldOf(selectId)} .fsel-row`, (rs, l) => {
      const r = rs.find((x) => x.querySelector('.fsel-label').textContent === l); if (!r) throw new Error('no row ' + l); r.click();
    }, label);

    // --- screens by group
    await openField('schedDeviceSelect');
    const devChips = await chips('schedDeviceSelect');
    assert.ok(devChips.some((c) => /^All screens 3$/.test(c)), `All screens (3): ${devChips}`);
    assert.ok(devChips.some((c) => /^Ground floor 2$/.test(c)));
    assert.ok(devChips.some((c) => /^Reception 1$/.test(c)));
    assert.ok(devChips.some((c) => /^No group 1$/.test(c)));
    await clickChip('schedDeviceSelect', 'Reception');
    assert.deepEqual(await rows('schedDeviceSelect'), ['Lobby-1'], 'a screen in two groups is under each');
    await clickChip('schedDeviceSelect', 'All screens');
    await clickChip('schedDeviceSelect', 'No group');
    assert.deepEqual(await rows('schedDeviceSelect'), ['Back-office']);
    await clickChip('schedDeviceSelect', 'All screens');
    await clickChip('schedDeviceSelect', 'Ground floor');
    assert.deepEqual(await rows('schedDeviceSelect'), ['Lobby-1', 'Lobby-2']);
    await clickRow('schedDeviceSelect', 'Lobby-2');
    assert.equal(await page.$eval('#schedDeviceSelect', (s) => s.value), s2.id, 'the pick lands in the select');
    assert.match(await page.$eval(`${fieldOf('schedDeviceSelect')} .fsel-trigger`, (b) => b.textContent), /Lobby-2.*Ground floor/);

    // --- playlists by library folder
    await openField('schedPlaylist');
    assert.ok((await chips('schedPlaylist')).some((c) => /^Daypart 1$/.test(c)));
    await clickChip('schedPlaylist', 'Daypart');
    assert.deepEqual(await rows('schedPlaylist'), ['Morning loop (draft)'], 'labelled as the old dropdown labelled it');
    await clickRow('schedPlaylist', 'Morning loop (draft)');

    // --- content: nested folders, and search that finds a folder
    await openField('schedContent');
    await clickChip('schedContent', 'Campaigns');
    assert.deepEqual(await rows('schedContent'), ['snow-banner.png'], 'a parent folder shows its subtree');
    assert.ok((await chips('schedContent')).some((c) => /^Winter 1$/.test(c)), 'the nested folder is offered inside its parent');
    await clickChip('schedContent', 'All content');
    await page.type(`${fieldOf('schedContent')} .fsel-search`, 'wint');
    assert.ok((await chips('schedContent')).some((c) => /^Campaigns › Winter 1$/.test(c)), 'search finds the folder, with its path');
    await clickChip('schedContent', 'Campaigns › Winter');
    await clickRow('schedContent', 'snow-banner.png');
    assert.equal(await page.$eval('#schedContent', (s) => s.value), snow.id);
    assert.ok(loose.id, 'an unfiled file exists alongside');

    // --- save, and what the server stored is what was picked
    await page.$eval('#schedTitle', (el) => { el.value = 'Folder picker'; });
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/schedules$/.test(r.url()), { timeout: 30000 });
    await page.evaluate(() => document.getElementById('saveScheduleBtn').click());
    const res = await post;
    assert.ok(res.status() < 300, await res.text());
    const saved = await waitFor(async () => {
      const list = await srv.api('GET', '/schedules');
      return (Array.isArray(list) ? list : list.schedules || []).find((s) => s.title === 'Folder picker');
    }, 10000);
    assert.ok(saved, 'schedule saved');
    assert.equal(saved.device_id, s2.id);
    assert.equal(saved.playlist_id, plMorning.id);
    assert.equal(saved.content_id, snow.id);
    assert.ok(!saved.group_id);
    assert.ok(s1.id && s3.id);

    // --- the next New resets through `select.value = …` (no change event): the buttons must follow.
    await waitFor(() => page.$eval('#scheduleModal', (m) => m.style.display !== 'flex').catch(() => false), 10000);
    await page.evaluate(() => document.getElementById('addScheduleBtn').click());
    const shown = await page.evaluate(() => ['schedDeviceSelect', 'schedPlaylist', 'schedContent'].map((id) => {
      const sel = document.getElementById(id);
      return { value: sel.value, text: sel.nextElementSibling.querySelector('.fsel-value').textContent };
    }));
    const firstScreen = await page.$eval('#schedDeviceSelect', (s) => s.options[0].textContent);
    assert.equal(shown[0].text, firstScreen, 'screen button shows the reset (first) screen');
    assert.equal(shown[1].value, '');
    assert.equal(shown[1].text, '— No playlist override —', 'playlist button shows the reset value');
    assert.equal(shown[2].value, '');
    assert.equal(shown[2].text, '— None —', 'content button shows the reset value, not snow-banner.png');

    // --- leaving the view removes the pickers' document listeners; coming back does not add to them.
    const visit = async () => {
      await page.evaluate(() => { location.hash = '#/'; });
      await waitFor(() => page.$('#scheduleModal').then((m) => !m), 20000);
      await page.evaluate(() => { location.hash = '#/schedule'; });
      assert.ok(await waitFor(() => page.$$eval('#scheduleModal .fsel', (els) => els.length === 3), 20000), 'schedule view back');
      return page.evaluate(() => window.__docDown);
    };
    const first = await visit();
    const third = (await visit(), await visit());
    assert.equal(third, first, `document mousedown listeners: ${first} after one return, ${third} after three`);
  } finally {
    await page.close();
  }
});
