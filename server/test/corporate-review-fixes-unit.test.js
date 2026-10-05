'use strict';

/*
 * Review fixes for head office playlists, against the in-memory fixture (test/helpers/corporate-fixture):
 *
 *   - a store covered ONLY by an org-wide mandate counts as carrying corporate state, so it is not
 *     offered for mesh workspace replication (guard.workspaceHasCorporateState)
 *   - the backstop's actorless-write tripwire stays quiet for writes that touch nothing corporate
 *     (an admin workspace delete on an install that never used the feature logged a warning)
 *   - a composition notices a store's content republished WITHOUT a published_rev bump (an older
 *     server version, after a rollback)
 *   - an emergency alert whose playlist is gone / unpublished / empty is reported
 *
 * MUTATION CHECKS (each verified once by reverting the line and watching a named test go red):
 *   - guard.js workspaceHasCorporateState: drop the org-mandate query -> "an org-wide mandate ..."
 *   - backstop.js gate: a plain AND instead of the CASE               -> "the tripwire stays quiet ..."
 *   - composition.js loadInputs: drop the snapshot digest              -> "a composition notices ..."
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, injectDb } = require('./helpers/corporate-fixture');

const db = freshDb();
injectDb(db);
const s = seed(db);

const guard = require('../lib/corporate/guard');
const actor = require('../lib/corporate/actor');
const composition = require('../lib/corporate/composition');
const reconcile = require('../lib/corporate/reconcile');

const img = (id) => ({ content_id: id, mime_type: 'image/png', duration_sec: 10, sort_order: 0, zone_id: null });

test('an org-wide mandate is corporate state for every workspace of the org (mesh replication guard)', () => {
  const ORG = s.org('Mesh org');
  const HQ = s.ws(ORG, 'HQ');
  const STORE = s.ws(ORG, 'Store');
  const OTHER = s.ws(s.org('Elsewhere'), 'Unrelated');
  s.hq(ORG, HQ);
  const P = s.playlist(HQ, { corporate: 1 });
  assert.equal(guard.workspaceHasCorporateState(db, STORE), null, 'nothing yet');
  s.mandate(ORG, 'org', ORG, { playlist_id: P });
  assert.equal(guard.workspaceHasCorporateState(db, STORE), 'mandate', 'covered by the org mandate');
  assert.equal(guard.workspaceHasCorporateState(db, HQ), 'hq');
  assert.equal(guard.workspaceHasCorporateState(db, OTHER), null, 'another org is not covered');
});

test('the tripwire stays quiet for actorless writes that touch nothing corporate', () => {
  const d2 = freshDb();
  const s2 = seed(d2);
  const ORG = s2.org('Plain');
  const W = s2.ws(ORG, 'W');
  const pl = s2.playlist(W, { name: 'ordinary' });
  d2.prepare('INSERT INTO playlist_items (playlist_id, sort_order) VALUES (?, 0)').run(pl);
  actor.resetTripwire();
  const inRequest = (fn) => actor.httpAls.run({ method: 'DELETE', path: '/api/admin/workspaces/:id' }, fn);
  // No corporate playlist on the install at all: an admin path deleting a workspace's playlists.
  inRequest(() => {
    d2.prepare('UPDATE playlists SET name = ? WHERE id = ?').run('renamed', pl);
    d2.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(pl);
    d2.prepare('DELETE FROM playlists WHERE id = ?').run(pl);
  });
  assert.equal(actor.tripwireCount(), 0, 'no corporate rows involved: nothing to note');

  // With corporate content present, an ordinary playlist's write is still not noted...
  const HQ = s2.ws(ORG, 'HQ');
  s2.hq(ORG, HQ);
  const P = s2.playlist(HQ, { corporate: 1 });
  const pl2 = s2.playlist(W, { name: 'ordinary 2' });
  d2.prepare('INSERT INTO playlist_items (playlist_id, sort_order) VALUES (?, 0)').run(pl2);
  inRequest(() => d2.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(pl2));
  assert.equal(actor.tripwireCount(), 0, 'an ordinary playlist is not governed');
  // ...but a write to head office's content with no actor still trips it (the wire is not cut).
  d2.prepare('INSERT INTO playlist_items (playlist_id, sort_order) VALUES (?, 0)').run(P);
  inRequest(() => d2.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(P));
  assert.equal(actor.tripwireCount(), 1, 'a governed write without an actor is noted');
  actor.resetTripwire();
});

test('a composition notices a store\'s content republished without a published_rev bump', () => {
  const ORG = s.org('Rollback org');
  const HQ = s.ws(ORG, 'HQ');
  const W = s.ws(ORG, 'Store');
  s.hq(ORG, HQ);
  const P = s.playlist(HQ, { corporate: 1 });
  s.composable(P, [img('hq')]);
  const SLOT = s.slot(ORG, P, { name: 'Promo' });
  const dev = s.device(W, { name: 'Till' });
  s.mandate(ORG, 'workspace', W, { playlist_id: P });
  const f = s.fill(SLOT, W, 'workspace', W, { items: [img('a'), img('b')] });
  const ids = () => composition.compositionFor(db, dev, P).items.map((i) => i.content_id);
  assert.deepEqual(ids(), ['hq', 'a', 'b']);
  // What an older server version does when the store publishes there: snapshot only, rev untouched.
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify([img('a'), img('b'), img('d')]), f.playlistId);
  assert.deepEqual(ids(), ['hq', 'a', 'b', 'd'], 'the cached composition is stale and recomposed');
});

test('an emergency alert with nothing to show is reported, whatever the reason', () => {
  for (const col of ['target_kind TEXT', 'target_ref TEXT']) {
    try { db.exec(`ALTER TABLE triggers ADD COLUMN ${col}`); } catch (_) { /* already there */ }
  }
  const ORG = s.org('Alarm org');
  const HQ = s.ws(ORG, 'HQ');
  const good = s.playlist(HQ, { name: 'Alarm' });
  db.prepare('UPDATE playlists SET published_snapshot = ? WHERE id = ?').run(JSON.stringify([img('evac')]), good);
  const draft = s.playlist(HQ, { name: 'Draft', published: false });
  const empty = s.playlist(HQ, { name: 'Empty' });
  const add = (id, ref) => db.prepare("INSERT INTO triggers (id, workspace_id, name, kind, target_kind, target_ref) VALUES (?, ?, ?, 'emergency', 'playlist', ?)").run(id, HQ, id, ref);
  add('em-good', good); add('em-gone', 'no-such-playlist'); add('em-draft', draft); add('em-empty', empty);
  const row = (id) => db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
  assert.equal(reconcile.emergencyTargetProblem(db, row('em-good')), null);
  assert.equal(reconcile.emergencyTargetProblem(db, row('em-gone')), 'missing');
  assert.equal(reconcile.emergencyTargetProblem(db, row('em-draft')), 'unpublished');
  assert.equal(reconcile.emergencyTargetProblem(db, row('em-empty')), 'empty');
  const warn = console.warn;
  const logged = [];
  console.warn = (m) => logged.push(String(m));
  let bad;
  try { bad = reconcile.reportEmptyEmergencyAlerts(db); } finally { console.warn = warn; }
  assert.deepEqual(bad.map((b) => b.id).sort(), ['em-draft', 'em-empty', 'em-gone']);
  assert.equal(logged.length, 3, 'one log line per alert');
});

test('the dashboard has a sentence for every reason an alert has nothing to show (a computed key)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  for (const why of ['missing', 'unpublished', 'empty']) assert.match(en, new RegExp(`'corp\\.em\\.target_${why}':`), why);
  const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'corporate.js'), 'utf8');
  for (const why of ['missing', 'unpublished', 'empty']) assert.match(view, new RegExp(`${why}: 'corp\\.em\\.target_${why}'`), `the view maps ${why}`);
});
