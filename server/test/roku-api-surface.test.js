'use strict';

// The mirror image of brightscript-api-surface.test.js. BrightScript is one language on two
// platforms, and the two object references read almost identically — which is how brightsign/
// shipped with Roku calls in it. roku/ can make the opposite mistake, and a Roku runs it no better.
//
// Unlike brightsign/, roku/ IS compiled and simulated (BrighterScript + brs-node, the "Roku player"
// CI job). This test is the part of that guard that runs with the server suite on Node 20, so a
// BrightSign habit, or a call Roku's certification rejects, fails here even where the Roku tooling
// is not installed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'roku');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'tests' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.brs') || e.name.endsWith('.xml')) out.push(p);
  }
  return out;
}
const FILES = walk(ROOT);

/** Source with BrightScript and XML comments stripped, so prose about a mistake is not the mistake. */
function code(file) {
  let s = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.xml')) s = s.replace(/<!--[\s\S]*?-->/g, '');
  return s.split('\n').filter((l) => !/^\s*'/.test(l)).join('\n');
}

test('there is a Roku app to check', () => {
  assert.ok(FILES.some((f) => f.endsWith('MainScene.brs')), 'roku/components/MainScene.brs is missing');
  assert.ok(fs.existsSync(path.join(ROOT, 'manifest')), 'roku/manifest is missing');
});

// Objects and globals that exist on BrightSign and NOT on Roku.
const BRIGHTSIGN_ONLY = [
  ['roHtmlWidget', 'a Roku has no HTML engine — browser content is a server-rendered frame (/api/player/raster)'],
  ['roBrightPackage', 'BrightSign packaging; a Roku app updates through the Channel Store'],
  ['roNetworkConfiguration', 'BrightSign networking; use roDeviceInfo.GetConnectionInfo()'],
  ['roVideoMode', 'BrightSign display modes; use roDeviceInfo.GetVideoMode()'],
  ['roHashGenerator', 'BrightSign hashing; Roku has roEVPDigest'],
  ['roVideoPlayer', 'legacy; a SceneGraph app plays video with the Video node'],
  ['RebootSystem', 'a Roku app cannot reboot the device'],
];
for (const [name, advice] of BRIGHTSIGN_ONLY) {
  test(`no ${name} in roku/ (${advice})`, () => {
    for (const f of FILES) assert.ok(!code(f).includes(name), `${path.relative(ROOT, f)} uses ${name}: ${advice}`);
  });
}

// Calls Roku certification refuses (keeping the screen awake by faking input; ECP from inside an app).
test('no faked key presses to hold off the screensaver (certification rejects UpdateLastKeyPressTime)', () => {
  for (const f of FILES) assert.ok(!/UpdateLastKeyPressTime/.test(code(f)), `${path.relative(ROOT, f)} calls UpdateLastKeyPressTime`);
});
test('the app does not send ECP to the device it runs on (port 8060)', () => {
  for (const f of FILES) assert.ok(!/:8060\b/.test(code(f)), `${path.relative(ROOT, f)} talks to ECP on :8060`);
});

// Every component file names a script that exists; a missing uri is a blank screen with no error.
test('every <script uri> in a component exists', () => {
  for (const f of FILES.filter((x) => x.endsWith('.xml'))) {
    for (const m of code(f).matchAll(/<script[^>]*uri="([^"]+)"/g)) {
      const uri = m[1];
      const target = uri.startsWith('pkg:/') ? path.join(ROOT, uri.slice(5)) : path.join(path.dirname(f), uri);
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, f)} includes ${uri}, which does not exist`);
    }
  }
});

// The manifest points at images that exist (a missing splash or icon fails certification).
test('manifest images exist', () => {
  const mf = fs.readFileSync(path.join(ROOT, 'manifest'), 'utf8');
  for (const m of mf.matchAll(/=pkg:\/(\S+)/g)) {
    assert.ok(fs.existsSync(path.join(ROOT, m[1])), `manifest references pkg:/${m[1]}, which is missing`);
  }
});

// Time in ms must be LongInteger; an Integer overflows at 24 days of milliseconds.
test('epoch milliseconds are never multiplied into an Integer', () => {
  for (const f of FILES.filter((x) => x.endsWith('.brs'))) {
    const bad = code(f).split('\n').find((l) => /AsSeconds\(\)\s*\*\s*1000(?!&)/.test(l));
    assert.ok(!bad, `${path.relative(ROOT, f)}: "${bad && bad.trim()}" — write 1000& so the product is a LongInteger`);
  }
});
