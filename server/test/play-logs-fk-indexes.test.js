'use strict';

/*
 * play_logs.content_id / widget_id are `ON DELETE SET NULL` foreign keys. Without an index on the
 * column, deleting one content or widget row scans the whole play_logs table, synchronously, and the
 * server serves nothing meanwhile (prod 2026-10-12: up to 34 s per delete on 5.2M plays).
 *
 * Covered here:
 *   - a fresh install has both partial indexes, and the FK lookup uses them rather than a scan
 *   - an upgrade from a database without them (and still holding the old idx_play_logs_content)
 *     builds them, drops the old one, and logs no failure
 *   - a boot where they already exist is a clean no-op: no failure, no rebuild announced
 *   - deleting content or a widget still clears the reference on its plays
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SERVER = path.join(__dirname, '..');
const NEW = ['idx_play_logs_content_ref', 'idx_play_logs_widget_ref'];

// Each boot is its own process: database.js runs its migrations once, at require time.
function boot(dataDir, script = '') {
  const r = spawnSync(process.execPath, ['-e', `
    const { db } = require('./db/database');
    ${script}
  `], {
    cwd: SERVER,
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(r.status, 0, `boot exited ${r.status}\n${r.stderr}`);
  return { out: r.stdout + r.stderr, stdout: r.stdout };
}

const result = (b) => JSON.parse(b.stdout.trim().split('\n').pop());

const INDEXES = `console.log(JSON.stringify(Object.fromEntries(
  db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'play_logs'").all()
    .map((r) => [r.name, r.sql]))));`;

const migrateFailures = (out) => out.split('\n').filter((l) => /\[migrate\].*(FAILED|failed)/.test(l));

test('a fresh install has both partial indexes and the FK lookups use them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plfk-fresh-'));
  try {
    const b = boot(dir, `console.log(JSON.stringify({
      content: db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM play_logs WHERE content_id = 'x'").all().map((r) => r.detail),
      widget: db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM play_logs WHERE widget_id = 'x'").all().map((r) => r.detail),
      indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'play_logs'").all(),
    }));`);
    assert.deepEqual(migrateFailures(b.out), []);
    const r = result(b);
    const byName = Object.fromEntries(r.indexes.map((i) => [i.name, i.sql]));
    assert.match(byName.idx_play_logs_content_ref, /ON play_logs\(content_id\) WHERE content_id IS NOT NULL/);
    assert.match(byName.idx_play_logs_widget_ref, /ON play_logs\(widget_id\) WHERE widget_id IS NOT NULL/);
    assert.ok(!('idx_play_logs_content' in byName), 'the old index is still dropped');
    assert.match(r.content.join(' '), /SEARCH play_logs USING (COVERING )?INDEX idx_play_logs_content_ref/);
    assert.match(r.widget.join(' '), /SEARCH play_logs USING (COVERING )?INDEX idx_play_logs_widget_ref/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('upgrading a database without the indexes builds them; booting again is a clean no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plfk-upgrade-'));
  try {
    // A database as 2.5.1 leaves it: no new indexes. Put the old one back as well, as on an install
    // upgraded from before #451, so the DROP and the new builds run in the same boot.
    boot(dir, `
      db.exec('DROP INDEX IF EXISTS idx_play_logs_content_ref');
      db.exec('DROP INDEX IF EXISTS idx_play_logs_widget_ref');
      db.exec('CREATE INDEX idx_play_logs_content ON play_logs(content_id, started_at DESC)');
      ${INDEXES}`);

    const upgrade = boot(dir, INDEXES);
    assert.deepEqual(migrateFailures(upgrade.out), []);
    for (const n of NEW) {
      assert.match(upgrade.out, new RegExp(`\\[migrate\\] building ${n} over`), `announces ${n}`);
      assert.match(upgrade.out, new RegExp(`\\[migrate\\] built ${n} in \\d+ms`), `times ${n}`);
    }
    const after = result(upgrade);
    for (const n of NEW) assert.ok(n in after, `${n} built on upgrade`);
    assert.ok(!('idx_play_logs_content' in after), 'old index dropped');

    // Already there: nothing to build, nothing to fail.
    const again = boot(dir, INDEXES);
    assert.deepEqual(migrateFailures(again.out), []);
    assert.doesNotMatch(again.out, /\[migrate\] build(ing|t) idx_play_logs_(content|widget)_ref/);
    assert.deepEqual(result(again), after, 'second boot leaves the indexes exactly as they were');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deleting content or a widget still clears the reference on its plays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-plfk-delete-'));
  try {
    const b = boot(dir, `
      // Only the play_logs rows and their parents matter here; build them without the rest of the
      // tenant graph, then delete with foreign keys enforced as the server runs.
      db.pragma('foreign_keys = OFF');
      const cols = (t) => db.prepare('PRAGMA table_info(' + t + ')').all();
      const insertMin = (t, id) => {
        const req = cols(t).filter((c) => c.notnull && c.dflt_value == null && !c.pk);
        const names = ['id', ...req.map((c) => c.name)];
        const vals = [id, ...req.map((c) => (/INT|REAL/i.test(c.type) ? 0 : 'x'))];
        db.prepare('INSERT INTO ' + t + ' (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')').run(...vals);
      };
      insertMin('content', 'c1'); insertMin('content', 'c2');
      insertMin('widgets', 'w1'); insertMin('widgets', 'w2');
      const play = (c, w) => {
        const req = cols('play_logs').filter((x) => x.notnull && x.dflt_value == null && !x.pk && !['content_id', 'widget_id'].includes(x.name));
        const names = ['content_id', 'widget_id', ...req.map((x) => x.name)];
        const vals = [c, w, ...req.map((x) => (/INT|REAL/i.test(x.type) ? 0 : 'x'))];
        db.prepare('INSERT INTO play_logs (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')').run(...vals);
      };
      play('c1', null); play('c2', null); play(null, 'w1'); play(null, 'w2');
      db.pragma('foreign_keys = ON');
      db.prepare("DELETE FROM content WHERE id = 'c1'").run();
      db.prepare("DELETE FROM widgets WHERE id = 'w1'").run();
      console.log(JSON.stringify(db.prepare('SELECT content_id, widget_id FROM play_logs ORDER BY id').all()));
    `);
    assert.deepEqual(result(b), [
      { content_id: null, widget_id: null },
      { content_id: 'c2', widget_id: null },
      { content_id: null, widget_id: null },
      { content_id: null, widget_id: 'w2' },
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
