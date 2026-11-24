'use strict';

/*
 * The news widget editor's "Your own messages" rows, in a real dashboard: saved messages come back as
 * rows (an expired one marked so), a new row can be added and removed, and Save stores the text with
 * its "show until" as epoch ms. The text goes in through input values, never markup.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let browser, srv;
before(async () => { if (SKIP) return; browser = await launch(); srv = await startServer('ownmsg-editor'); });
after(async () => { if (browser) await browser.close(); if (srv) srv.stop(); });

test('own messages: edit, add, remove and save in the news widget editor', { skip: SKIP }, async () => {
  const later = Date.now() + 24 * 3600 * 1000;
  const w = await srv.api('POST', '/widgets', { widget_type: 'rss', name: 'Lobby notices', config: {
    layout: 'ticker', messages: [{ text: 'Old notice', until: Date.now() - 3600 * 1000 }, { text: '<b>Lift</b> closed', until: later }],
  } });
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); localStorage.setItem('st_ui_mode', 'advanced'); }, srv.token);
    await page.goto(`${srv.base}/app#/widgets`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const edit = `[data-edit-widget="${w.id}"]`;
    assert.ok(await waitFor(() => page.$(edit).then(Boolean), 20000), 'the widget list shows the widget');
    // The list re-renders as it loads, so click from inside the page, retrying until the form is open.
    assert.ok(await waitFor(async () => {
      await page.evaluate((sel) => document.querySelector(sel)?.click(), edit).catch(() => {});
      return page.$$eval('#wOwnMsgs .own-msg-row', (r) => r.length === 2).catch(() => false);
    }, 15000), 'two saved rows');
    const rows = () => page.$$eval('#wOwnMsgs .own-msg-row', (rs) => rs.map((r) => ({
      text: r.querySelector('[data-own-text]').value, until: r.querySelector('[data-own-until]').value,
      expired: r.querySelector('span').textContent, bold: !!r.querySelector('b'),
    })));
    const before = await rows();
    assert.equal(before[0].text, 'Old notice');
    assert.ok(before[0].expired.length > 0, 'the expired one is marked');
    assert.equal(before[1].text, '<b>Lift</b> closed', 'typed text stays text');
    assert.equal(before[1].bold, false);
    assert.equal(before[1].expired, '');

    // Remove the old one, add a new one with an end time.
    await page.click('#wOwnMsgs .own-msg-row:first-child .btn-icon');
    await page.click('#wOwnAdd');
    await page.keyboard.type('Elevator out of service');
    await page.$eval('#wOwnMsgs .own-msg-row:last-child [data-own-until]', (el) => { el.value = '2031-05-06T07:08'; el.dispatchEvent(new Event('change')); });
    await page.click('#wOwnAdd');   // a blank row is dropped on save
    await page.click('#saveWidgetBtn');
    const saved = await waitFor(async () => {
      const cur = await srv.api('GET', '/widgets/' + w.id);
      const m = JSON.parse(cur.config).messages;
      return m.length === 2 && m[1].text === 'Elevator out of service' ? m : null;
    }, 10000);
    assert.ok(saved, 'saved');
    assert.equal(saved[0].text, '<b>Lift</b> closed');
    assert.equal(saved[0].until, Math.floor(later / 60000) * 60000, 'kept to the minute');
    const tz = await page.evaluate(() => new Date('2031-05-06T07:08').getTime());
    assert.equal(saved[1].until, tz, 'the browser\'s local time, as epoch ms');
  } finally { await page.close(); }
});
