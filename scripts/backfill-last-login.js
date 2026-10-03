#!/usr/bin/env node
'use strict';

/*
 * Backfill users.last_login for accounts the signup path never stamped.
 *
 * WHY THIS EXISTS. POST /api/auth/register issued a session but never wrote last_login (fixed in
 * routes/auth.js). Every account created that way reads as "never logged in" no matter how much
 * the user has since done. On the hosted instance that was 132 of 349 users, 43 of whom had real
 * authenticated activity — publishing playlists, uploading content, assigning devices. Anything
 * that selects accounts by `last_login IS NULL` (admin views, dormancy reports, and in particular
 * CLEANUP/DELETION lists) is therefore reading a column that under-reports, and would take live
 * customers with it.
 *
 * WHAT IT WRITES. For a user with last_login IS NULL who has activity_log rows, last_login is set
 * to their MOST RECENT activity_log timestamp. That is a proxy, not a recovered fact: the true
 * login moment was never recorded and cannot be. Most recent (rather than earliest) is chosen
 * because every consumer of this column treats it as "when was this account last in use", which is
 * the question a cleanup list is actually asking.
 *
 * ⚠️ WHAT IT DELIBERATELY DOES NOT DO. A user with NO activity rows is left NULL. Absence of
 * activity is NOT proof of dormancy: activity_log is not retained for the life of the instance
 * (on the hosted instance it began 2026-06-03, while accounts go back to 2026-03-24), so for any
 * account older than the retention window there is simply no evidence either way. Inventing a
 * timestamp for those would convert "we don't know" into "we do", which is the opposite of what a
 * deletion list needs. They stay NULL and must be judged on other evidence.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   node scripts/backfill-last-login.js --db /path/to/remote_display.db
 *   node scripts/backfill-last-login.js --db /path/to/remote_display.db --apply
 */

const path = require('path');
const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const dbIdx = argv.indexOf('--db');
const DB_PATH = dbIdx !== -1 && argv[dbIdx + 1]
  ? argv[dbIdx + 1]
  : path.join(__dirname, '..', 'server', 'db', 'remote_display.db');

const iso = (t) => (t ? new Date((t > 1e12 ? t : t * 1000)).toISOString().slice(0, 10) : 'never');

const db = new Database(DB_PATH, { readonly: !APPLY });
console.log(`db: ${DB_PATH}`);
console.log(`mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

const total = db.prepare('SELECT COUNT(*) n FROM users').get().n;
const nulls = db.prepare('SELECT COUNT(*) n FROM users WHERE last_login IS NULL').get().n;

// Candidates: never stamped, but demonstrably used the product while authenticated.
const candidates = db.prepare(`
  SELECT u.id, u.email, u.created_at, MAX(a.created_at) AS last_activity, COUNT(a.id) AS events
  FROM users u
  JOIN activity_log a ON a.user_id = u.id
  WHERE u.last_login IS NULL
  GROUP BY u.id
  ORDER BY last_activity DESC
`).all();

const noEvidence = db.prepare(`
  SELECT COUNT(*) n FROM users u
  WHERE u.last_login IS NULL
    AND NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.user_id = u.id)
`).get().n;

console.log(`users total:                 ${total}`);
console.log(`last_login IS NULL:          ${nulls}`);
console.log(`  -> backfillable (have activity): ${candidates.length}`);
console.log(`  -> left NULL (no evidence):      ${noEvidence}\n`);

if (candidates.length) {
  console.log('sample of what would be written (newest activity first):');
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${String(c.email).padEnd(34)} created ${iso(c.created_at)}  ->  last_login ${iso(c.last_activity)}  (${c.events} events)`);
  }
  if (candidates.length > 10) console.log(`  ... and ${candidates.length - 10} more`);
}

if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write these values.');
  db.close();
  process.exit(0);
}

const upd = db.prepare('UPDATE users SET last_login = ? WHERE id = ? AND last_login IS NULL');
const run = db.transaction((rows) => {
  let n = 0;
  for (const r of rows) {
    // activity_log may store ms on some rows; last_login is epoch SECONDS.
    const secs = r.last_activity > 1e12 ? Math.floor(r.last_activity / 1000) : r.last_activity;
    n += upd.run(secs, r.id).changes;
  }
  return n;
});
const changed = run(candidates);
console.log(`\nupdated ${changed} row(s).`);
console.log(`remaining NULL: ${db.prepare('SELECT COUNT(*) n FROM users WHERE last_login IS NULL').get().n} (accounts with no activity evidence — judge these on other signals)`);
db.close();
