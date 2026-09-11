'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacyPlayer = require('../lib/legacy-player');

test('legacy player lowers syntax unsupported by Chrome 53', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const html = legacyPlayer.html(source);
  const start = html.indexOf('<script>', html.indexOf('/player/transitions.js'));
  const end = html.indexOf('\n  </script>', start);
  const script = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(script, /\?\.|\?\?|\basync\b|\bawait\b|catch\s*\{/);
  assert.doesNotMatch(html, /inset:\s*0/);
});
