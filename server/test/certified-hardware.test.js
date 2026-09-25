'use strict';

/* The Certified Hardware list (certified-hardware.json -> frontend/certified-hardware.html).
 *
 * ⚠️ WHY THIS FILE IS STRICTER THAN A NORMAL PAGE TEST. Reseller agreements define "Certified
 * Hardware" as the models published on this page, and support obligations attach to what appears
 * there. So the failure that matters is not a broken layout, it is a device quietly claiming a
 * status it has not earned: a "certified" row with no test date, a limitation with nothing
 * describing it, or a community report that reads as supported. Each of those is asserted below.
 *
 * The other half is freshness. The page is generated and committed, so a forgotten rebuild would
 * publish yesterday's list with today's data sitting in the repo looking correct. --check catches it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'certified-hardware.json');
const PAGE = path.join(ROOT, 'frontend', 'certified-hardware.html');
const BUILDER = path.join(__dirname, '..', 'scripts', 'build-certified-hardware.js');

const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const devices = data.devices;

const STATUSES = ['certified', 'certified-with-limits', 'community-reported', 'known-issues', 'not-supported'];
const CATEGORIES = ['streaming-player', 'soc-display', 'media-player', 'browser', 'sbc'];
const FIELDS = ['id', 'name', 'manufacturer', 'model_numbers', 'category', 'os', 'player', 'status',
  'max_resolution', 'validated_on', 'validated_by', 'player_version', 'min_version',
  'provisioning_url', 'buy_url', 'photo', 'notes', 'eol'];

const CERTIFIED = ['certified', 'certified-with-limits'];

test('the committed page is in sync with the data file', () => {
  // Run the real builder in --check mode rather than re-implementing the comparison, so this
  // cannot drift from what `npm run build:certified-hardware` actually produces.
  execFileSync(process.execPath, [BUILDER, '--check'], { stdio: 'pipe' });
});

test('every device carries every field, so a missing value is a decision and not an omission', () => {
  for (const d of devices) {
    for (const f of FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, f), `${d.id || '(no id)'} is missing "${f}"`);
    }
    assert.equal(Object.keys(d).filter((k) => !FIELDS.includes(k)).length, 0,
      `${d.id} has a field the renderer will silently drop: ${Object.keys(d).filter((k) => !FIELDS.includes(k))}`);
  }
});

test('a photo is a complete, credited, local claim or it is null', () => {
  /*
   * ⚠️ A PHOTO ON THIS PAGE IS A CLAIM, like every other field. It shows the hardware actually running
   * ScreenTinker, published with the owner's permission and credited to them. A stock product shot
   * would quietly turn a compatibility record into an advert, on the page reseller agreements point at
   * — so the credit is mandatory, and the file must be ours rather than hotlinked from a supplier who
   * can change or remove it.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  for (const d of devices) {
    if (d.photo === null) continue;
    assert.equal(typeof d.photo, 'object', `${d.id} photo must be an object or null`);
    for (const k of ['src', 'alt', 'credit']) {
      assert.ok(d.photo[k], `${d.id} photo is missing "${k}" — an uncredited photo is not publishable`);
    }
    assert.ok(d.photo.alt.length > 20, `${d.id} photo needs real alt text, not a label`);
    assert.match(d.photo.src, /^\/assets\//, `${d.id} photo must be served by us, not hotlinked`);
    assert.ok(
      fs.existsSync(path.join(__dirname, '..', '..', 'frontend', d.photo.src.replace(/^\//, ''))),
      `${d.id} photo ${d.photo.src} is not in frontend/`
    );
  }
});

test('statuses and categories are from the fixed lists the page renders', () => {
  for (const d of devices) {
    assert.ok(STATUSES.includes(d.status), `${d.id} has status "${d.status}"`);
    assert.ok(CATEGORIES.includes(d.category), `${d.id} has category "${d.category}"`);
  }
});

test('ids are unique, url-safe, and every one is a real anchor on the page', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  const seen = new Set();
  for (const d of devices) {
    assert.match(d.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${d.id} is not a url-safe slug`);
    assert.ok(!seen.has(d.id), `duplicate id ${d.id}`);
    seen.add(d.id);
    // Deep links go into reseller quotes and stay there. If the anchor is not in the markup the
    // link silently lands at the top of the page instead of the device.
    assert.ok(html.includes(`id="${d.id}"`), `${d.id} has no anchor in the rendered page`);
  }
});

test('⚠️ nothing claims certification without the evidence certification means', () => {
  for (const d of devices.filter((x) => CERTIFIED.includes(x.status))) {
    assert.equal(d.validated_by, 'ScreenTinker',
      `${d.id} is ${d.status} but validated_by is "${d.validated_by}" — certification is a ScreenTinker test`);
  }
  // The inverse is the one that would actually mislead someone: a community report must never be
  // dressed as a ScreenTinker validation, because the page says Certified Hardware is what ScreenTinker
  // tested and holds in the lab.
  for (const d of devices.filter((x) => x.status === 'community-reported')) {
    assert.notEqual(d.validated_by, 'ScreenTinker',
      `${d.id} is community-reported but claims ScreenTinker validated it`);
  }
});

/** Compare two x.y.z versions. -1 / 0 / 1. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

test('⚠️ a device never requires a version newer than the one it was tested on', () => {
  // min_version is a sticky FLOOR, set when the device was first certified. player_version tracks
  // the most recent test and climbs past it on a retest — the old floor still held on the day it
  // was tested, so it does not move. What must never happen is the floor overtaking the evidence:
  // a page saying "needs 2.0.9" for a device last actually tested on 1.9.33 is an unsupported
  // requirement pointed at customers, and on a retest it is the easy mistake to make.
  for (const d of devices.filter((x) => x.min_version && x.player_version)) {
    assert.ok(cmpVersion(d.min_version, d.player_version) <= 0,
      `${d.id} requires ${d.min_version} but was only ever tested on ${d.player_version}`);
  }
});

test('⚠️ a documented limitation is actually documented', () => {
  for (const d of devices.filter((x) => x.status === 'certified-with-limits')) {
    assert.ok(Array.isArray(d.notes) && d.notes.length > 0,
      `${d.id} is certified-with-limits, so the limitation must be spelled out in notes`);
  }
  // "Say why, because people will otherwise buy it anyway."
  for (const d of devices.filter((x) => x.status === 'not-supported')) {
    assert.ok(Array.isArray(d.notes) && d.notes.length > 0,
      `${d.id} is not-supported and must say why`);
  }
  for (const d of devices.filter((x) => x.status === 'known-issues')) {
    assert.ok(Array.isArray(d.notes) && d.notes.length > 0,
      `${d.id} has known issues and must say what is broken`);
  }
});

test('dates are ISO, and versions and links have the shape the page assumes', () => {
  for (const d of devices) {
    for (const f of ['validated_on', 'eol']) {
      if (d[f] != null) assert.match(d[f], /^\d{4}-\d{2}-\d{2}$/, `${d.id}.${f} is not an ISO date`);
    }
    for (const f of ['player_version', 'min_version']) {
      if (d[f] != null) assert.match(d[f], /^\d+\.\d+\.\d+$/, `${d.id}.${f} is not a version`);
    }
    if (d.provisioning_url != null) {
      assert.match(d.provisioning_url, /^(\/|https:\/\/)/, `${d.id}.provisioning_url is not a usable link`);
      if (d.provisioning_url.startsWith('/')) {
        const target = path.join(ROOT, 'frontend', d.provisioning_url);
        assert.ok(fs.existsSync(target) || fs.existsSync(`${target}.html`),
          `${d.id} points at ${d.provisioning_url}, which does not exist`);
      }
    }
    if (d.model_numbers != null) {
      assert.ok(Array.isArray(d.model_numbers) && d.model_numbers.length > 0,
        `${d.id}.model_numbers must be a non-empty array or null, never an empty array`);
    }
    // A buy link is an EXTERNAL affiliate link, so it must be an absolute https URL (never a
    // site-relative path like provisioning_url can be). The page discloses it as affiliate and tags
    // it rel="sponsored nofollow"; this just keeps a malformed link out of the contract-named page.
    if (d.buy_url != null) {
      assert.match(d.buy_url, /^https:\/\/\S+$/, `${d.id}.buy_url must be an absolute https URL or null`);
    }
  }
  assert.match(data.last_updated, /^\d{4}-\d{2}-\d{2}$/, 'last_updated is not an ISO date');
});

test('the page states the contract meaning of the list, and renders its date from the data', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  // The distinction the agreements rest on has to be ON the page, near the top, not implied by
  // the grouping. If this ever gets edited away, the page stops doing the job it exists for.
  assert.match(html, /are Certified Hardware\s+under ScreenTinker agreements/,
    'the page no longer states which statuses are Certified Hardware');
  assert.match(html, /<strong>Certified<\/strong>[\s\S]{0,80}<strong>Certified with limits<\/strong>/,
    'the page no longer names BOTH certified statuses as the ones that count');
  assert.match(html, /no support commitment/i,
    'the page no longer says community entries carry no support commitment');
  assert.ok(html.includes(`Last updated ${data.last_updated}`),
    'last_updated is not rendered from the data file');
  // No script is needed to read the table.
  const body = html.slice(html.indexOf('<body'));
  const scripts = [...body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.filter((attrs) => !/application\/ld\+json/.test(attrs)).length, 0,
    'the page must be readable with no JavaScript; only the JSON-LD block is allowed');
});

test('the URL named in contracts is actually routed and advertised', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Either shape is fine; what must not change is that the extension-less URL resolves. It is
  // served by a router now, because approved community reports are merged in at request time.
  assert.match(server, /app\.(get|use)\('\/certified-hardware'/,
    'the extension-less contract URL has no route');
  // ⚠️ The fallback is the reason a database problem cannot take this URL down.
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'certified-hardware.js'), 'utf8');
  assert.match(route, /sendFile\(OUT\)/,
    'the page must fall back to the committed file rather than erroring');
  const sitemap = fs.readFileSync(path.join(ROOT, 'frontend', 'sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes('https://screentinker.com/certified-hardware'),
    'the page is not in the sitemap');
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.ok(html.includes('<link rel="canonical" href="https://screentinker.com/certified-hardware">'),
    'the canonical URL must be the extension-less one that contracts name');
});
