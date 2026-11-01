'use strict';

/*
 * In a real Chromium, at the size of the zones on the frame that prompted this (1280x800, a
 * "kitchen" layout with a 24% x 17% clock strip and a 24% x 83% weather column):
 *   - a 64px 12-hour clock with seconds stays on ONE line and inside its zone (it wrapped "AM" onto
 *     a second line the zone cut off);
 *   - a 9:16 slide with "Fill the zone" covers its whole zone (it was letterboxed with a black band).
 * A stub DOM cannot measure text, which is the whole question for the clock.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, launch } = require('./helpers/web-player-e2e');
const { renderWidgetHtml } = require('../routes/widgets');
const slideRender = require('../lib/slide-render');

let browser;
before(async () => { if (!SKIP) browser = await launch(); });
after(async () => { if (browser) await browser.close(); });

async function measureClock(page) {
  return page.evaluate(() => {
    const t = document.getElementById('time');
    const r = t.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(t).lineHeight) || parseFloat(getComputedStyle(t).fontSize) * 1.2;
    return { text: t.textContent, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      lines: Math.round(r.height / lh), fontSize: parseFloat(getComputedStyle(t).fontSize),
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight };
  });
}

test('a 64px 12-hour clock with seconds fits a 307x134 zone on one line', { skip: SKIP }, async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 307, height: 134 });
  // The frame's widget, as configured.
  await page.setContent(renderWidgetHtml('clock', { format: '12h', timezone: 'America/Chicago', font_size: 64, show_seconds: true, show_date: false, color: '#ffffff', background: '#000000', locale: '' }));
  await page.waitForFunction(() => document.getElementById('time').textContent.length > 0);
  const m = await measureClock(page);
  assert.equal(m.lines, 1, `one line, got ${JSON.stringify(m)}`);
  assert.ok(m.left >= 0 && m.right <= m.vw + 0.5, `inside the zone horizontally: ${JSON.stringify(m)}`);
  assert.ok(m.top >= 0 && m.bottom <= m.vh + 0.5, `inside the zone vertically: ${JSON.stringify(m)}`);
  assert.ok(m.fontSize < 64, 'it had to shrink');
  await page.close();
});

test('a clock with room keeps the size it was given, and the date shrinks with it in a small zone', { skip: SKIP }, async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 400 });
  await page.setContent(renderWidgetHtml('clock', { format: '12h', font_size: 64, show_seconds: true, show_date: true, timezone: 'UTC' }));
  await page.waitForFunction(() => document.getElementById('time').textContent.length > 0);
  assert.equal((await measureClock(page)).fontSize, 64, 'never grown or shrunk when it fits');

  await page.setViewport({ width: 200, height: 120 });
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.getElementById('time')).fontSize) < 64);
  const fit = await page.evaluate(() => ({
    sw: document.body.scrollWidth, sh: document.body.scrollHeight,
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
  }));
  assert.ok(fit.sw <= fit.vw && fit.sh <= fit.vh, `time + date fit after a resize: ${JSON.stringify(fit)}`);
  await page.close();
});

test('a 9:16 slide with Fill the zone covers a 307x667 zone; without it, it is letterboxed', { skip: SKIP }, async () => {
  const deck = (opts) => slideRender.renderSlideHtml({
    template: { aspect: '9:16', background: '#0b1d2e', elements: [{ kind: 'headline', slot: 'h', box: { x: 5, y: 5, w: 90, h: 10 }, style: { size_cqw: 9 } }] },
    fields: { h: 'Local weather' },
  }, opts);
  const page = await browser.newPage();
  await page.setViewport({ width: 307, height: 667 });
  const stageBox = () => page.evaluate(() => { const r = document.querySelector('.stage').getBoundingClientRect(); return { top: r.top, h: r.height, w: r.width }; });

  await page.setContent(deck());
  const lb = await stageBox();
  assert.ok(lb.h < 600 && lb.top > 0, `letterboxed by default: ${JSON.stringify(lb)}`);

  await page.setContent(deck({ fill: true }));
  const filled = await stageBox();
  assert.deepEqual({ top: filled.top, h: filled.h, w: filled.w }, { top: 0, h: 667, w: 307 }, 'fills the zone');
  const fits = await page.evaluate(() => { const e = document.querySelector('.stage .e'); return e.scrollWidth <= e.clientWidth + 1; });
  assert.ok(fits, 'the headline still fits its box');
  await page.close();
});
