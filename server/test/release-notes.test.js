'use strict';

/*
 * The "What's new" notes — the ones a person reads, not the changelog.
 *
 * ⚠️ THE POINT OF THIS FILE IS THE FIRST TEST. Everything else here is shape-checking; the load
 * bearing assertion is that the version in VERSION has an entry. A notes file with no enforcement
 * is a notes file that is current for two releases and then silently a year out of date, and the
 * failure mode is invisible: the panel just stops appearing and nobody notices it stopped. Failing
 * the build is the only thing that keeps the release process honest, which is why RELEASING.md
 * step 1 says to write the bullets.
 *
 * ⚠️ AND WHY THE PROSE IS CHECKED AT ALL. These notes are read by an operator who wants to know
 * whether anything they do has changed. The standing temptation is to paste the changelog section
 * in, and the changelog is written for contributors — issue numbers, SQL, event-loop arguments.
 * The length and issue-reference assertions below are a floor under that, not style policing.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'release-notes.json'), 'utf8'));
const releaseNotes = require('../lib/release-notes');

test('THE GUARD: the version being shipped has release notes', () => {
  const entry = raw.releases.find((r) => r.version === VERSION);
  assert.ok(
    entry,
    `VERSION is ${VERSION} and release-notes.json has no entry for it. Add 3-5 plain-language ` +
    `bullets (see RELEASING.md step 1) — without them the What's new panel silently stops ` +
    `appearing and an upgrade goes unannounced, which is the whole thing this file prevents.`
  );
  assert.ok(entry.notes.length >= 1, 'an entry with no notes is the same as no entry');
});

test('every entry has a version, an ISO date and notes', () => {
  assert.ok(Array.isArray(raw.releases) && raw.releases.length > 0, 'releases must be a non-empty array');
  for (const r of raw.releases) {
    assert.match(r.version, /^\d+\.\d+\.\d+(-[\w.]+)?$/, `bad version: ${r.version}`);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, `${r.version}: date must be YYYY-MM-DD`);
    assert.ok(Array.isArray(r.notes) && r.notes.length > 0, `${r.version}: needs at least one note`);
    for (const n of r.notes) {
      assert.equal(typeof n, 'string');
      assert.ok(n.trim().length > 0, `${r.version}: empty note`);
    }
  }
});

test('versions are unique and listed newest first', () => {
  const versions = raw.releases.map((r) => r.version);
  assert.equal(new Set(versions).size, versions.length, 'a version appears twice');

  const key = (v) => v.split('-')[0].split('.').map(Number);
  for (let i = 1; i < versions.length; i++) {
    const [aM, aMi, aP] = key(versions[i - 1]);
    const [bM, bMi, bP] = key(versions[i]);
    const newer = aM !== bM ? aM > bM : aMi !== bMi ? aMi > bMi : aP > bP;
    assert.ok(newer, `${versions[i - 1]} must sort above ${versions[i]} — the list renders in file order`);
  }
});

test('the notes read as product, not as a changelog', () => {
  for (const r of raw.releases) {
    for (const n of r.notes) {
      // A note nobody finishes reading is a note nobody read.
      assert.ok(n.length <= 300, `${r.version}: note is ${n.length} chars, keep it under 300:\n  ${n}`);
      // "#307", "(#142)" — an operator has no way to look these up and no reason to want to.
      assert.ok(!/#\d+/.test(n), `${r.version}: note references an issue number, which means nothing here:\n  ${n}`);
      // Backticks are the tell for a pasted code identifier or SQL fragment.
      assert.ok(!n.includes('`'), `${r.version}: note contains code formatting; write it in words:\n  ${n}`);
    }
    assert.ok(r.notes.length <= 8, `${r.version}: ${r.notes.length} notes is a changelog, not a summary`);
  }
});

test('the API payload carries the running version, its notes, and the history', () => {
  const p = releaseNotes.payload();
  assert.equal(p.version, VERSION);
  assert.ok(p.current, 'the running version resolves to an entry');
  assert.equal(p.current.version, VERSION);
  assert.equal(p.history.length, raw.releases.length, 'the full list is what Settings renders');
});

test('an unknown version yields null rather than the wrong notes', () => {
  // A fork, a dirty build, a version whose notes were forgotten. Showing the previous release's
  // notes under a new number would be worse than showing nothing: it is confidently wrong.
  assert.equal(releaseNotes.forVersion('0.0.0-nope'), null);
});

test('the panel is dismissed per VERSION, not once and forever', () => {
  // The behaviour that makes this a release-notes panel rather than a one-time tour. Pinned on the
  // source because it is a browser-storage decision with no server side to assert against.
  const src = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'components', 'whats-new.js'), 'utf8');
  assert.match(src, /localStorage\.setItem\(SEEN_KEY,\s*version\)/,
    'markSeen must store the version, not a boolean — otherwise the next release is never announced');
  assert.match(src, /seenVersion\(\)\s*===\s*version/,
    'isSeen must compare the stored version against the running one');
});
