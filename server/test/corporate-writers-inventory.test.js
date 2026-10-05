'use strict';

/*
 * THE WRITER INVENTORY — spec §4.7 / §8.4.
 *
 * About thirty statements write playlist_items / playlist_item_schedules. The nesting work found
 * five of them silently corrupting rows while answering 200, because a new column was a duty at
 * every writer and nobody had a list. This is the list, kept honest: every such statement in the
 * server tree is counted per file and must match test/fixtures/corporate-writers.json, where each
 * file says how the head office lock covers it. A new writer fails here until it is classified.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['routes', 'lib', 'services', 'ws', 'db'];
const WRITE_RE = /(INSERT(?: OR [A-Z]+)? INTO|UPDATE|DELETE FROM) +playlist_item(?:s|_schedules)\b/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every playlist_items / playlist_item_schedules writer is classified', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'corporate-writers.json'), 'utf8'));
  const found = {};
  for (const d of DIRS) {
    for (const f of walk(path.join(ROOT, d))) {
      const n = (fs.readFileSync(f, 'utf8').match(WRITE_RE) || []).length;
      if (n) found[path.relative(ROOT, f).split(path.sep).join('/')] = n;
    }
  }
  for (const [file, n] of Object.entries(found)) {
    const entry = fixture.files[file];
    assert.ok(entry, `${file} writes playlist_items (${n}x) and is not classified in test/fixtures/corporate-writers.json`);
    assert.equal(n, entry.count, `${file}: ${n} writers found, ${entry.count} classified — classify the new one (how does the head office lock cover it?)`);
    assert.ok(entry.coverage && entry.coverage.length > 10, `${file}: coverage must say how it is covered`);
  }
  for (const file of Object.keys(fixture.files)) {
    assert.ok(found[file], `${file} is classified but no longer writes — remove it from the fixture`);
  }
});
