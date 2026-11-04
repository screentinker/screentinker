'use strict';

/*
 * scripts/db-tool.js: snapshots and checks through the server's own SQLite, so the backup scripts
 * never join the live WAL database with the host's sqlite3 (Ubuntu 24.04's 3.45.1 predates SQLite's
 * WAL-reset fix, 3.51.3; production was corrupted twice inside the backup window).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const TOOL = path.join(ROOT, 'scripts', 'db-tool.js');
const { Database } = require('../db/sqlite-driver');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'st-dbtool-')); }

function liveDb(dir, rows = 200) {
  const file = path.join(dir, 'live.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX t_v ON t(v);');
  const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
  for (let i = 0; i < rows; i++) ins.run(`row-${i}-${'x'.repeat(200)}`);
  return { file, db };
}

function tool(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
}

test('snapshot copies a live WAL database (rows still in the WAL included) and checks the copy', () => {
  const d = tmp();
  const { file, db } = liveDb(d);
  try {
    // The server's connection stays open with uncheckpointed rows, as in production.
    db.prepare('INSERT INTO t (v) VALUES (?)').run('in-the-wal');
    const out = path.join(d, 'snap.db');
    const r = tool(['snapshot', file, out]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out, 'ok');
    const copy = new Database(out, { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 201);
    assert.equal(copy.prepare("SELECT count(*) n FROM t WHERE v = 'in-the-wal'").get().n, 1);
    copy.close();
  } finally { db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('snapshot refuses to overwrite, and usage errors exit 2', () => {
  const d = tmp();
  const { file, db } = liveDb(d, 5);
  try {
    const out = path.join(d, 'snap.db');
    fs.writeFileSync(out, 'already here');
    const r = tool(['snapshot', file, out]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /refusing to overwrite/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'already here');
    assert.equal(tool([]).status, 2);
    assert.equal(tool(['check']).status, 2);
    assert.equal(tool(['check', file, 'deep']).status, 2);
  } finally { db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('check reports a damaged database with what SQLite said, exit 1', () => {
  const d = tmp();
  const { file, db } = liveDb(d, 400);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  try {
    assert.deepEqual(tool(['check', file]), { status: 0, out: 'ok' });
    // Break the index: zero out the last page, which belongs to the most recently written b-tree.
    const buf = fs.readFileSync(file);
    const pageSize = buf.readUInt16BE(16) || 65536;
    buf.fill(0x5a, buf.length - pageSize + 8, buf.length);
    fs.writeFileSync(file, buf);
    const r = tool(['check', file, 'integrity']);
    assert.equal(r.status, 1, r.out);
    assert.notEqual(r.out, 'ok');
    assert.ok(r.out.length > 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a file that is not a database, or no file at all, is a failure, not a crash', () => {
  const d = tmp();
  try {
    const junk = path.join(d, 'junk.db');
    fs.writeFileSync(junk, Buffer.alloc(8192, 0x41));
    assert.equal(tool(['check', junk]).status, 1);
    const none = tool(['check', path.join(d, 'none.db')]);
    assert.equal(none.status, 1);
    assert.match(none.out, /no such database/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('works on the built-in node:sqlite driver too (ST_SQLITE_DRIVER=node)', { skip: !(() => { try { require('node:sqlite'); return true; } catch { return false; } })() }, () => {
  const d = tmp();
  const { file, db } = liveDb(d, 10);
  try {
    const out = path.join(d, 'snap.db');
    const r = tool(['snapshot', file, out], { ST_SQLITE_DRIVER: 'node', NODE_NO_WARNINGS: '1' });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out, 'ok');
  } finally { db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('backup.sh snapshots through db-tool on a host with no sqlite3 tool at all', () => {
  const d = tmp();
  const { file, db } = liveDb(d, 20);
  try {
    // PATH: node, plus this machine's tools minus sqlite3 (and zstd, which this script does not use).
    const sys = path.join(d, 'sys');
    fs.mkdirSync(sys);
    for (const dir of ['/usr/bin', '/bin']) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (n === 'sqlite3' || fs.existsSync(path.join(sys, n))) continue;
        try { fs.symlinkSync(path.join(dir, n), path.join(sys, n)); } catch { /* skip */ }
      }
    }
    const uploads = path.join(d, 'uploads');
    fs.mkdirSync(uploads);
    fs.writeFileSync(path.join(uploads, 'a.txt'), 'a');
    const backups = path.join(d, 'backups');
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'backup.sh')], {
      encoding: 'utf8',
      env: { PATH: `${path.dirname(process.execPath)}:${sys}`, HOME: d, SCREENTINKER_DIR: ROOT, DB: file, UPLOADS: uploads, BACKUP_DIR: backups },
    });
    const log = fs.readFileSync(path.join(backups, 'backup.log'), 'utf8');
    assert.equal(r.status, 0, r.stdout + r.stderr + log);
    assert.match(log, /db backup ok: remote_display-/);
    assert.doesNotMatch(log, /WARN: node/);
    const snap = fs.readdirSync(backups).find((n) => /^remote_display-.*\.db$/.test(n));
    assert.ok(snap, log);
    const copy = new Database(path.join(backups, snap), { readonly: true });
    assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 20);
    copy.close();
  } finally { db.close(); fs.rmSync(d, { recursive: true, force: true }); }
});

test('the backup, upgrade and updater scripts prefer db-tool over the host sqlite3', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const backup = read('scripts/backup.sh');
  assert.match(backup, /node "\$DB_TOOL" snapshot "\$DB" "\$RAW"/);
  assert.match(backup, /rm -f "\$RAW"/, 'a failed snapshot is discarded');
  const upgrade = read('scripts/upgrade.sh');
  assert.match(upgrade, /node "\$DB_TOOL" snapshot "\$DB" "\$BK"/);
  assert.match(upgrade, /node "\$DB_TOOL" check "\$BK" integrity/);
  assert.match(upgrade, /\[ "\$USE_DB_TOOL" != 1 \] && ! command -v sqlite3/, 'the sqlite3 tool is only demanded when db-tool cannot run');
  const updater = read('scripts/updater/st-updater.sh');
  assert.match(updater, /run_logged node "\$_dbtool" snapshot "\$DB" "\$JOB_BACKUP"/);
  assert.match(updater, /node "\$_dbtool" check "\$JOB_BACKUP" integrity/);
});
