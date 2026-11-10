'use strict';

/*
 * THE DURATION BOX SHOWS THE DURATION THAT WAS SAVED.
 *
 * Item durations are whole seconds. The editor read the box with parseInt, so 12.5 was saved as
 * 12, but the box went on showing 12.5 until the page was reloaded: what was on screen was not
 * what the screen would play.
 *
 * The invariant: once a typed duration is accepted, the box holds the whole number that was sent.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const view = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'playlists.js'), 'utf8');
const flush = view.slice(view.indexOf("itemsEl.querySelectorAll('.item-duration')"), view.indexOf('await api.updatePlaylistItem(playlistId, itemId, { duration_sec: val });'));

test('an accepted duration is written back to the box before the unchanged check', () => {
  const parseAt = flush.indexOf('const val = parseInt(input.value, 10);');
  const writeAt = flush.indexOf('input.value = String(val);');
  const sameAt = flush.indexOf('if (val === saved) return;');
  assert.ok(parseAt > 0 && writeAt > parseAt, 'the parsed whole number goes back into the box');
  assert.ok(writeAt < sameAt, 'even when it equals what is already saved (12.5 typed over 12)');
});

test('the box asks for whole seconds', () => {
  const inputs = view.match(/<input type="number" step="1" class="input item-duration"[^>]*>/g) || [];
  assert.equal(inputs.length, 2);
  for (const i of inputs) assert.match(i, /step="1"/);
});
