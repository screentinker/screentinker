#!/usr/bin/env node
'use strict';

/*
 * Snapshot and check the live database through the SAME SQLite the server runs, not the host's
 * sqlite3 command-line tool.
 *
 *   node scripts/db-tool.js snapshot <db> <out>        VACUUM INTO <out>, then quick_check <out>
 *   node scripts/db-tool.js check <db> [quick|integrity]
 *
 * Both print "ok" and exit 0 on success; otherwise they print what SQLite said (up to 20 lines) and
 * exit 1. Usage errors exit 2, so a caller can tell "the database is bad" from "I was called wrong".
 *
 * WHY NOT sqlite3(1). The server opens the database in WAL mode and checkpoints it from a worker
 * thread. A second process that opens the same file with an older SQLite joins that WAL, and every
 * SQLite from 3.7.0 to 3.51.2 carries the WAL-reset bug (fixed 3.51.3, March 2026): two connections
 * writing or checkpointing at the same instant can leave pages the database thinks are copied when
 * they are not. Ubuntu 24.04 ships sqlite3 3.45.1 without that fix. Production's database was
 * corrupted twice in nine days, both times inside the nightly backup window, the only time a 3.45.1
 * connection touched it (2026-10-26, 2026-11-03). better-sqlite3 bundles its own, current SQLite;
 * using it here means the backup and the server agree on the WAL format by construction.
 *
 * VACUUM INTO, not the online-backup API: it is one read transaction, so it finishes on a busy
 * database instead of restarting on every write (see scripts/upgrade.sh). The copy is compacted, so
 * it is smaller than the source; judge it by quick_check, never by size.
 */

const path = require('path');
const fs = require('fs');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: db-tool.js snapshot <db> <out> | check <db> [quick|integrity]');
  process.exit(2);
}

function driver() {
  // The server's own selector: better-sqlite3 when it loads, node:sqlite otherwise.
  return require(path.join(__dirname, '..', 'server', 'db', 'sqlite-driver.js'));
}

function open(file, Database) {
  if (!fs.existsSync(file)) throw new Error(`no such database: ${file}`);
  return new Database(file, { readonly: true, fileMustExist: true });
}

/** Rows of PRAGMA quick_check / integrity_check as strings; ['ok'] when healthy. */
function checkRows(db, kind) {
  const pragma = kind === 'integrity' ? 'integrity_check' : 'quick_check';
  return db.prepare(`PRAGMA ${pragma}`).all().map((r) => String(Object.values(r)[0]));
}

function report(rows) {
  if (rows.length === 1 && rows[0] === 'ok') { console.log('ok'); return 0; }
  console.log(rows.slice(0, 20).join('\n') || 'unreadable');
  return 1;
}

/*
 * Pause the server's off-thread WAL checkpointer while we hold a read transaction on the LIVE
 * database. The snapshot's VACUUM INTO and the live-db check both open a SECOND connection from
 * this process; a TRUNCATE checkpoint racing that cross-process reader corrupted the high-churn
 * tables' free-list inside the nightly backup window (play_logs / device_telemetry, 2026-11-06).
 * We drop a sentinel the worker watches (<db>.checkpoint-paused) for the duration and clear it in
 * the finally. The worker enforces its own staleness bound, so if this process is killed before
 * the finally runs, checkpointing resumes on its own and the WAL never grows unbounded. Checking a
 * snapshot FILE creates a sentinel beside it that no worker watches; it is cleaned up the same way.
 * Creating the sentinel is best-effort: a backup must never fail because the sentinel could not be
 * written (worst case we are back to the old racy behaviour, not worse).
 */
function withCheckpointPaused(file, fn) {
  const sentinel = file + '.checkpoint-paused';
  let made = false;
  try { fs.writeFileSync(sentinel, String(Date.now())); made = true; } catch (_) { /* best effort */ }
  try { return fn(); } finally { if (made) { try { fs.unlinkSync(sentinel); } catch (_) { /* best effort */ } } }
}

function main(argv) {
  const [cmd, a, b] = argv;
  if (cmd === 'check') {
    if (!a) usage('check needs a database');
    const kind = b || 'quick';
    if (kind !== 'quick' && kind !== 'integrity') usage(`unknown check: ${kind}`);
    const { Database } = driver();
    return withCheckpointPaused(a, () => {
      const db = open(a, Database);
      try { return report(checkRows(db, kind)); } finally { db.close(); }
    });
  }
  if (cmd === 'snapshot') {
    if (!a || !b) usage('snapshot needs <db> <out>');
    if (fs.existsSync(b)) usage(`refusing to overwrite ${b}`);   // VACUUM INTO refuses too; say so plainly
    const { Database } = driver();
    withCheckpointPaused(a, () => {
      const src = open(a, Database);
      try { src.prepare('VACUUM INTO ?').run(b); } finally { src.close(); }
    });
    const out = open(b, Database);
    try { return report(checkRows(out, 'quick')); } finally { out.close(); }
  }
  usage(cmd ? `unknown command: ${cmd}` : '');
  return 2;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    console.log(String((e && e.message) || e).split('\n')[0] || 'unreadable');
    process.exitCode = 1;
  }
}

module.exports = { main, checkRows, withCheckpointPaused };
