'use strict';

/*
 * The boot-time dependency check.
 *
 * It exists for the moments nobody is at their best: a rollback that restores an older
 * package.json but not its packages, and a Node upgrade that leaves the native database module
 * compiled against the wrong ABI. Both present as "server will not start", with an error naming a
 * file rather than the action needed.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const preflight = require('../lib/preflight-deps');

test('a healthy install reports nothing missing and nothing broken', () => {
  assert.deepEqual(preflight.missingDeps(), [], 'this tree should be complete');
  assert.equal(preflight.nativeModuleBroken(), null, 'and the native module should load');
});

test('THE NATIVE CHECK CONSTRUCTS A DATABASE, it does not merely require the module', () => {
  /*
   * better-sqlite3's entry point is plain JavaScript that loads the compiled binding lazily, so
   * `require()` SUCCEEDS under a Node whose ABI the binary was never built for. The first version
   * of this check stopped at require and therefore reported a genuinely broken install — verified
   * against a real Node 18 / Node 20 mismatch — as healthy.
   *
   * Pinned as source because the failure is invisible: the check keeps passing, on every machine
   * where nothing is wrong, right up until the one where something is.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'preflight-deps.js'), 'utf8');
  const fn = src.slice(src.indexOf('function nativeModuleBroken'), src.indexOf('function run('));
  assert.match(fn, /new Database\(':memory:'\)/,
    'nativeModuleBroken must open a database, or an ABI mismatch goes undetected');
  assert.ok(!/^\s*require\('better-sqlite3'\);\s*$/m.test(fn), 'a bare require is not a load test');
});

test('missingDeps agrees with what is actually on disk', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const declared = Object.keys(pkg.dependencies || {});
  assert.ok(declared.length > 0, 'the server declares dependencies');
  const reported = preflight.missingDeps();
  for (const name of declared) {
    const present = fs.existsSync(path.join(__dirname, '..', 'node_modules', name, 'package.json'));
    assert.equal(present, !reported.includes(name), `${name}: presence and report disagree`);
  }
});

test('the preflight uses only Node builtins', () => {
  /*
   * It runs BEFORE dependencies are installed, so anything it imported could be the very thing
   * that is missing — and the failure would be the one it exists to prevent, with an extra layer
   * of confusion on top.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'preflight-deps.js'), 'utf8');
  const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const builtins = new Set(['fs', 'path', 'child_process', 'os', 'crypto', 'util']);
  for (const r of requires) {
    // better-sqlite3 is the thing being TESTED for loadability, not a dependency of this file.
    if (r === 'better-sqlite3') continue;
    /*
     * A `node:`-prefixed specifier can ONLY resolve to a builtin - that is what the prefix is for -
     * so it can never be the missing package this file exists to diagnose.
     *
     * `node:sqlite` arrives here as the fallback-driver probe. Note it is genuinely ABSENT on Node
     * 20 and flagged-off on 22.x, which is exactly why preflight requires it inside a try/catch and
     * treats the throw as an answer rather than an error.
     */
    if (r.startsWith('node:')) continue;
    assert.ok(builtins.has(r) || r.startsWith('.'), `preflight must not depend on ${r}`);
  }
});

test('it can be turned off for an air-gapped host', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'preflight-deps.js'), 'utf8');
  assert.match(src, /ST_SKIP_DEP_PREFLIGHT/, 'an operator who manages node_modules must be able to opt out');
  const saved = process.env.ST_SKIP_DEP_PREFLIGHT;
  process.env.ST_SKIP_DEP_PREFLIGHT = '1';
  try { assert.doesNotThrow(() => preflight.preflight(), 'opting out must be a clean no-op'); }
  finally { if (saved === undefined) delete process.env.ST_SKIP_DEP_PREFLIGHT; else process.env.ST_SKIP_DEP_PREFLIGHT = saved; }
});

test('server.js runs the preflight BEFORE requiring anything', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const preflightAt = src.indexOf("require('./lib/preflight-deps')");
  const firstDep = src.indexOf("require('express')");
  assert.ok(preflightAt > -1, 'server.js must run the preflight');
  assert.ok(preflightAt < firstDep, 'it must come before the first dependency, or it cannot help');
});

/*
 * ⚠️ AN OPTIONAL DEPENDENCY IS NOT OPTIONAL ON A HOST WITH NO FALLBACK.
 *
 * better-sqlite3 became optional so a compiler-less host installs cleanly and drops to the built-in
 * node:sqlite. But the built-in is Node 24 in practice — absent on 20.x, flagged off on 22.x — and
 * this project's declared floor is 22.9. On those runtimes a missing better-sqlite3 is not a slower
 * server, it is no server.
 *
 * This is not theoretical: `npm ci` on a machine that declines to run install scripts reported
 * success, silently left no better-sqlite3 on disk, and every test that spawns the server failed
 * with "server did not boot". Preflight has to notice and repair that.
 */
