'use strict';

/*
 * No fleet-wide refresh (#638 review). The e-ink cache key is the ETag, and every panel sends its
 * last one as If-None-Match. A change to the key for a panel whose frame did not change makes the
 * whole fleet miss its 304 at once and redraw (a full e-paper refresh each, battery included). The
 * PR prefixed every key with a CACHE_VERSION and an orientation slot; a plain existing panel's key
 * must be exactly main's again.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./helpers/embedded-real-db').boot({});
const { cacheKey } = require('../lib/embedded-cache');
const { parseProfile, PRESETS } = require('../lib/embedded-profiles');

after(() => h.close());

// main's cacheKey (lib/embedded-cache.js at 1e094530), verbatim.
function mainCacheKey(deviceId, itemId, itemUpdatedAt, profile) {
  const payload = JSON.stringify([
    deviceId, itemId, itemUpdatedAt,
    profile.width, profile.height, profile.rotation,
    profile.colorDepth, profile.dither, profile.outputFormat,
  ]);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const OLD_PRESETS = ['seeed-reterminal-sticky', 'waveshare-7.5in-v2', 'waveshare-4.2in-v2', 'waveshare-2.9in-v2',
  'waveshare-1.54in-v2', 'waveshare-5.65in-acep', 'generic-320x240-rgb565', 'generic-480x320-rgb565',
  'generic-128x64-1bit', 'generic-128x32-1bit'];

test('a plain existing panel\'s cache key is main\'s, for every old preset and a custom profile', () => {
  const profiles = [...OLD_PRESETS, JSON.stringify({ width: 480, height: 800, colorDepth: '1bit' }),
    JSON.stringify({ width: 128, height: 296, rotation: 270 })];
  for (const raw of profiles) {
    const p = parseProfile(raw);
    assert.equal(cacheKey('dev-fixed', 'item-1', 1700000000, p), mainCacheKey('dev-fixed', 'item-1', 1700000000, p), raw);
  }
  // Golden from main itself (not just the formula): the Sticky preset.
  assert.equal(cacheKey('dev-fixed', 'item-1', 1700000000, parseProfile('seeed-reterminal-sticky')).slice(0, 16), 'f60efbc705244e93');
  assert.ok(OLD_PRESETS.every((k) => PRESETS[k]));
});

test('the ETag a plain panel is served is main\'s key', async () => {
  const base = await h.ready();
  const p = await h.mkPanel('waveshare-7.5in-v2');
  const res = await fetch(`${base}/render?device_id=${p.id}`, { headers: { Authorization: `Bearer ${p.token}` } });
  assert.equal(res.status, 200);
  const cid = 'c-' + p.id;
  const rev = h.db.prepare('SELECT COALESCE(NULLIF(updated_at, 0), created_at) AS rev FROM content WHERE id = ?').get(cid).rev;
  assert.equal(res.headers.get('etag'), `"${mainCacheKey(p.id, cid, rev, parseProfile('waveshare-7.5in-v2'))}"`);
});

test('a stated orientation or an MCU-transposed frame does get its own key', () => {
  const plain = parseProfile('seeed-reterminal-sticky');
  const portrait = parseProfile('seeed-reterminal-sticky', { orientation: 'portrait' });
  assert.notEqual(cacheKey('d', 'i', 1, portrait), cacheKey('d', 'i', 1, plain));
  const e1001 = parseProfile('seeed-reterminal-e1001');
  assert.notEqual(cacheKey('d', 'i', 1, e1001), mainCacheKey('d', 'i', 1, e1001), 'new presets need no old key');
});
