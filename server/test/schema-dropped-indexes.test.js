'use strict';

/*
 * schema.sql is exec'd on EVERY boot, before the migrations. An index it creates that a migration
 * then drops is therefore built and thrown away on every restart. idx_play_logs_content did exactly
 * that after #451 dropped it: on prod (5.2M plays) each restart built a 260 MB index synchronously,
 * before the server listened, and left ~236 MB of freed pages behind.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(SERVER, 'db', 'schema.sql'), 'utf8');
const DATABASE = fs.readFileSync(path.join(SERVER, 'db', 'database.js'), 'utf8');

const sqlCode = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('schema.sql creates no index that a migration drops', () => {
  const dropped = [...DATABASE.matchAll(/DROP INDEX IF EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(dropped.includes('idx_play_logs_content'), 'found the #451 drop');
  const created = new Set([...sqlCode(SCHEMA).matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]));
  for (const name of dropped) {
    assert.ok(!created.has(name), `schema.sql creates ${name}, which a migration drops: it would be rebuilt and dropped on every boot`);
  }
});

function boot(dataDir, script = '') {
  const r = spawnSync(process.execPath, ['-e', `const { db } = require('./db/database');\n${script}`], {
    cwd: SERVER, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').pop();
}

test('a second boot over a database with plays frees no pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-schema-idx-'));
  try {
    // First boot: create the schema, then add enough plays that an index over them takes pages.
    boot(dir, `
      db.pragma('foreign_keys = OFF');
      const cols = db.prepare('PRAGMA table_info(play_logs)').all()
        .filter((c) => c.notnull && c.dflt_value == null && !c.pk && c.name !== 'content_id');
      const names = ['content_id', ...cols.map((c) => c.name)];
      const ins = db.prepare('INSERT INTO play_logs (' + names.join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')');
      db.transaction(() => {
        for (let i = 0; i < 20000; i++) ins.run('content-' + (i % 500), ...cols.map((c) => (/INT|REAL/i.test(c.type) ? i : 'x')));
      })();
      db.exec('VACUUM');
      console.log(db.pragma('freelist_count', { simple: true }));
    `);
    // Second boot: an index built and dropped here would leave its pages on the freelist.
    const free = Number(boot(dir, `console.log(db.pragma('freelist_count', { simple: true }));`));
    assert.equal(free, 0, `the second boot left ${free} free page(s): something was built and dropped`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
