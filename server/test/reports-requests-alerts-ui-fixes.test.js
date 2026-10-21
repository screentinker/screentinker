'use strict';

/*
 * Reports, Content requests and Alerts fixes found while filming the user guides. These are page
 * changes that need a browser to exercise for real, so they are guarded at the source; the alert
 * window change has a real tick test in alert-channels.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');
const reportsSrc = read('views', 'reports.js');
const requestsSrc = read('views', 'requests.js');
const { parseRangeParam } = require('../routes/reports');

test('Export CSV is fetched with the Bearer header, never opened with the token in the URL', () => {
  assert.doesNotMatch(reportsSrc, /token=\$\{/, 'no ?token= URL: the API never read it, and it leaks into logs');
  assert.doesNotMatch(reportsSrc, /window\.open\(`\/api\/reports\/export/);
  assert.match(reportsSrc, /downloadCsv\(`\/api\/reports\/export\?/);
  assert.match(reportsSrc, /async function downloadCsv[\s\S]{0,200}Authorization: `Bearer \$\{localStorage\.getItem\('token'\)\}`/);
});

test('report dates: local calendar days in the inputs, a YYYY-MM-DD bar label read as a date not an instant', () => {
  assert.doesNotMatch(reportsSrc, /toISOString\(\)\.split\('T'\)/, 'toISOString() is the UTC day');
  assert.match(reportsSrc, /value="\$\{localDay\(thirtyDaysAgo\)\}"/);
  assert.match(reportsSrc, /value="\$\{localDay\(today\)\}"/);
  assert.doesNotMatch(reportsSrc, /new Date\(d\.day\)/, 'new Date("YYYY-MM-DD") is UTC midnight, a day early west of UTC');
  assert.match(reportsSrc, /dailyChart[\s\S]{0,200}new Date\(d\.day \+ 'T00:00:00Z'\)[^\n]*timeZone: 'UTC'/);
});

test('the range the dashboard now sends (local day bounds as ISO) is accepted as given by the server', () => {
  // Chicago, 21 Oct: the whole local day, as rangeQuery builds it.
  const start = parseRangeParam('2026-10-21T05:00:00.000Z');
  const end = parseRangeParam('2026-10-22T04:59:59.999Z', { endOfDay: true });
  assert.equal(start.ok && end.ok, true);
  assert.equal(end.epoch - start.epoch, 86399, 'one whole day, the end not extended to another 23:59:59');
});

test('"Screen uptime by client" has no hard-coded English left', () => {
  const section = reportsSrc.slice(reportsSrc.indexOf('export async function renderUptimeReport'));
  for (const s of ['Screen uptime by client', '>Last ', 'Download CSV', 'Building report', 'Could not load',
    "'Nothing to report.'", '>Uptime<', '>Coverage<', '>Incidents<', 'still down', 'No incidents in this period',
    'The CSV contains every one', 'Could not export']) {
    assert.ok(!section.includes(s), `still hard-coded: ${s}`);
  }
});

test('bar value labels that do not fit their bar are hidden instead of overlapping', () => {
  assert.match(reportsSrc, /function renderBarChart[\s\S]*offsetWidth > c\.clientWidth[\s\S]*visibility = 'hidden'/);
});

test('request place picker: a group with no playlist is disabled with the reason; dates are localised', () => {
  assert.match(requestsSrc, /kind === 'group' && !r\.playlist_id/);
  assert.match(requestsSrc, /off && !sel \? 'disabled' : ''/);
  assert.match(requestsSrc, /t\('creq\.form\.target_no_playlist', \{ name: r\.name \}\)/);
  assert.doesNotMatch(requestsSrc, /esc\(r\.start_date\)/);
  assert.equal(requestsSrc.split('${esc(day(r.start_date))} → ${esc(day(r.end_date))}').length - 1, 2, 'list row and detail');
});

test('new strings exist in every locale with the same placeholders, and alerts.intro mentions problems', async () => {
  const dir = path.join(FRONTEND, 'i18n');
  const keys = ['alerts.intro', 'report.export_failed', 'report.uptime.title', 'report.uptime.last_days',
    'report.uptime.truncated', 'report.uptime.load_failed', 'creq.form.target_no_playlist'];
  const en = (await import(pathToFileURL(path.join(dir, 'en.js')).href)).default;
  assert.match(en['alerts.intro'], /problem/);
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const f of fs.readdirSync(dir).filter((x) => /^[a-z]{2}\.js$/.test(x))) {
    const loc = (await import(pathToFileURL(path.join(dir, f)).href)).default;
    for (const k of keys) {
      assert.equal(typeof loc[k], 'string', `${f} ${k}`);
      assert.equal(ph(loc[k]), ph(en[k]), `${f} ${k} placeholders`);
    }
  }
});
