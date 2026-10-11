'use strict';

/*
 * lib/tz-table.js — the UTC-offset spans a player without a zone database (the Roku) uses to put
 * the dashboard's zone on its own clock. The shape is the contract in docs/roku-player.md; the
 * zones are the ones that break naive implementations: a US DST change, a European one on a
 * different date, a zone with no DST at a half-hour offset, a zone whose DST is THIRTY minutes,
 * and garbage.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tzTable, offsetMinutes } = require('../lib/tz-table');

const H = 3600 * 1000;
const iso = (s) => Date.parse(s);

// Every table: sorted, starts 24 h before the hour of `now`, and the spans cover now+72h.
function assertShape(t, now) {
  assert.equal(typeof t.zone, 'string');
  assert.equal(t.generated_ms, Math.floor(now / H) * H, 'stamped with the hour, so a rebuild in the same hour is identical');
  assert.ok(Array.isArray(t.spans) && t.spans.length >= 1);
  assert.ok(t.spans[0].from_ms <= now - 24 * H, 'covers the previous 24 h');
  for (let i = 1; i < t.spans.length; i++) {
    assert.ok(t.spans[i].from_ms > t.spans[i - 1].from_ms, 'sorted by from_ms');
    assert.notEqual(t.spans[i].offset_min, t.spans[i - 1].offset_min, 'a new span only where the offset changes');
    assert.equal(t.spans[i].from_ms % 60000, 0, 'minute precision');
  }
  for (const s of t.spans) assert.ok(Number.isInteger(s.offset_min));
}

// The offset the table claims for an instant: the last span that started at or before it.
function lookup(t, ms) {
  let off = t.spans[0].offset_min;
  for (const s of t.spans) if (s.from_ms <= ms) off = s.offset_min;
  return off;
}

test('America/Chicago across the November DST change: one transition, at 02:00 CDT = 07:00Z', () => {
  const now = iso('2026-11-01T12:00:00Z');
  const t = tzTable('America/Chicago', now);
  assertShape(t, now);
  assert.equal(t.zone, 'America/Chicago');
  assert.deepEqual(t.spans.map((s) => s.offset_min), [-300, -360]);
  assert.equal(t.spans[1].from_ms, iso('2026-11-01T07:00:00Z'));
  assert.equal(lookup(t, iso('2026-11-01T06:59:00Z')), -300, 'one minute before: CDT');
  assert.equal(lookup(t, iso('2026-11-01T07:00:00Z')), -360, 'on the minute: CST');
});

test('America/Chicago in spring: the gap at 02:00 CST = 08:00Z', () => {
  const now = iso('2027-03-13T20:00:00Z');
  const t = tzTable('America/Chicago', now);
  assertShape(t, now);
  assert.deepEqual(t.spans.map((s) => s.offset_min), [-360, -300]);
  assert.equal(t.spans[1].from_ms, iso('2027-03-14T08:00:00Z'));
});

test('a table for any instant agrees with Intl at every hour it covers', () => {
  const now = iso('2026-10-24T18:30:00Z');
  for (const zone of ['America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe']) {
    const t = tzTable(zone, now);
    for (let ms = now - 24 * H; ms <= now + 72 * H; ms += H) {
      assert.equal(lookup(t, ms), offsetMinutes(zone, ms), `${zone} at ${new Date(ms).toISOString()}`);
    }
  }
});

test('Europe/London: BST ends at 01:00Z on the last Sunday of October', () => {
  const now = iso('2026-10-24T12:00:00Z');
  const t = tzTable('Europe/London', now);
  assertShape(t, now);
  assert.deepEqual(t.spans.map((s) => s.offset_min), [60, 0]);
  assert.equal(t.spans[1].from_ms, iso('2026-10-25T01:00:00Z'));
});

test('Asia/Kolkata: no DST, a half-hour offset, exactly one span', () => {
  const now = iso('2026-10-11T00:00:00Z');
  const t = tzTable('Asia/Kolkata', now);
  assertShape(t, now);
  assert.deepEqual(t.spans, [{ from_ms: now - 24 * H, offset_min: 330 }]);
});

test('Australia/Lord_Howe: a THIRTY-minute DST step (+10:30 -> +11:00) at 02:00 local', () => {
  const now = iso('2026-10-03T12:00:00Z');
  const t = tzTable('Australia/Lord_Howe', now);
  assertShape(t, now);
  assert.deepEqual(t.spans.map((s) => s.offset_min), [630, 660]);
  assert.equal(t.spans[1].from_ms, iso('2026-10-03T15:30:00Z'));
});

test('UTC, and anything that is not a zone, is a UTC table that says so', () => {
  const now = iso('2026-10-11T00:00:00Z');
  for (const z of ['UTC', 'Nope/Not_A_Zone', '', null, undefined, 42, "Europe/London'; alert(1)//"]) {
    const t = tzTable(z, now);
    assert.equal(t.zone, 'UTC', String(z));
    assert.deepEqual(t.spans, [{ from_ms: now - 24 * H, offset_min: 0 }], String(z));
  }
});

test('the same hour gives the same table; the next hour moves the window', () => {
  const a = tzTable('America/Chicago', iso('2026-10-11T10:05:00Z'));
  const b = tzTable('America/Chicago', iso('2026-10-11T10:59:59Z'));
  assert.deepEqual(a, b);
  const c = tzTable('America/Chicago', iso('2026-10-11T11:00:00Z'));
  assert.equal(c.generated_ms - a.generated_ms, H);
  // A caller that edits its copy cannot change the next caller's.
  a.spans[0].offset_min = 999;
  assert.notEqual(tzTable('America/Chicago', iso('2026-10-11T10:30:00Z')).spans[0].offset_min, 999);
});
