'use strict';

/*
 * The head office (corporate) tier of the playlist resolver — spec §2.1/§2.2.
 *
 * A mandate is the TOP of the ladder: above an active schedule, a device override, the wall, the
 * group and the deliberate 'none'. These tests pin the ladder, the level order, every way a mandate
 * must NOT count (disabled, org switch off, a non-corporate or foreign playlist), walls, the layout
 * rule, and — critique R1 — the query plan and timing, because the first draft of this view was
 * ~400x slower than the one it replaced and nothing but a measurement would have shown it.
 *
 * MUTATION CHECKS (each verified by reverting the line in a scratch copy and watching a test here
 * go red): drop the mandate branch of the view's playlist CASE ("a mandate outranks ..."); drop the
 * mandate-layout CASE ("the layout is the mandate's ...").
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, seed, resolved } = require('./helpers/corporate-fixture');

function world() {
  const db = freshDb();
  const s = seed(db);
  const org = s.org('Acme');
  const hq = s.ws(org, 'HQ');
  s.hq(org, hq);
  const store = s.ws(org, 'Store 1');
  const P = s.playlist(hq, { corporate: 1, name: 'Brand loop' });
  const own = s.playlist(store, { name: 'Store own' });
  return { db, s, org, hq, store, P, own };
}

test('a mandate outranks a schedule, a device override, a wall, a group and \'none\'', () => {
  const { db, s, org, store, P, own } = world();
  const g = s.group(store, { playlist_id: own });
  const wallPl = s.playlist(store, { name: 'wall' });
  const w = s.wall(store, { playlist_id: wallPl });
  const dOverride = s.device(store, { playlist_id: own, playlist_source: 'device' });
  const dSched = s.device(store, { scheduled_playlist_id: own });
  const dNone = s.device(store, { playlist_source: 'none' });
  const dGroup = s.device(store); s.join(dGroup, g);
  const dWall = s.device(store); s.onWall(dWall, w);
  s.mandate(org, 'workspace', store, { playlist_id: P });
  for (const d of [dOverride, dSched, dNone, dGroup, dWall]) {
    assert.deepEqual(resolved(db, d), { playlist_id: P, source: 'corporate', layout_id: null }, `device ${d}`);
  }
});

test('the rows a mandate shadows are untouched, and come back when it goes', () => {
  const { db, s, org, store, P, own } = world();
  const d = s.device(store, { playlist_id: own, playlist_source: 'device' });
  const m = s.mandate(org, 'workspace', store, { playlist_id: P });
  assert.equal(resolved(db, d).source, 'corporate');
  db.prepare('DELETE FROM corporate_mandates WHERE id = ?').run(m);
  assert.deepEqual(resolved(db, d), { playlist_id: own, source: 'device', layout_id: null });
});

test('a dark mandate resolves to NULL with source corporate — really dark', () => {
  const { db, s, org, store, own } = world();
  const d = s.device(store, { playlist_id: own, playlist_source: 'device' });
  s.mandate(org, 'device', d, { dark: 1 });
  assert.deepEqual(resolved(db, d), { playlist_id: null, source: 'corporate', layout_id: null });
});

test('a mandate does NOT count when disabled, when the org switch is off, for a non-corporate or foreign playlist', () => {
  const { db, s, org, hq, store, P, own } = world();
  const d = s.device(store, { playlist_id: own, playlist_source: 'device' });
  const before = resolved(db, d);

  const m = s.mandate(org, 'device', d, { playlist_id: P, enabled: 0 });
  assert.deepEqual(resolved(db, d), before, 'disabled mandate');

  db.prepare('UPDATE corporate_mandates SET enabled = 1 WHERE id = ?').run(m);
  db.prepare('UPDATE organizations SET corporate_enabled = 0 WHERE id = ?').run(org);
  assert.deepEqual(resolved(db, d), before, 'org switch off');
  db.prepare('UPDATE organizations SET corporate_enabled = 1 WHERE id = ?').run(org);

  db.prepare('UPDATE playlists SET corporate = 0 WHERE id = ?').run(P);
  assert.deepEqual(resolved(db, d), before, 'the playlist is not corporate');
  db.prepare('UPDATE playlists SET corporate = 1 WHERE id = ?').run(P);
  assert.equal(resolved(db, d).source, 'corporate', 'precondition for the next case');

  // Another org's corporate playlist named by this org's mandate row: never a store's content.
  const other = s.org('Other');
  const otherHq = s.ws(other, 'Other HQ');
  const foreign = s.playlist(otherHq, { corporate: 1 });
  db.prepare('UPDATE corporate_mandates SET playlist_id = ? WHERE id = ?').run(foreign, m);
  assert.deepEqual(resolved(db, d), before, 'foreign-org playlist');

  // And a mandate row of ANOTHER org targeting this device's workspace does not reach it.
  db.prepare('DELETE FROM corporate_mandates').run();
  s.mandate(other, 'workspace', store, { playlist_id: foreign });
  assert.deepEqual(resolved(db, d), before, 'foreign-org mandate');
  assert.ok(hq);
});

test('the most specific level wins: device > group > workspace > org', () => {
  const { db, s, org, hq, store } = world();
  const pOrg = s.playlist(hq, { corporate: 1 }); const pWs = s.playlist(hq, { corporate: 1 });
  const pGrp = s.playlist(hq, { corporate: 1 }); const pDev = s.playlist(hq, { corporate: 1 });
  const g = s.group(store);
  const d = s.device(store); s.join(d, g);
  s.mandate(org, 'org', org, { playlist_id: pOrg });
  assert.equal(resolved(db, d).playlist_id, pOrg);
  s.mandate(org, 'workspace', store, { playlist_id: pWs });
  assert.equal(resolved(db, d).playlist_id, pWs);
  s.mandate(org, 'group', g, { playlist_id: pGrp });
  assert.equal(resolved(db, d).playlist_id, pGrp);
  s.mandate(org, 'device', d, { playlist_id: pDev });
  assert.equal(resolved(db, d).playlist_id, pDev);
});

test('two group mandates: group priority, then the older group', () => {
  const { db, s, org, hq, store } = world();
  const a = s.playlist(hq, { corporate: 1 }); const b = s.playlist(hq, { corporate: 1 });
  const g1 = s.group(store, { priority: 0, created_at: 1 }); const g2 = s.group(store, { priority: 5, created_at: 2 });
  const d = s.device(store); s.join(d, g1); s.join(d, g2);
  s.mandate(org, 'group', g1, { playlist_id: a }); s.mandate(org, 'group', g2, { playlist_id: b });
  assert.equal(resolved(db, d).playlist_id, b, 'higher priority wins');
  db.prepare('UPDATE device_groups SET priority = 0').run();
  assert.equal(resolved(db, d).playlist_id, a, 'tie -> oldest group');
});

test('wall members resolve through the WALL; device and group mandates are ignored for them', () => {
  const { db, s, org, hq, store } = world();
  const pWall = s.playlist(hq, { corporate: 1 }); const pDev = s.playlist(hq, { corporate: 1 }); const pGrp = s.playlist(hq, { corporate: 1 });
  const w = s.wall(store);
  const lead = s.device(store); const follow = s.device(store);
  s.onWall(lead, w); s.onWall(follow, w);
  const g = s.group(store); s.join(follow, g);
  s.mandate(org, 'device', lead, { playlist_id: pDev });
  s.mandate(org, 'group', g, { playlist_id: pGrp });
  assert.equal(resolved(db, lead).source, null, 'a device mandate naming a wall member must not split the wall');
  assert.equal(resolved(db, follow).source, null, 'nor a group mandate');
  s.mandate(org, 'wall', w, { playlist_id: pWall });
  assert.equal(resolved(db, lead).playlist_id, pWall);
  assert.equal(resolved(db, follow).playlist_id, pWall);
  // Leader re-election changes nothing: the mandate is keyed on the wall, not on a device.
  db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(follow, w);
  assert.equal(resolved(db, lead).playlist_id, pWall);
});

test('⚠️ the layout is the mandate\'s, or NULL (full screen) — never the device\'s or a scheduled one', () => {
  const { db, s, org, hq, store, P } = world();
  const storeLayout = s.layout(store); const schedLayout = s.layout(store); const hqLayout = s.layout(hq);
  const d = s.device(store, { layout_id: storeLayout, scheduled_layout_id: schedLayout });
  assert.equal(resolved(db, d).layout_id, schedLayout, 'precondition: unmandated = schedule layout');
  const m = s.mandate(org, 'device', d, { playlist_id: P });
  assert.equal(resolved(db, d).layout_id, null, 'a store layout could shrink head office into a corner');
  db.prepare('UPDATE corporate_mandates SET layout_id = ? WHERE id = ?').run(hqLayout, m);
  assert.equal(resolved(db, d).layout_id, hqLayout);
});

test('with NO mandates the view output is byte-identical to the frozen pre-feature view', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { db, s, store, own } = world();
  const g = s.group(store, { playlist_id: own });
  for (let i = 0; i < 30; i++) {
    const d = s.device(store, i % 3 === 0 ? { playlist_id: own, playlist_source: 'device' } : i % 3 === 1 ? { playlist_source: 'none' } : {});
    if (i % 2) s.join(d, g);
  }
  const now = db.prepare('SELECT device_id, playlist_id, source, layout_id FROM device_resolved_playlist ORDER BY device_id').all();
  const frozen = fs.readFileSync(path.join(__dirname, 'fixtures', 'resolver-views-d82f572.sql'), 'utf8')
    .replace(/^--.*$/gm, '')
    .replace(/device_inherited_playlist/g, 'old_inherited').replace(/device_resolved_playlist/g, 'old_resolved');
  db.exec(frozen);
  const old = db.prepare('SELECT device_id, playlist_id, source, layout_id FROM old_resolved ORDER BY device_id').all();
  assert.deepEqual(now, old);
});

/* ── Performance guard (critique R1) ─────────────────────────────────────────────────────────── */

