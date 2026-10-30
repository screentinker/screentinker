'use strict';

/*
 * A 12-hour clock in a 24-hour locale (lib/hour-cycle.js). hour12: true resolves to hourCycle 'h11'
 * in en-GB, de, ja…, which counts 0-11: 12:38 PM showed as "00:38:22 pm" on a Raspberry Pi left on
 * the installer's en-GB locale (2026-10-30). Covers the helper, and that the clock widget, the
 * rendered slide and the slide editor's preview all use it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fixHourCycle, FIX_HOUR_CYCLE_JS } = require('../lib/hour-cycle');

const NOON = new Date('2026-10-30T12:38:22Z');
const MIDNIGHT = new Date('2026-10-30T00:05:00Z');
const twelve = () => ({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'UTC' });
const fmt = (d, loc, o) => d.toLocaleTimeString(loc, o).replace(/ /g, ' ');

test('THE BUG: en-GB 12-hour at 12:38 is 12:38, not 00:38', () => {
  const raw = new Intl.DateTimeFormat('en-GB', twelve()).resolvedOptions().hourCycle;
  if (raw === 'h11') assert.match(fmt(NOON, 'en-GB', twelve()), /^00:38/, 'this engine shows the bug without the fix');
  assert.match(fmt(NOON, 'en-GB', fixHourCycle('en-GB', twelve())), /^12:38:22/);
  assert.match(fmt(MIDNIGHT, 'en-GB', fixHourCycle('en-GB', twelve())), /^12:05:00/);
});

test('every locale: 12-hour runs 1-12, 24-hour runs 0-23', () => {
  for (const loc of ['en-GB', 'en-US', 'de-DE', 'fr-FR', 'ja-JP', 'da-DK', 'hi-IN', undefined]) {
    const o12 = fixHourCycle(loc, twelve());
    assert.ok(['h12', undefined].includes(o12.hourCycle) || o12.hour12 === true, String(loc));
    assert.equal(new Intl.DateTimeFormat(loc, o12).resolvedOptions().hourCycle, 'h12', `${loc} 12-hour`);
    const o24 = fixHourCycle(loc, { ...twelve(), hour12: false });
    assert.equal(new Intl.DateTimeFormat(loc, o24).resolvedOptions().hourCycle, 'h23', `${loc} 24-hour`);
  }
});

test('options without hour12 are left alone, and the input keeps working on an old engine', () => {
  const o = { hour: '2-digit' };
  assert.deepEqual(fixHourCycle('en-GB', o), { hour: '2-digit' });
  // An engine with no resolvedOptions().hourCycle (Chrome < 73) keeps hour12 as given.
  const ctx = { Intl: { DateTimeFormat: function () { return { resolvedOptions: () => ({}) }; } } };
  vm.createContext(ctx);
  vm.runInContext(FIX_HOUR_CYCLE_JS, ctx);
  assert.deepEqual(ctx.fixHourCycle('en-GB', { hour12: true }), { hour12: true });
});

test('the inlined source is ES5 an old player can run', () => {
  assert.doesNotMatch(FIX_HOUR_CYCLE_JS, /\b(const|let)\b|=>|`/);
});

test('the clock widget page inlines and uses it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'widgets.js'), 'utf8');
  assert.match(src, /\$\{FIX_HOUR_CYCLE_JS\}/);
  assert.match(src, /const opts = fixHourCycle\(\$\{safeLocale\(c\.locale\)\}, \{ hour12:/);
});

test('a rendered slide inlines and uses it for live clocks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'slide-render.js'), 'utf8');
  assert.match(src, /const LIVE_SCRIPT = `<script>\n\$\{FIX_HOUR_CYCLE_JS\}/);
  assert.match(src, /if \(kind === 'clock'\) o = fixHourCycle\(loc, o\);/);
});

test('the slide editor preview has the same rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'slides.js'), 'utf8');
  const fn = src.slice(src.indexOf('function fixHourCycle'), src.indexOf('function paintLive'));
  const ctx = { Intl };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  assert.match(fmt(NOON, 'en-GB', ctx.fixHourCycle('en-GB', twelve())), /^12:38:22/);
  assert.match(src, /if \(e\.kind === 'clock'\) fixHourCycle\(loc, o\);/);
});

test('a renderer fix reaches screens that cached the old page: the render epoch is in every rev', () => {
  const epoch = require('../lib/widget-render-epoch');
  assert.ok(Number.isInteger(epoch) && epoch >= 1, 'bumped for this fix');
  const src = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
  assert.match(src, /let rev = Number\(facts\.rev \?\? a\.widget_rev \?\? 0\) \+ require\('\.\.\/lib\/widget-render-epoch'\);/);
});
