'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const transitionBundle = require('../lib/transition-bundle');

function compile(source, target) {
  return esbuild.transformSync(source, { loader: 'js', target, minifyWhitespace: true }).code;
}

function assertChrome53Syntax(source, name) {
  assert.equal(compile(source, 'chrome53'), compile(source, 'esnext'), name);
}

const PLAYER = path.join(__dirname, '..', 'player');

function styleBlocks(source) {
  return Array.from(source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g), (m) => m[1]).join('\n');
}

test('legacy player artifacts are current and Chrome 53 compatible', () => {
  const html = fs.readFileSync(path.join(PLAYER, 'legacy.html'), 'utf8');
  const scripts = [
    ['service worker', fs.readFileSync(path.join(PLAYER, 'sw-legacy.js'), 'utf8')],
    ['live publish', fs.readFileSync(path.join(PLAYER, 'live-publish-legacy.js'), 'utf8')],
    ['talk', fs.readFileSync(path.join(PLAYER, 'talk-legacy.js'), 'utf8')],
  ];
  for (const [name, script] of scripts) {
    assertChrome53Syntax(script, name);
  }
  assert.ok(html.indexOf('<script>', html.indexOf('/player/transitions.js')) >= 0,
    'the transformed inline player script is present');
  assert.doesNotMatch(html, /\binset\s*:/, 'legacy player CSS uses four supported edges');
  assert.doesNotMatch(html, /\bgap\s*:/, 'legacy player avoids unsupported flex and grid gap');
  assert.doesNotMatch(styleBlocks(html), /\b[-a-z]+\s*:\s*clamp\(/, 'legacy player avoids CSS clamp');
  assert.doesNotMatch(html, /\.padStart\(/, 'legacy player avoids Chrome 57 String.padStart');
  assert.match(html, /src="\/player\/live-publish-legacy\.js"/);
  assert.match(html, /src="\/player\/talk-legacy\.js"/);
});

test('legacy player dependencies need no Chrome 53 syntax lowering', () => {
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
    ['cache policy', path.join(__dirname, '..', 'lib', 'player-cache-policy.js')],
    ['Socket.IO client', path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.js')],
  ];

  for (const [name, file] of scripts) {
    assertChrome53Syntax(fs.readFileSync(file, 'utf8'), name);
  }
  assertChrome53Syntax(transitionBundle.bundle(), 'transitions');
});

test('the dependency guard detects syntax Chrome 53 cannot parse', () => {
  for (const source of [
    'const copy = { ...source };',
    'class Example { value = 1; }',
    'state ||= nextState;',
  ]) {
    assert.notEqual(compile(source, 'chrome53'), compile(source, 'esnext'), source);
  }
});

test('legacy artifact builder has no uncommitted output', () => {
  const { status, stderr } = require('node:child_process').spawnSync(
    process.execPath,
    [path.join(__dirname, '..', 'scripts', 'build-legacy-player.js'), '--check'],
    { encoding: 'utf8' }
  );
  assert.equal(status, 0, stderr);
});

test('legacy route preserves legacy navigation and serves prebuilt assets', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /IS_LEGACY_PLAYER \? '\/player\/legacy' : '\/player'/);
  assert.match(source, /host \? '&host=' \+ encodeURIComponent\(host\) : ''/);
  assert.match(source, /IS_LEGACY_PLAYER \? '\/sw-legacy\.js' : '\/sw\.js'/);
  assert.match(source, /new URL\(url, window\.location\.href\)\.pathname === serviceWorkerUrl/);
  for (const asset of ['legacy.html', 'sw-legacy.js', 'live-publish-legacy.js', 'talk-legacy.js']) {
    assert.ok(server.includes(asset), `server route serves ${asset}`);
  }
  assert.doesNotMatch(server, /require\(['"]\.\/lib\/legacy-player['"]\)/);
});

test('legacy player responses receive the current server version', () => {
  const legacy = fs.readFileSync(path.join(PLAYER, 'legacy.html'), 'utf8');
  assert.match(legacy, /const PLAYER_VERSION\s*=\s*['"][^'"]+['"]/);
});

test('player-rendered HTML uses layout CSS supported by Chrome 53', () => {
  for (const file of [
    path.join(PLAYER, 'index.html'),
    path.join(__dirname, '..', 'lib', 'slide-render.js'),
    path.join(__dirname, '..', 'lib', 'talk-web.js'),
    path.join(__dirname, '..', 'routes', 'kiosk.js'),
    path.join(__dirname, '..', 'routes', 'widgets.js'),
  ]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\binset\s*:/, file);
    if (file.endsWith('routes/kiosk.js')) {
      const kioskRender = source.slice(source.indexOf("router.get('/:id/render'"), source.indexOf('// Create kiosk page'));
      assert.doesNotMatch(kioskRender, /\?\./, `${file}: optional chaining is not supported by Chrome 53`);
    }
    // ⚠️ One deliberate exception: `.entries` is `display:grid`, which is Chromium 57 — the
    // element is an inert block on a Chrome 53 panel and its gap can never apply there, while
    // removing it cost every modern multi-column directory board its 36px gutter. Everything
    // else must still avoid gap, because flex gap (Chromium 84) DOES change layout on engines
    // that support the flexbox around it.
    assert.doesNotMatch(styleBlocks(source).replace(/\.entries \{[^}]*\}/g, ''), /\bgap\s*:/, file);
    assert.doesNotMatch(styleBlocks(source), /\b[-a-z]+\s*:\s*clamp\(/, file);

    // ⚠️ The sweep that made this player Chrome 53-safe replaced FOUR features, and only three of
    // them were pinned here — so `aspect-ratio` could come back silently, exactly the way the
    // `.entries` column gutter went missing without anything noticing. Pin the rest of the sweep,
    // plus the near neighbours a new rule is most likely to reach for.
    for (const [pattern, chrome, what] of [
      [/\baspect-ratio\s*:/, 88, 'aspect-ratio'],
      [/\b[-a-z]+\s*:\s*min\(/, 79, 'min()'],
      [/\b[-a-z]+\s*:\s*max\(/, 79, 'max()'],
      [/:is\(/, 88, ':is()'],
      [/:where\(/, 88, ':where()'],
      [/\bbackdrop-filter\s*:/, 76, 'backdrop-filter'],
      [/\bcolumn-gap\s*:/, 84, 'column-gap'],
      [/\brow-gap\s*:/, 84, 'row-gap'],
    ]) {
      assert.doesNotMatch(styleBlocks(source), pattern,
        `${file}: ${what} is Chromium ${chrome}; a webOS 4 panel cannot parse it`);
    }
  }
});
