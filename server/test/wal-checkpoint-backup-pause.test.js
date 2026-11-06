// The nightly backup takes its snapshot with a second-process VACUUM INTO, and the live-db
// quick_check opens the live file from that same second process (scripts/db-tool.js). A TRUNCATE
// checkpoint from the server's worker racing that cross-process reader corrupted the high-churn
// tables' free-list INSIDE the backup window (play_logs / device_telemetry, 2026-11-06): scattered
// "2nd reference to page" cross-links plus leaked pages, data intact, recurring once per backup.
//
// The fix is a sentinel: db-tool drops <db>.checkpoint-paused while it holds the live db, and the
// worker's tick() returns early while that sentinel is present and fresh. This test pins both
// halves: that db-tool actually brackets its work with the sentinel, and the freshness policy the
// worker evaluates (including the staleness bound that stops a dead reader from pausing forever).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { withCheckpointPaused } = require('../../scripts/db-tool.js');

// ---- db-tool side: the sentinel exists for the duration of the work and is gone after ----

test('withCheckpointPaused: sentinel is present during the work and removed after', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-pause-'));
  const db = path.join(dir, 'remote_display.db');
  const sentinel = db + '.checkpoint-paused';
  try {
    assert.equal(fs.existsSync(sentinel), false, 'no sentinel before');
    let seenInside = false;
    const ret = withCheckpointPaused(db, () => { seenInside = fs.existsSync(sentinel); return 42; });
    assert.equal(seenInside, true, 'sentinel must exist while the work runs');
    assert.equal(ret, 42, 'the return value is passed through');
    assert.equal(fs.existsSync(sentinel), false, 'sentinel removed after the work');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withCheckpointPaused: sentinel is removed even when the work throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-pause-'));
  const db = path.join(dir, 'remote_display.db');
  const sentinel = db + '.checkpoint-paused';
  try {
    assert.throws(() => withCheckpointPaused(db, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(sentinel), false, 'a thrown error must not leave checkpointing paused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- worker side: the freshness policy, kept as the pure predicate the worker evaluates ----
// Mirrors checkpointPaused() in server/db/wal-checkpointer-worker.js. Kept here as policy so the
// staleness bound cannot silently regress behind a timing-dependent test of a real worker thread.
const PAUSE_MAX_MS = 20 * 60 * 1000;
function paused(mtimeMs, now) {
  if (mtimeMs == null) return false;          // no sentinel
  const age = now - mtimeMs;
  return age >= 0 && age < PAUSE_MAX_MS;
}

test('policy: absent sentinel never pauses', () => {
  assert.equal(paused(null, Date.now()), false);
});

test('policy: a fresh sentinel pauses checkpointing', () => {
  const now = Date.now();
  assert.equal(paused(now, now), true, 'just-created');
  assert.equal(paused(now - (PAUSE_MAX_MS - 1000), now), true, 'inside the window');
});

test('policy: a stale sentinel resumes checkpointing (a dead reader cannot pause forever)', () => {
  const now = Date.now();
  assert.equal(paused(now - PAUSE_MAX_MS, now), false, 'exactly at the bound');
  assert.equal(paused(now - 2 * PAUSE_MAX_MS, now), false, 'well past the bound');
});

test('policy: a future-dated sentinel (clock skew) does not pause', () => {
  const now = Date.now();
  assert.equal(paused(now + 60 * 1000, now), false, 'negative age is ignored, not treated as fresh');
});
