'use strict';

/*
 * #667 follow-up: the weather source's language list is the weather's, not the dashboard's.
 *
 * ⚠️ THE BUG THIS PINS. 3.0.2 shipped Danish weather words (weather-i18n/da.json) but the Weather
 * form's Language dropdown reused getAvailableLanguages(), the DASHBOARD's languages, which have no
 * Danish. So the language existed and could not be chosen. The reporter asked whether npm install
 * had missed a step.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');

const ROOT = path.join(__dirname, '..', '..');
const VIEW = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'views', 'data-sources.js'), 'utf8');
const WEATHER_FILES = fs.readdirSync(path.join(__dirname, '..', 'lib', 'data-sources', 'weather-i18n'))
  .filter((f) => /^[a-z]{2,3}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-wx-lang-'));
let BASE;
let proc;

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_REGISTRATION;
  Object.assign(env, { DATA_DIR: path.join(TMP, 'data'), SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JWT_SECRET: 'wx-' + crypto.randomBytes(8).toString('hex') });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));
});

after(() => {
  if (proc) proc.kill('SIGKILL');
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /api/data-sources/weather-languages lists every weather-i18n file, Danish included', async () => {
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'wx@lang.local', password: 'Passw0rd123!', createOrg: true }),
  });
  assert.equal(reg.status, 201);
  const { token } = await reg.json();
  const r = await fetch(BASE + '/api/data-sources/weather-languages', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const { languages } = await r.json();
  assert.deepEqual(languages, WEATHER_FILES);
  assert.ok(languages.includes('da'), 'Danish is a weather language');
});

test('the route needs a signed-in user, like the rest of /api/data-sources', async () => {
  const r = await fetch(BASE + '/api/data-sources/weather-languages');
  assert.equal(r.status, 401);
});

test('the Weather form builds its Language list from the weather languages, not the dashboard list', () => {
  assert.match(VIEW, /<select id="dsWxLocaleInput" class="input">\$\{weatherLangOptions\(/,
    'the weather select uses weatherLangOptions');
  assert.match(VIEW, /api\('\/data-sources\/weather-languages'\)/, 'it asks the server which languages exist');
  assert.match(VIEW, /if \(cur && !list\.includes\(cur\)\) list\.push\(cur\)/, 'a saved language is never dropped from the list');
});
