'use strict';

/*
 * The past-date detector (lib/freshness-dates.js): a table of things it MUST flag and things it
 * must NOT. The second table is the one that matters more — a false "mentions a past date" on a
 * sign that is fine teaches the operator to ignore the chip.
 *
 * Fixed clock: "now" is 14 October 2026, and the item was last changed on 20 September 2026 (the
 * anchor a yearless date is read against).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pastDateIn, pastDateInParts, outOfSeason, easter, isPast } = require('../lib/freshness-dates');

const NOW = Date.UTC(2026, 9, 14, 12) / 1000;
const ANCHOR = Date.UTC(2026, 8, 20) / 1000;
const at = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h) / 1000;

const TRUE_POSITIVES = [
  // [text, source, expected date]
  ['Christmas 2025 menu', 'text', '2025-12-26'],
  ['christmas_2025_menu.png', 'name', '2025-12-26'],
  ['christmas-2025-menu.png', 'name', '2025-12-26'],          // dashes are word separators too
  ['Christmas 2025 lunch menu.png', 'name', '2025-12-26'],
  ['christmas.2025.menu.png', 'name', '2025-12-26'],          // and dots, bar the extension
  ['x-mas-2024-hours.jpg', 'name', '2024-12-26'],
  ['summer_2025_collection.mp4', 'name', '2026-02-28'],
  ['menu-october-2025.png', 'name', '2025-10-31'],
  ['black-friday-2025-deals.png', 'name', '2025-12-03'],
  ['XMAS 2024 opening hours', 'text', '2024-12-26'],
  ['Sale ends Oct 3', 'text', '2026-10-03'],
  ['Join us 3rd Oct', 'text', '2026-10-03'],
  ['Friday 12th December 2025', 'text', '2025-12-12'],
  ['October 2025 specials', 'text', '2025-10-31'],
  ['Event on 2025-10-03', 'text', '2025-10-03'],
  ['03/10/2025', 'text', '2025-10-03'],             // ambiguous, but both readings have passed
  ['Easter 2026 hours', 'text', '2026-04-06'],
  ['Summer 2025 collection', 'text', '2026-02-28'], // over in both hemispheres
  ['Monday 5th', 'text', '2026-10-05'],             // Oct 5 2026 is the only nearby Monday the 5th
  ['Halloween 2025 party.jpg', 'name', '2025-11-01'],
  ['Black Friday 2025', 'text', '2025-12-03'],
  ['Sept 30th, 2026 deadline', 'text', '2026-09-30'],
];

const TRUE_NEGATIVES = [
  // [text, source, why]
  ['Open 24/7', 'text', 'no month name and no year'],
  ['Add 3/4 cup of milk', 'text', 'a fraction'],
  ['Mon-Fri 9-5', 'text', 'opening hours'],
  ['IMG_20230512_123456.jpg', 'name', 'camera timestamp in a file name'],
  ['Screenshot 2025-03-04 at 10.22.33.png', 'name', 'numeric dates in file names are ignored'],
  ['promo-v2-2025-03.png', 'name', 'a version-like number in a file name'],
  ['banner-1920x1080.png', 'name', 'dimensions'],
  ['slide-2025-001.png', 'name', 'a counter'],
  ['christmas-2026-menu.png', 'name', 'still to come'],
  ['sale-oct-3-20.png', 'name', 'a dashed range keeps its end'],
  ['logo-2024.png', 'name', 'a bare year'],
  ['est. 2019', 'text', 'a bare year'],
  ['© 2024 Acme', 'text', 'a bare year'],
  ['You may come in', 'text', '"may" with no day or year'],
  ['Christmas 2026', 'text', 'still to come'],
  ['Oct 3-20', 'text', 'a range whose end has not passed'],
  ['Was Oct 3 - now through Dec 1', 'text', 'the latest date decides'],
  ['10/11/2026', 'text', 'one reading (10 Nov) is still ahead'],
  ['Dec 31', 'text', 'this coming December'],
  ['Friday 12th', 'text', 'no Friday the 12th near the last change — too much of a guess'],
  ['Oct 13', 'text', 'yesterday is within the grace window for the latest time zone'],
  ['Room 12th floor', 'text', 'an ordinal that is not a date'],
  ['build v1.2.10.2025', 'text', 'part of a version string'],
  ['https://example.com/2025/10/03/news', 'text', 'URL paths are not dates'],
];

for (const [text, source, date] of TRUE_POSITIVES) {
  test(`flags: ${JSON.stringify(text)} -> ${date}`, () => {
    const r = pastDateIn(text, { now: NOW, anchor: ANCHOR, source });
    assert.ok(r, `expected ${JSON.stringify(text)} to be flagged`);
    assert.equal(r.date, date);
    assert.ok(r.explain && r.explain.includes(r.match), 'the explanation quotes what it read');
  });
}

for (const [text, source, why] of TRUE_NEGATIVES) {
  test(`does not flag: ${JSON.stringify(text)} (${why})`, () => {
    assert.equal(pastDateIn(text, { now: NOW, anchor: ANCHOR, source }), null);
  });
}

test('a yearless date is read against the last change, and the explanation says which year it chose', () => {
  // Uploaded 25 Oct 2025: the first Oct 3 on or after (anchor - 14 days) is 3 Oct 2026, which has
  // passed by 14 Oct 2026.
  const r = pastDateIn('Sale ends Oct 3', { now: NOW, anchor: at(2025, 10, 25), source: 'text' });
  assert.equal(r.date, '2026-10-03');
  assert.match(r.explain, /last changed on 2025-10-25/);
  assert.match(r.explain, /3 October 2026/);
  // Uploaded the day before: still "this October 3rd".
  assert.equal(pastDateIn('Sale ends Oct 3', { now: at(2026, 10, 2), anchor: at(2026, 10, 1), source: 'text' }), null);
});

test('several texts of one item: the latest date across all of them decides', () => {
  const parts = [{ text: 'Autumn menu', source: 'name' }, { text: 'Tasting night Oct 3', source: 'text' }, { text: 'Next one: Dec 5', source: 'text' }];
  assert.equal(pastDateInParts(parts, { now: NOW, anchor: ANCHOR }), null);
  assert.ok(pastDateInParts(parts.slice(0, 2), { now: NOW, anchor: ANCHOR }));
});

test('grace: a date is past only once the whole day is over in UTC+14', () => {
  assert.equal(isPast([2026, 10, 13], at(2026, 10, 14, 12)), false);
  assert.equal(isPast([2026, 10, 13], at(2026, 10, 15, 0)), true);
});

test('Easter: the computus agrees with known dates', () => {
  assert.deepEqual(easter(2024), [2024, 3, 31]);
  assert.deepEqual(easter(2025), [2025, 4, 20]);
  assert.deepEqual(easter(2026), [2026, 4, 5]);
});

test('out of season: leftovers only, never somebody planning ahead', () => {
  const feb = at(2027, 2, 20);
  assert.match(outOfSeason('Christmas menu', { now: feb }).explain, /Christmas/);
  assert.equal(outOfSeason('Christmas menu', { now: at(2026, 9, 1) }), null, 'within 60 days of the season: planning ahead');
  assert.equal(outOfSeason('Christmas menu', { now: at(2026, 12, 20) }), null, 'in season');
  assert.equal(outOfSeason('Halloween party', { now: NOW }), null, 'in season');
  assert.ok(outOfSeason('Halloween party', { now: at(2027, 1, 10) }));
  assert.equal(outOfSeason('Christmas 2026 preorders', { now: feb }), null, 'a dated mention is the past-date check\'s to judge');
  assert.equal(outOfSeason('Easterbrook Road', { now: feb }), null, 'word boundary');
});
