'use strict';

/*
 * 2.4.3: three dashboard bugs the 2.4 release-video capture found on a real 2.4.2 instance. Each
 * one rendered without an error, which is why a green suite never noticed.
 *
 *   1. Platform -> System called isPlatformAdmin() with no user, which is always false, so the page
 *      never fetched the updater's status: no "Updater ready" card, no confirm before Update Now,
 *      and no progress view after a reload mid-upgrade.
 *   2. Reports -> Top Content divided by `completed_plays`, a field the summary has not returned
 *      since the hourly rollup (2.3.0): "NaN%" for every customer.
 *   3. Reports -> Interactive sessions put its bar chart in a plain <div>. renderBarChart emits
 *      flex COLUMNS, so without a flex-row container the bars stacked down the page.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = path.join(__dirname, '..', '..', 'frontend', 'js', 'views');
const read = (f) => fs.readFileSync(path.join(FE, f), 'utf8');

test('1: no view asks isPlatformAdmin() without saying who', () => {
  for (const f of fs.readdirSync(FE).filter((x) => x.endsWith('.js'))) {
    assert.doesNotMatch(read(f), /isPlatformAdmin\(\s*\)/, `${f} calls isPlatformAdmin() with no user (always false)`);
  }
});

test('2: Top Content reads only fields the play report actually returns', () => {
  const src = read('reports.js');
  const start = src.indexOf('summary.by_content.map(');
  assert.ok(start > 0, 'the Top Content table is where this test expects it');
  const body = src.slice(start, src.indexOf('.join(', start));
  const used = new Set([...body.matchAll(/\bc\.(\w+)/g)].map((m) => m[1]));
  // What lib/play-report.js puts in each by_content row.
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'play-report.js'), 'utf8');
  const row = lib.match(/byContent\.get\(r\.content_id\) \|\| \{([^}]*)\}/);
  assert.ok(row, 'the by_content row literal is where this test expects it');
  const returned = new Set([...row[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
  for (const f of used) assert.ok(returned.has(f), `Top Content reads c.${f}, which the report never returns`);
});

test('3: every bar chart container is a flex row, as renderBarChart needs', () => {
  const src = read('reports.js');
  const ids = [...src.matchAll(/renderBarChart\('(\w+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 3, 'daily, hourly and kiosk charts');
  for (const id of new Set(ids)) {
    const el = src.match(new RegExp(`id="${id}"[^>]*style="([^"]*)"`));
    assert.ok(el, `#${id} has a style`);
    assert.match(el[1], /display:\s*flex/, `#${id} is not a flex row, so its bars stack vertically`);
  }
});
