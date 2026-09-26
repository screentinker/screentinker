'use strict';

/*
 * scripts/upgrade.sh is what a self-hoster runs to move between releases, and the database copy it
 * takes first is the only way back from a bad one. These assert the two properties that copy has to
 * have: it must finish, and it must be checked.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'upgrade.sh'), 'utf8');
const backupBlock = SRC.slice(SRC.indexOf('# Back up the db first'), SRC.indexOf('echo "==> Checking out'));
/*
 * ⚠️ STRIP THE COMMENTS BEFORE ASSERTING SOMETHING IS ABSENT. The comment above this block explains
 * why `.backup` is not used — so an absence test run over the raw text fails on the explanation for
 * the fix rather than on the code. This has now bitten in three separate suites.
 */
const code = backupBlock.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('⚠️ the pre-upgrade backup uses VACUUM INTO, not .backup', () => {
  /*
   * The sqlite3 shell's `.backup` copies every page in one step holding a read lock, so a single
   * write from the running server aborts it and it restarts at page one. On production — 1.4 GB,
   * 33 displays heartbeating — it ran 94% CPU for over eight minutes with the destination frozen at
   * 1227 MB and no error printed, so the upgrade just looked hung. VACUUM INTO finished the same
   * database in under a minute.
   *
   * ⚠️ It fails by LOAD, not by size: the nightly backup of that same database at 03:00 takes about
   * 80 seconds. Any test that only runs against a quiet database will not see this.
   */
  assert.match(backupBlock, /VACUUM INTO/, 'the primary path must be VACUUM INTO');
  const primary = code.slice(0, code.indexOf('else'));
  assert.ok(!/\.backup/.test(primary), '.backup must not be the primary path');
  // It may remain as a fallback for sqlite older than 3.27, but only behind a VERSION check.
  assert.match(backupBlock, /3\.27/, 'the fallback must be gated on the version that added VACUUM INTO');
});

test('⚠️ a VACUUM INTO failure is not blamed on the sqlite version', () => {
  /*
   * The first version fell back on ANY error, and printed "VACUUM INTO unavailable (sqlite3 3.45.1)"
   * when the real fault was an unreadable source database — naming a version that supports it
   * perfectly well and hiding the actual error. Deciding on the version keeps the real failure
   * visible. Same class as the release guard that reported "no JS bundle" for a perfectly good
   * package because its grep had been killed by SIGPIPE.
   */
  assert.match(backupBlock, /sort -V/, 'the branch must be chosen by comparing versions');
  const vacuumLine = code.split('\n').find((l) => l.includes('VACUUM INTO') && l.includes('sqlite3 "$DB"'));
  assert.ok(vacuumLine, 'could not find the VACUUM INTO invocation');
  assert.ok(!/\|\||2>\/dev\/null/.test(vacuumLine),
    'the VACUUM INTO call must not swallow its error or fall through on failure');
});

test('⚠️ the backup is verified, and a bad one stops the upgrade', () => {
  // An unverified backup is not a way back, it is a hope. And the copy is COMPACTED, so it is
  // smaller than the source — size tells you nothing, integrity_check does.
  assert.match(backupBlock, /integrity_check/);
  assert.match(backupBlock, /exit 1/, 'a failed integrity check must abort before anything changes');
  const idx = backupBlock.indexOf('integrity_check');
  assert.ok(backupBlock.indexOf('exit 1', idx) > idx, 'the abort must follow the check');
  // The check has to run before the checkout, or it is guarding nothing.
  assert.ok(SRC.indexOf('integrity_check') < SRC.indexOf('git checkout -q "$TARGET"'));
});
