'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const prepare = fs.readFileSync(path.join(root, 'prepare.js'), 'utf8');

assert.match(
  prepare,
  /path\.join\(__dirname, ['"]\.\.['"], ['"]server['"], ['"]player['"], ['"]legacy\.html['"]\)/,
  'the native renderer must be derived from the current upstream legacy player'
);
assert.doesNotMatch(
  prepare,
  /path\.join\(app, ['"]index\.html['"]\)/,
  'the stale samsung-sssp3/app/index.html snapshot must not be a renderer source'
);
assert.equal(
  fs.existsSync(path.join(root, 'app', 'index.html')),
  false,
  'a stale renderer snapshot must not remain available for an accidental rollback'
);

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'screentinker-sssp3-renderer-source-'));
const build = spawnSync(process.execPath, [path.join(root, 'prepare.js')], {
  cwd: root,
  env: { ...process.env, ST_ORSAY_OUTPUT: output },
  encoding: 'utf8',
});
assert.equal(build.status, 0, build.stderr);

const generatedHtml = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
assert.doesNotMatch(generatedHtml, /src="\/player\//, 'the packaged renderer must not fetch upstream scripts at runtime');
assert.match(generatedHtml, /id="audioGuideQR"/, 'the current upstream document, not the removed snapshot, is packaged');
assert.match(generatedHtml, /id="NativeDownloader" classid="clsid:SAMSUNG-INFOLINK-DOWNLOAD"/, 'the generated document includes the Orsay downloader plugin required by the native bridge');
assert.match(generatedHtml, /id="NativePlayer" classid="clsid:SAMSUNG-INFOLINK-PLAYER"/, 'the generated document includes the Orsay video plugin required by the native bridge');
const packagedScripts = [...generatedHtml.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
for (const name of packagedScripts) {
  assert.ok(fs.existsSync(path.join(output, name)), 'generated renderer dependency is present: ' + name);
}
const renderer = fs.readFileSync(path.join(output, 'renderer-main.js'), 'utf8');
for (const hook of ['nativeOfflinePlanTick', 'stSetWidgetOffline', 'data-st-widget-local', 'Kiosk] emergency alert']) {
  assert.ok(renderer.includes(hook), 'current renderer and required native hook are both present: ' + hook);
}
assert.match(renderer, /function enterRepairMode\(message\)[\s\S]*clearOwnedState/, 'remote revocation repair mode clears native tenant state');
assert.match(renderer, /nativeOfflinePlanTick\(\)[\s\S]*config\.paired/, 'offline schedule execution requires a valid pairing');
assert.equal((renderer.match(/\bvar offlinePlayOpen = null\b/g) || []).length, 1,
  'the upstream offline proof-of-play state must not be shadowed by the old native preamble');
for (const helper of ['unpair-gate', 'play-order', 'offline-play-queue', 'trigger-resolve', 'media-mute', 'orientation-style', 'wall-geometry', 'player-media-health']) {
  assert.ok(fs.existsSync(path.join(output, helper + '.js')), 'source-derived helper is packaged: ' + helper);
  assert.equal(fs.existsSync(path.join(root, 'app', helper + '.js')), false, 'no frozen native helper snapshot remains: ' + helper);
}
const unpair = fs.readFileSync(path.join(output, 'unpair-gate.js'), 'utf8');
assert.match(unpair, /function storageKeys\(suffix, linkSuffix\)/, 'generated unpair gate keeps the current link namespace contract');
fs.rmSync(output, { recursive: true, force: true });

console.log('Native renderer source of truth is server/player/legacy.html.');
