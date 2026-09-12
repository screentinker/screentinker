'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const legacyPlayer = require('../lib/legacy-player');
const transitionBundle = require('../lib/transition-bundle');

function executableCode(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
}

const chrome53Breakers = /\?\.(?!\d)|\?\?(?![=?])|\basync\s+(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|\bawait\s+|catch\s*\{/;

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

test('legacy player dependencies remain Chrome 53 syntax compatible', () => {
  const scripts = [
    ['debug overlay', path.join(__dirname, '..', 'player', 'debug-overlay.js')],
    ['ST bridge', path.join(__dirname, '..', '..', 'brightsign', 'st-bridge.js')],
    ['ST sync', path.join(__dirname, '..', '..', 'brightsign', 'st-sync.js')],
    ['schedule evaluator', path.join(__dirname, '..', 'lib', 'schedule-eval.js')],
    ['offline play queue', path.join(__dirname, '..', 'lib', 'offline-play-queue.js')],
    ['trigger resolver', path.join(__dirname, '..', 'lib', 'trigger-resolve.js')],
    ['media mute', path.join(__dirname, '..', 'lib', 'media-mute.js')],
    ['orientation style', path.join(__dirname, '..', 'lib', 'orientation-style.js')],
    ['wall geometry', path.join(__dirname, '..', 'lib', 'wall-geometry.js')],
    ['media health', path.join(__dirname, '..', 'lib', 'player-media-health.js')],
  ];

  for (const [name, file] of scripts) {
    assert.doesNotMatch(executableCode(fs.readFileSync(file, 'utf8')), chrome53Breakers, name);
  }
  assert.doesNotMatch(executableCode(transitionBundle.bundle()), chrome53Breakers, 'transitions');
});