function bigFleet(nMandates) {
  const db = freshDb({ guards: false });
  const s = seed(db);
  const ins = db.prepare('INSERT INTO devices (id, workspace_id, name, playlist_id, playlist_source) VALUES (?, ?, ?, ?, ?)');
  const orgs = [];
  db.transaction(() => {
    for (let o = 0; o < 100; o++) {
      const org = s.org(`o${o}`, { corporate: o < 5 ? 1 : 0 });
      const hq = s.ws(org, 'hq'); s.hq(org, hq);
      const P = s.playlist(hq, { corporate: 1 });
      const wss = [hq];
      for (let w = 0; w < 4; w++) {
        const ws = s.ws(org, `w${w}`); wss.push(ws);
        const pl = s.playlist(ws);
        const g = s.group(ws, { playlist_id: pl });
        for (let d = 0; d < 12; d++) {
          const id = `d${o}_${w}_${d}`;
          ins.run(id, ws, id, d % 3 ? null : pl, d % 3 ? null : 'device');
          if (d % 2) s.join(id, g);
        }
      }
      orgs.push({ org, P, wss });
    }
    for (let m = 0; m < nMandates; m++) {
      const o = orgs[m % 5];
      s.mandate(o.org, 'workspace', o.wss[1 + (Math.floor(m / 5) % 4)], { playlist_id: o.P });
    }
  })();
  return db;
}

for (const n of [0, 20]) {
  test(`⚠️ PERFORMANCE: a single-device lookup stays an index SEARCH and < 0.05 ms with ${n} mandates (5,000 devices)`, () => {
    const db = bigFleet(n);
    const count = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
    assert.ok(count >= 4800, `fixture has ${count} devices`);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM device_resolved_playlist WHERE device_id = ?').all('d3_1_4').map((r) => r.detail);
    for (const step of plan) {
      assert.doesNotMatch(step, /^SCAN (d|devices)\b/, `the device table must never be scanned for one device: ${plan.join(' | ')}`);
      assert.doesNotMatch(step, /MATERIALIZE/, `no materialized derived table: ${plan.join(' | ')}`);
    }
    const one = db.prepare('SELECT * FROM device_resolved_playlist WHERE device_id = ?');
    for (let i = 0; i < 200; i++) one.get('d3_1_4');   // warm
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) one.get(`d${i % 5}_${i % 4}_${i % 12}`);
    const avg = Number(process.hrtime.bigint() - t0) / 1e6 / 2000;
    assert.ok(avg < 0.05, `average single-device lookup ${avg.toFixed(4)} ms (bench: 0.003/0.006 ms)`);
  });
}
