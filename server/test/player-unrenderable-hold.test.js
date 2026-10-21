'use strict';

/*
 * Web player, an item of a type renderContent does not know (POST /api/content/remote stores
 * mime_type verbatim). It shows "Waiting for content..." and is skipped. A single such item retried
 * every UNKNOWN_ITEM_HOLD_MS; a playlist of SEVERAL such items, with nothing playable among them,
 * "advanced at once" in a 0 ms loop through the same dead items for ever (a play_start each time).
 * It now holds the same way.
 *
 * The real branch of renderContent runs here; scheduleAdvance is recorded.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');

function block(fromText) {
  const at = PLAYER.indexOf(fromText);
  assert.ok(at > 0, `${fromText} not found`);
  let end = PLAYER.indexOf('{', at), depth = 0;
  for (; end < PLAYER.length; end++) {
    if (PLAYER[end] === '{') depth++;
    else if (PLAYER[end] === '}' && --depth === 0) { end++; break; }
  }
  return PLAYER.slice(at, end);
}

function run(playlist, item) {
  const calls = [];
  const fn = new Function('playlist', 'item', 'calls', `
    const UNKNOWN_ITEM_HOLD_MS = 15000;
    const BUNDLE_MIME = 'application/vnd.screentinker.bundle+zip';
    let isPlaying = true;
    function showStatus(m) { calls.push(['status', m]); }
    function nextItem() {}
    function scheduleAdvance(f, ms) { calls.push(['advance', ms]); }
    ${block('function isRenderableItem(')}
    const hasRenderableType = isRenderableItem(item);
    ${block('if (!hasRenderableType) {')}
    calls.push(['rendered']);`);
  fn(playlist, item, calls);
  return calls;
}

const ODD = (n) => ({ content_id: 'x' + n, mime_type: 'application/x-nope' });
const IMG = { content_id: 'img', mime_type: 'image/png' };

test('several items, none playable: hold and retry slowly, never a 0 ms loop', () => {
  const pl = [ODD(1), ODD(2), ODD(3)];
  assert.deepEqual(run(pl, pl[0]), [['status', 'Waiting for content...'], ['advance', 15000]]);
});

test('one unknown item among playable ones still skips at once; a single one holds; a playable item renders', () => {
  const pl = [ODD(1), IMG];
  assert.deepEqual(run(pl, pl[0]).at(-1), ['advance', 0]);
  assert.deepEqual(run([ODD(1)], ODD(1)).at(-1), ['advance', 15000]);
  assert.deepEqual(run(pl, IMG), [['rendered']]);
});
