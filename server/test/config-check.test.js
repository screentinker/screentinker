'use strict';

/*
 * lib/config-check.js: the boot warnings for a .env that is not in effect, and for a JWT_SECRET
 * that changed under saved secrets. Both traps hit one self-hoster in sequence: SELF_HOSTED=true in
 * a repository-root .env under pm2 (never read), and the obvious fix, moving that .env into
 * server/, would have applied its JWT_SECRET over the generated one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cc = require('../lib/config-check');

const SERVER = path.join(__dirname, '..');

test('parseEnvFile reads KEY=value the way --env-file does', () => {
  const m = cc.parseEnvFile([
    '# comment', '', 'SELF_HOSTED=true', 'export DOMAIN=example.local', 'QUOTED="a b # not a comment"',
    "SINGLE='x'", 'TRAILING=yes # a comment', '  SPACED = v ', 'not a line',
  ].join('\n'));
  assert.deepEqual(Object.fromEntries(m), {
    SELF_HOSTED: 'true', DOMAIN: 'example.local', QUOTED: 'a b # not a comment', SINGLE: 'x', TRAILING: 'yes', SPACED: 'v',
  });
});

function files(map) {
  return (f) => {
    if (f in map) return map[f];
    const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
  };
}
const SD = '/srv/st/server';

test('⚠️ a repository-root .env under pm2: names the keys not in effect, never the values', () => {
  const w = cc.envFileWarnings({
    serverDir: SD, env: {}, execArgv: [],
    readFile: files({ '/srv/st/.env': 'SELF_HOSTED=true\nJWT_SECRET=hunter2-very-secret\nDOMAIN=x.local\n' }),
  });
  assert.equal(w.length, 1);
  assert.match(w[0], /\/srv\/st\/\.env sets SELF_HOSTED, JWT_SECRET, DOMAIN/);
  assert.match(w[0], /never reads this file/);
  assert.match(w[0], /Do not apply JWT_SECRET/);
  assert.doesNotMatch(w[0], /hunter2|x\.local/, 'values are never logged');
});

test('server/.env is explained by how the server was started', () => {
  const read = files({ '/srv/st/server/.env': 'SELF_HOSTED=true\n' });
  const notLoaded = cc.envFileWarnings({ serverDir: SD, env: {}, execArgv: [], readFile: read });
  assert.match(notLoaded[0], /loaded only by `npm start`/);
  const overridden = cc.envFileWarnings({ serverDir: SD, env: { SELF_HOSTED: 'false' }, execArgv: ['--env-file-if-exists=.env'], readFile: read });
  assert.match(overridden[0], /environment overrides it/);
});

test('a file whose values are all in effect is quiet (e.g. loaded through EnvironmentFile=)', () => {
  const w = cc.envFileWarnings({
    serverDir: SD, env: { SELF_HOSTED: 'true', PORT: '3001' }, execArgv: [],
    readFile: files({ '/srv/st/.env': 'SELF_HOSTED=true\nPORT=3001\n', '/srv/st/server/.env': '# nothing set\n' }),
  });
  assert.deepEqual(w, []);
  assert.deepEqual(cc.envFileWarnings({ serverDir: SD, env: {}, execArgv: [], readFile: files({}) }), [], 'no files, no warning');
});

function store() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
}

test('the first boot records the key; the same secret afterwards is ok', () => {
  const s = store();
  assert.equal(cc.checkSecretKey({ secret: 'a', ...s, certsDir: '/c', readFile: files({}) }).status, 'recorded');
  assert.equal(s.m.get(cc.CHECK_KEY), cc.checkValueFor('a'));
  assert.notEqual(s.m.get(cc.CHECK_KEY), 'a', 'the stored value is not the secret');
  const again = cc.checkSecretKey({ secret: 'a', ...s, certsDir: '/c', readFile: files({}) });
  assert.deepEqual(again, { status: 'ok', messages: [] });
});

test('⚠️ JWT_SECRET set over a generated secret: warns, and names the generated file as the way back', () => {
  const s = store();
  // First boots: no JWT_SECRET, so the server generated certs/.jwt_secret and used it.
  cc.checkSecretKey({ secret: 'generated-123', ...s, certsDir: '/data/certs', envSecret: undefined, readFile: files({}) });
  // Then a .env with its own JWT_SECRET is applied.
  const r = cc.checkSecretKey({
    secret: 'from-dotenv', ...s, certsDir: '/data/certs', envSecret: 'from-dotenv',
    readFile: files({ '/data/certs/.jwt_secret': 'generated-123\n' }),
  });
  assert.equal(r.status, 'changed');
  const all = r.messages.join('\n');
  assert.match(all, /signed out/);
  assert.match(all, /can no longer be decrypted/);
  assert.match(all, /\/data\/certs\/\.jwt_secret/);
  assert.match(all, /remove JWT_SECRET from the server's environment/);
  assert.match(all, /DELETE FROM app_settings WHERE key = 'secretbox_check'/);
  assert.doesNotMatch(all, /generated-123|from-dotenv/, 'secrets are never logged');
  assert.equal(s.m.get(cc.CHECK_KEY), cc.checkValueFor('generated-123'), 'keeps warning until resolved');
});

test('a changed secret with no generated file to go back to says to restore the previous one', () => {
  const s = store();
  cc.checkSecretKey({ secret: 'old', ...s, certsDir: '/c', envSecret: 'old', readFile: files({}) });
  const r = cc.checkSecretKey({ secret: 'new', ...s, certsDir: '/c', envSecret: 'new', readFile: files({}) });
  assert.equal(r.status, 'changed');
  assert.match(r.messages.join('\n'), /restore the previous JWT_SECRET/);
  assert.doesNotMatch(r.messages.join('\n'), /\.jwt_secret/);
});

test('the check value matches the key lib/secretbox.js derives', () => {
  // If secretbox ever changes how it derives its key, this check must change with it, or it will
  // report "unchanged" while saved secrets have in fact become unreadable.
  const src = fs.readFileSync(path.join(SERVER, 'lib', 'secretbox.js'), 'utf8');
  assert.match(src, /createHash\('sha256'\)\.update\(String\(config\.jwtSecret\) \+ ':secretbox-v1'\)/);
});

test('⚠️ a real boot: a changed JWT_SECRET is reported against the generated secret on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-cfgchk-'));
  try {
    const boot = (env) => spawnSync(process.execPath, ['-e', `
      const config = require('./config');
      const appSettings = require('./lib/app-settings');
      const cc = require('./lib/config-check');
      const r = cc.checkSecretKey({ secret: config.jwtSecret, get: (k) => appSettings.get(k, undefined), set: (k, v) => appSettings.set(k, v), certsDir: config.certsDir });
      console.log(JSON.stringify({ status: r.status, messages: r.messages }));
    `], { cwd: SERVER, encoding: 'utf8', timeout: 120000, env: { ...process.env, DATA_DIR: root, JWT_SECRET: '', NODE_ENV: 'test', ...env } });
    const last = (r) => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };

    const first = last(boot({ JWT_SECRET: '' }));
    assert.equal(first.status, 'recorded');
    assert.ok(fs.existsSync(path.join(root, 'certs', '.jwt_secret')), 'the server generated its secret');
    assert.equal(last(boot({ JWT_SECRET: '' })).status, 'ok');
    const changed = last(boot({ JWT_SECRET: 'set-later-by-a-dotenv' }));
    assert.equal(changed.status, 'changed');
    assert.match(changed.messages.join('\n'), new RegExp(path.join(root, 'certs', '.jwt_secret').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