test('an optional dependency counts as required where node:sqlite is unavailable', () => {
  const pkg = { dependencies: { express: '^4' }, optionalDependencies: { 'better-sqlite3': '12.9.0' } };

  const withBuiltin = preflight.requiredDeps(pkg, true);
  assert.deepEqual(withBuiltin, ['express'],
    'on Node 24 the native driver is genuinely optional — the built-in can serve');

  const withoutBuiltin = preflight.requiredDeps(pkg, false);
  assert.deepEqual(withoutBuiltin.sort(), ['better-sqlite3', 'express'],
    'on Node 20/22 a missing native driver means the server cannot start, so repair it');
});

test('requiredDeps copes with a package.json missing either section', () => {
  assert.deepEqual(preflight.requiredDeps({}, false), []);
  assert.deepEqual(preflight.requiredDeps({ optionalDependencies: { a: '1' } }, false), ['a']);
  assert.deepEqual(preflight.requiredDeps({ dependencies: { b: '1' } }, false), ['b']);
});

// ---- installed but OUT OF DATE (an upgrade by git pull + restart) ----

const os = require('node:os');

function fakeTree({ pkg, lock, installed }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-preflight-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...lock } }));
  for (const [key, version] of Object.entries(installed)) {
    fs.mkdirSync(path.join(dir, key), { recursive: true });
    fs.writeFileSync(path.join(dir, key, 'package.json'), JSON.stringify({ version }));
  }
  return dir;
}

test('⚠️ a package that is installed but older than the lockfile is STALE, nested ones too', () => {
  // 2.6.2: git pull + restart kept nodemailer 9 under ^10, and proxy-addr/engine.io underneath.
  const dir = fakeTree({
    pkg: { dependencies: { nodemailer: '^10.1.0', express: '^4.18.2' } },
    lock: {
      'node_modules/nodemailer': { version: '10.1.0' },
      'node_modules/express': { version: '4.22.3' },
      'node_modules/proxy-addr': { version: '2.0.8' },
      'node_modules/get-uri/node_modules/basic-ftp': { version: '6.2.3' },
    },
    installed: {
      'node_modules/nodemailer': '9.0.5',
      'node_modules/express': '4.22.3',
      'node_modules/proxy-addr': '2.0.7',
      'node_modules/get-uri/node_modules/basic-ftp': '5.3.1',
    },
  });
  try {
    const st = preflight.staleDeps(dir).map((d) => `${d.name} ${d.installed}->${d.locked}`).sort();
    assert.deepEqual(st, ['basic-ftp 5.3.1->6.2.3', 'nodemailer 9.0.5->10.1.0', 'proxy-addr 2.0.7->2.0.8']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dev-only, linked and absent optional packages are never stale', () => {
  const dir = fakeTree({
    pkg: { dependencies: {}, devDependencies: { sharp: '^0.35.3' } },
    lock: {
      'node_modules/sharp': { version: '0.35.3', dev: true },
      'node_modules/local-thing': { version: '1.0.0', link: true },
      'node_modules/@img/sharp-darwin-arm64': { version: '0.35.3', optional: true },
      'node_modules/bundled': { version: '2.0.0', inBundle: true },
    },
    installed: { 'node_modules/sharp': '0.30.0', 'node_modules/local-thing': '0.0.1', 'node_modules/bundled': '1.0.0' },
  });
  try { assert.deepEqual(preflight.staleDeps(dir), []); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the repair keeps a developer tree whole and keeps a production tree lean', () => {
  // `npm install --omit=dev` on a populated developer tree PRUNES devDependencies and breaks npm test.
  const prod = fakeTree({ pkg: { dependencies: {}, devDependencies: { sharp: '^0.35.3' } }, lock: {}, installed: {} });
  const dev = fakeTree({ pkg: { dependencies: {}, devDependencies: { sharp: '^0.35.3' } }, lock: {}, installed: { 'node_modules/sharp': '0.35.3' } });
  try {
    assert.equal(preflight.productionTree(prod), true);
    assert.deepEqual(preflight.reconcileArgs(prod), ['install', '--omit=dev', '--no-save', '--no-audit', '--no-fund']);
    assert.equal(preflight.productionTree(dev), false);
    assert.deepEqual(preflight.reconcileArgs(dev), ['install', '--no-save', '--no-audit', '--no-fund']);
    for (const args of [preflight.reconcileArgs(prod), preflight.reconcileArgs(dev)]) {
      assert.ok(!args.includes('ci'), 'never `npm ci` on a populated tree: it deletes node_modules first');
    }
  } finally { for (const d of [prod, dev]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('npm gets a writable cache when the service user has no home', () => {
  // prod's `screentinker` user has no /home directory; npm then dies writing ~/.npm/_logs.
  const env = preflight.npmEnv('/opt/screentinker/server', { HOME: '/nonexistent/home', PATH: '/usr/bin' });
  assert.equal(env.HOME, '/opt/screentinker');
  assert.equal(env.npm_config_cache, '/opt/screentinker/.npm-cache');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is kept');
  const ok = preflight.npmEnv('/x/server', { HOME: os.tmpdir() });
  assert.equal(ok.HOME, os.tmpdir(), 'a writable HOME is left alone');
  assert.equal(ok.npm_config_cache, undefined);
});

test('this checkout itself is not stale (or every boot would reinstall)', () => {
  assert.deepEqual(preflight.staleDeps(), [], 'node_modules should match package-lock.json after npm ci');
});
