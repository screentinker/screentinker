'use strict';

// Regression guards for two smaller playlist-correctness fixes from the server code review.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const src = fs.readFileSync(require.resolve('../routes/playlists'), 'utf8');

test('#4: the bulk-duplicate selection action is wrapped in a transaction', () => {
  const dup = src.slice(src.indexOf("if (action === 'duplicate')"));
  const body = dup.slice(0, dup.indexOf("if (action === 'duration')"));
  // the INSERT loop must sit inside a db.transaction(...) so a mid-loop throw rolls the batch back.
  assert.match(body, /db\.transaction\(\(\) => \{[\s\S]*INSERT INTO playlist_items[\s\S]*\}\)\(\);/,
    'the duplicate loop must be transactional');
});

test('#7: paste rejects a schedule block with empty days (would never play)', () => {
  // the paste block insert must require a NON-EMPTY days array, like validateBlocks and the discard path.
  const paste = src.slice(src.indexOf("action === 'paste'"));
  assert.match(paste, /!Array\.isArray\(b\.days\) \|\| !b\.days\.length \|\| !b\.start \|\| !b\.end/,
    'paste must require days.length > 0');
});

test('#3: discard restores per-item schedules (structure captures them + re-insert writes them)', () => {
  // structure capture attaches schedules; the discard re-insert writes playlist_item_schedules.
  assert.match(src, /blocks\.length \? \{ \.\.\.rest, schedules: blocks \} : rest/, 'publish captures schedules into structure');
  const discard = src.slice(src.indexOf("router.post('/:id/discard'"));
  assert.match(discard.slice(0, 2500), /INSERT INTO playlist_item_schedules/, 'discard re-inserts schedules');
});
