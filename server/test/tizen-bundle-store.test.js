'use strict';

/*
 * The Tizen player's offline store for flattened HTML bundles.
 *
 * ⚠️ WHAT CAN AND CANNOT BE TESTED HERE, SAID PLAINLY. tizen.filesystem does not exist off a panel,
 * so the read/write paths are exercised against a stub of that API — which proves the store calls
 * it correctly and degrades when it is absent, and proves NOTHING about whether a real Samsung
 * runtime behaves the way the stub does. The player has never run on real hardware (tizen/README),
 * and this file does not change that. It guards the parts that are pure logic and the parts that
 * have already broken other shared modules on other platforms.
 *
 * ⚠️ THE EXPORT SHAPE IS ITSELF UNDER TEST. bundle-store.js deliberately assigns a browser global
 * instead of using a UMD `typeof module === 'object'` export, because a runtime that exposes
 * `module` to classic scripts takes the CommonJS branch and never assigns the global — which has
 * silently cost this project transitions, dayparting, mute and video-wall geometry on BrightSign.
 * The load below therefore runs the file the way a PAGE does, with `module` present, and asserts
 * the global still appears.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'tizen', 'js', 'bundle-store.js'), 'utf8');

/** Load bundle-store.js the way the widget does, with an optional tizen.filesystem stub. */
function load(fsStub) {
  const sandbox = {
    self: {},
    // ⚠️ PRESENT ON PURPOSE. This is the BrightSign/nodejs_enabled shape: a classic script that can
    // see `module`. A UMD export would take the CommonJS branch here and never set the global.
    module: { exports: {} },
    exports: {},
    XMLHttpRequest: function () {},
  };
  if (fsStub !== undefined) sandbox.tizen = { filesystem: fsStub };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox.self.BundleStore;
}

/** A minimal in-memory tizen.filesystem: enough surface for the store, no more. */
function stubFs() {
  const files = new Map();
  return {
    files,
    openFile(p, mode) {
      if (mode === 'r' && !files.has(p)) return null;
      let buf = mode === 'r' ? files.get(p) : '';
      return {
        readString: () => buf,
        writeString: (s) => { buf += s; files.set(p, buf); },
        flush: () => {},
        close: () => {},
      };
    },
    pathExists: (p) => files.has(p),
    deleteFile: (p, ok) => { files.delete(p); if (ok) ok(); },
    toURI: (p) => 'file://' + p,
    resolve: (dir, ok) => ok({
      listFiles: () => [...files.keys()]
        .filter((k) => k.indexOf(dir + '/') === 0)
        .map((k) => ({ name: k.slice(dir.length + 1) })),
    }),
  };
}

test('⚠️ it assigns a browser global even when `module` is in scope', () => {
  const store = load(stubFs());
  assert.ok(store, 'BundleStore was not assigned to the global — a UMD export would do exactly this');
  assert.equal(typeof store.load, 'function');
  assert.equal(typeof store.save, 'function');
});

test('a render round-trips through the store', () => {
  const store = load(stubFs());
  const html = '<!doctype html><h1>x</h1>';
  assert.equal(store.save('c1', 7, html), true);
  assert.equal(store.load('c1', 7), html);
});

test('⚠️ a different revision is a MISS, not a stale hit', () => {
  /*
   * After a replace the id, the filename and the URL are all unchanged — the revision is the only
   * thing that can tell a panel its copy is out of date. A store keyed on id alone would serve the
   * previous bundle for ever.
   */
  const store = load(stubFs());
  store.save('c1', 7, '<h1>old</h1>');
  assert.equal(store.load('c1', 8), null);
  assert.equal(store.load('c1', 7), '<h1>old</h1>');
});

test('with no tizen.filesystem at all it reports unavailable and never throws', () => {
  // A URL-Launcher / browser build has no filesystem API. The player must degrade to "no cached
  // copy" and keep playing from the network, not blow up in the render path.
  const store = load(undefined);
  assert.equal(store.available(), false);
  assert.equal(store.load('c1', 1), null);
  assert.equal(store.save('c1', 1, '<h1>x</h1>'), false);
  assert.doesNotThrow(() => store.prune(['c1'], { c1: 1 }));
});

test('a half-supported filesystem is treated as no filesystem', () => {
  // Probing one method and assuming the rest is how a runtime ends up with a cache that half works
  // — the same rule media-cache.js states for its own backend.
  const store = load({ openFile: () => null });   // no pathExists
  assert.equal(store.available(), false);
});

test('an oversized render is refused rather than written', () => {
  const store = load(stubFs());
  const huge = 'x'.repeat(store.MAX_BYTES + 1);
  assert.equal(store.save('c1', 1, huge), false);
  assert.equal(store.load('c1', 1), null);
});

test('the superseded-name rule matches only this bundle, at other revisions', () => {
  const store = load(stubFs());
  assert.equal(store.isSupersededName('abc.1.html', 'abc', 2), true);
  assert.equal(store.isSupersededName('abc.2.html', 'abc', 2), false, 'the current revision is not superseded');
  assert.equal(store.isSupersededName('abcdef.1.html', 'abc', 2), false, 'an id that PREFIXES another must not cross-match');
  assert.equal(store.isSupersededName('abc.1.html.part', 'abc', 2), false);
  assert.equal(store.nameFor('abc', 3), 'abc.3.html');
});

test('prune drops bundles that left the playlist and keeps the ones that did not', () => {
  const stub = stubFs();
  const store = load(stub);
  store.save('keep', 1, '<h1>k</h1>');
  store.save('drop', 1, '<h1>d</h1>');
  store.prune(['keep'], { keep: 1 });
  assert.equal(store.load('keep', 1), '<h1>k</h1>');
  assert.equal(store.load('drop', 1), null);
});

test('⚠️ tizen/config.xml declares NO content-security-policy (#330)', () => {
  /*
   * This assertion is INVERTED from what it used to say, and the inversion is the lesson.
   *
   * It used to require a CSP that granted data:, on the reasoning that a srcdoc-mounted offline
   * bundle is full of data: URIs and the WRT default blocks them. That reasoning came from a
   * measurement taken against the DASHBOARD policy (server/server.js), which unlike the WRT
   * default has no unsafe-inline in script-src. The extrapolation did not hold, and the policy it
   * justified BLACK-SCREENED an OM55B on Tizen 5.0 for the whole 2.0.0 to 2.0.7 range.
   *
   * Proven on hardware: a control build identical to 2.0.7 except with the element deleted
   * rendered correctly on the same panel. So this test now guards the shipped state instead of the
   * theory, and it is deliberately a hard "absent" rather than "present but permissive", because
   * a corrected policy cannot be validated from here. See the comment in tizen/config.xml for the
   * three things that must be measured on a panel before one goes back in.
   */
  const cfg = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'config.xml'), 'utf8');
  const m = cfg.match(/<tizen:content-security-policy>([\s\S]*?)<\/tizen:content-security-policy>/);
  assert.ok(!m, 'a widget CSP black-screened an OM55B on Tizen 5.0 (#330); do not add one without '
    + 'a securitypolicyviolation listener shipped first and a panel to test it on');
});
