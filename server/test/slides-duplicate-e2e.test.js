'use strict';

/*
 * Slides editor: "Duplicate slide" from the filmstrip, in a real headless Chrome against a real
 * server (#832).
 *
 * What matters is not that a second thumbnail appears but what the copy IS: a new slide, right after
 * its original, that has never been published. Duplicating and saving must not change what a screen
 * plays, and the next publish must give the copy its own widget while the original keeps its own.
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, like the other browser suites.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let srv, browser, page;
const errors = [];

before(async () => {
  if (SKIP) return;
  srv = await startServer('slides-duplicate');
  browser = await launch();
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1200 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => {
    localStorage.setItem('token', tok);
    localStorage.setItem('rd_onboarded', '1');
  }, srv.token);
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

const slideOf = (name, words, bg) => ({
  name, dwell_sec: 13,
  template: { background: bg, elements: [
    { id: 'el_head', slot: 'head', kind: 'head', box: { x: 8, y: 20, w: 60 },
      style: { color: '#ffcc00', size_cqw: 6, weight: 700 }, motion: { animation: 'fade', delay: 0.3, duration: 0.8 } },
    { slot: 'card', kind: 'box', box: { x: 50, y: 50, w: 30, h: 30 }, style: { color: '#3366ff' },
      motion: { animation: 'none', delay: 0, duration: 0.6 } },
  ] },
  fields: { head: words },
});

const itemWidgets = async (playlistId) => {
  const pl = await srv.api('GET', `/playlists/${playlistId}`);
  return (pl.items || []).map((i) => i.widget_id);
};

describe('Slides editor: duplicate slide', { skip: SKIP }, () => {
  test('a duplicated slide is a new, unpublished copy after its original, and screens see it only after Publish', async () => {
    const created = await srv.api('POST', '/slide-decks', { name: 'Dup deck', doc: { aspect: '16:9', slides: [
      slideOf('Welcome', 'Hello lobby', '#203040'), slideOf('Second', 'Other words', '#402030')] } });
    const pub1 = await srv.api('POST', `/slide-decks/${created.id}/publish`, {});
    const playlistId = pub1.published.playlist_id;
    const published = await srv.api('GET', `/slide-decks/${created.id}`);
    const [orig, second] = published.doc.slides;
    assert.ok(orig.widget_id && second.widget_id, 'setup: the deck is published');
    const liveBefore = await itemWidgets(playlistId);
    assert.deepEqual(liveBefore, [orig.widget_id, second.widget_id]);

    await page.goto(`${srv.base}/app#/slides`, { waitUntil: 'networkidle2' });
    await page.reload({ waitUntil: 'networkidle2' });
    assert.ok(await waitFor(() => page.evaluate((id) => {
      const b = [...document.querySelectorAll('[data-open]')].find((x) => x.dataset.open === id);
      if (b) { b.click(); return true; }
      return false;
    }, created.id), 15000, 150), 'the deck opened');
    assert.ok(await waitFor(() => page.evaluate(() => document.querySelectorAll('#strip [data-slide]').length === 2), 15000, 150));

    // Right-click the first thumbnail, choose Duplicate slide.
    const thumb = await page.$('#strip [data-slide="0"]');
    const r = await thumb.boundingBox();
    await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2, { button: 'right' });
    assert.ok(await waitFor(() => page.evaluate(() => !!document.querySelector('.sl-ctx [data-slide-act="duplicate"]')), 3000, 50),
      'the filmstrip menu offers Duplicate slide');
    await page.click('.sl-ctx [data-slide-act="duplicate"]');
    assert.ok(await waitFor(() => page.evaluate(() => document.querySelectorAll('#strip [data-slide]').length === 3), 3000, 50),
      'a third thumbnail appeared');
    const names = await page.evaluate(() => [...document.querySelectorAll('#strip [data-slide]')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()));
    assert.match(names[1], /Welcome \(copy\)/, `the copy sits right after its original: ${JSON.stringify(names)}`);
    // The copy is the slide now being edited.
    assert.match(await page.evaluate(() => document.querySelector('#strip [data-slide="1"]').getAttribute('style')), /var\(--primary\)/);

    // Unsaved: nothing reached the server.
    assert.equal((await srv.api('GET', `/slide-decks/${created.id}`)).doc.slides.length, 2);

    await page.click('#saveBtn');
    const saved = await waitFor(async () => {
      const d = await srv.api('GET', `/slide-decks/${created.id}`);
      return d.doc.slides.length === 3 ? d : null;
    }, 10000, 150);
    assert.ok(saved, 'Save stored the copy');
    const [s0, copy, s2] = saved.doc.slides;
    assert.equal(s0.id, orig.id); assert.equal(s0.widget_id, orig.widget_id);
    assert.equal(s2.id, second.id); assert.equal(s2.widget_id, second.widget_id);
    assert.notEqual(copy.id, orig.id, 'the copy has its own slide id');
    assert.equal(copy.widget_id, null, 'the copy is unpublished');
    assert.equal(copy.name, 'Welcome (copy)');
    assert.equal(copy.dwell_sec, orig.dwell_sec);
    assert.deepEqual(copy.fields, orig.fields);
    assert.equal(copy.template.background, orig.template.background);
    const noId = (els) => els.map(({ id, ...rest }) => rest);
    assert.deepEqual(noId(copy.template.elements), noId(orig.template.elements), 'layout, style and motion carried over');
    assert.deepEqual(await itemWidgets(playlistId), liveBefore, 'saving a duplicate changed what screens play');

    // Publishing makes the copy its own widget, between the two it was made among.
    await srv.api('POST', `/slide-decks/${created.id}/publish`, {});
    const after2 = await srv.api('GET', `/slide-decks/${created.id}`);
    const copyWidget = after2.doc.slides[1].widget_id;
    assert.ok(copyWidget && ![orig.widget_id, second.widget_id].includes(copyWidget), 'the copy got a widget of its own');
    assert.deepEqual(await itemWidgets(playlistId), [orig.widget_id, copyWidget, second.widget_id]);
    assert.deepEqual(errors, [], 'no page errors');
  });
});
