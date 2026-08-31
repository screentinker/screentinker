'use strict';

/*
 * #307 — closing a play must not SEARCH for the row it just created.
 *
 * ⚠️ THE MEASUREMENT THAT MOTIVATED THIS. deviceSocket closed a play by finding the device's most
 * recent open row: `WHERE device_id = ? AND ended_at IS NULL AND (content_id = ? OR widget_id = ?)
 * ORDER BY started_at DESC, id DESC LIMIT 1`. The LIMIT is a red herring — the ORDER BY forces
 * every matching row to be found and sorted before the first can be returned. On production one
 * device has 377,132 play_logs rows, and that query measured **153ms**, on the event loop, every
 * time that panel advanced an item. A partial index makes it fast; remembering the rowid means
 * there is nothing to search, however much history accumulates.
 *
 * These tests are about CORRECTNESS, not speed. Closing the wrong row is worse than closing it
 * slowly: it ends somebody else's play with a plausible duration and nothing to point at.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-pcr-' + crypto.randomBytes(4).toString('hex'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const SRC = fs.readFileSync(require.resolve('../ws/deviceSocket.js'), 'utf8');

test('⚠️ the fast path closes by rowid, and the search survives as the fallback', () => {
  /*
   * Both halves matter. Without the rowid path every advance pays for a sort; without the fallback,
   * a play this process did not open — after a restart mid-play, or one replayed by the #299
   * offline backfill — could never be closed at all.
   */
  /*
   * The GUARD is asserted, not just the call. A source test that matched only
   * `_closePlayById.run(...)` still passed with the whole branch behind `if (false)` — the exact
   * regression this test exists to catch, and it survived a mutation run until this was tightened.
   */
  assert.match(SRC, /const known = takeOpenPlay\(device_id, content_id \|\| null, widget_id \|\| content_id \|\| null\);\s*\n\s*if \(known != null\) _closePlayById\.run\(completed \? 1 : 0, known\);\s*\n\s*else _closePlay\.run\(/,
    'the rowid path must be taken whenever the row is known, with the search as the else');
  assert.match(SRC, /WHERE rowid = \? AND ended_at IS NULL/, 'the rowid update must not reopen a closed row');
});

test('⚠️ the remembered row is only used when it describes THIS play', () => {
  /*
   * A player can report the end of something this process never saw start. Closing our remembered
   * row for it would end the wrong play, silently, with a believable duration — the failure mode
   * this key check exists to prevent.
   */
  assert.match(SRC, /function takeOpenPlay/, 'the accessor must exist');
  assert.match(SRC, /e\.key === playKey\(contentId, widgetId\) \? e\.rowid : null/,
    'a key mismatch must fall through to the search rather than close the remembered row');
});

test('the remembered row is forgotten whether or not it matched', () => {
  // Otherwise a stale rowid outlives the play it described and a later close could land on it.
  const fn = SRC.match(/function takeOpenPlay[\s\S]*?\n\}/)[0];
  const del = fn.indexOf('openPlayRow.delete');
  const ret = fn.indexOf('e.key === playKey');
  assert.ok(del > 0 && del < ret, 'the delete must happen before the key is compared');
});

test('the map is bounded: one entry per device, cleared on disconnect', () => {
  assert.match(SRC, /rememberOpenPlay\(device_id, cid, wid, info\.lastInsertRowid\)/);
  assert.match(SRC, /openPlayRow\.delete\(currentDeviceId\)/, 'disconnect must forget the row');
});

test('⚠️ the statements are prepared ONCE, not on every advance', () => {
  // They were `db.prepare(...)` inline in the message handler, recompiling the SQL per play.
  for (const name of ['_insertPlay', '_closePlay', '_closePlayById']) {
    const decl = new RegExp(`const ${name} = db\\.prepare\\(`);
    assert.match(SRC, decl, `${name} must be prepared at module scope`);
  }
  /*
   * And none survives inside the play-event handler itself, where it recompiled per advance.
   * Scoped to THAT handler deliberately: other handlers in this file still prepare inline, which is
   * the same smell but not this bug, and widening the assertion would make it fail for reasons
   * #307 never claimed to fix.
   */
  const from = SRC.indexOf("socket.on('device:play-event'");
  const to = SRC.indexOf("socket.on('", SRC.indexOf('\n', from));
  assert.ok(from > 0 && to > from, 'the play-event handler must be findable');
  assert.ok(!/db\.prepare\(/.test(SRC.slice(from, to)),
    'no statement may be prepared inside the play-event handler');
});

test('⚠️ every prepared statement is declared BEFORE it is used', () => {
  /*
   * A const referenced above its declaration is a TDZ ReferenceError at runtime, and this codebase
   * has already shipped one: 1.9.32 threw on EVERY boot and a reboot could not clear it. A green
   * suite cannot see it when the throw is inside a handler, so it is asserted structurally.
   */
  for (const name of ['_insertPlay', '_closePlay', '_closePlayById', 'openPlayRow', 'rememberOpenPlay', 'takeOpenPlay']) {
    const decl = SRC.search(new RegExp(`(const|function) ${name}\\b`));
    assert.ok(decl >= 0, `${name} must be declared`);
    const uses = [...SRC.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].map((m) => m.index);
    const before = uses.filter((i) => i < decl);
    assert.deepEqual(before, [], `${name} is referenced at ${before} before its declaration at ${decl}`);
  }
});

test('the partial index that makes the FALLBACK cheap is a migration', () => {
  // The fallback still runs — after a restart, and for backfilled plays — so it must not be the
  // 153ms version. And a migration, so an upgrade fixes an existing database without a manual step.
  const DB = fs.readFileSync(require.resolve('../db/database.js'), 'utf8');
  assert.match(DB, /CREATE INDEX IF NOT EXISTS idx_play_logs_open ON play_logs\(device_id, started_at DESC, id DESC\) WHERE ended_at IS NULL/);
});
