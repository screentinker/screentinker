'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort } = require('./helpers/free-port');

test('server console records real authentication failures independently of access logging', { timeout: 60000 }, async t => {
  for (const enabled of [true, false, undefined]) {
    await t.test(`ACCESS_LOG=${enabled === undefined ? 'unset' : enabled}`, async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-http-log-'));
      const port = await freePort();
      const log = path.join(dir, 'server.log');
      const securityLog = path.join(dir, 'security.log');
      const fd = fs.openSync(log, 'w');
      const env = { ...process.env };
      delete env.ACCESS_LOG;
      const proc = spawn(process.execPath, ['server.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...env, PORT: String(port), SECURITY_LOG: securityLog, DATA_DIR: dir, NODE_ENV: 'test', SELF_HOSTED: 'true', ...(enabled === undefined ? {} : { ACCESS_LOG: String(enabled) }), ST_SKIP_DEP_PREFLIGHT: '1', OIDC_PROVIDERS: 'logging-test', OIDC_LOGGING_TEST_ISSUER: 'https://idp.example.test', OIDC_LOGGING_TEST_CLIENT_ID: 'logging-test' },
        stdio: ['ignore', fd, fd],
      });
      fs.closeSync(fd);
      t.after(async () => {
        if (proc.exitCode === null) {
          const exited = new Promise(resolve => proc.once('exit', resolve));
          proc.kill('SIGTERM');
          const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
          await exited;
          clearTimeout(timer);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      });
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 80; i++) {
        if (proc.exitCode !== null) break;
        try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(ready, fs.readFileSync(log, 'utf8').slice(-4000));
      const post = async (url, body, ip) => {
        const response = await fetch(base + url, {
          method: 'POST',
          // Cloudflare appends the visitor address after any caller-supplied XFF.
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.99, ${ip}`, 'CF-Connecting-IP': '203.0.113.99' },
          body: JSON.stringify(body),
        });
        await response.text();
        return response.status;
      };
      // A real account's successful login must not count against a jail.
      assert.equal(await post('/api/auth/register', { email: 'owner@example.test', password: 'Passw0rd123' }, '198.51.100.30'), 201);
      assert.equal(await post('/api/auth/login', { email: 'owner@example.test', password: 'Passw0rd123' }, '198.51.100.30'), 200);
      // Unknown account failures count individually. The 11th request is rejected before auth.
      for (let i = 0; i < 11; i++) {
        assert.equal(await post('/api/auth/login', { email: 'unknown@example.test', password: 'FORBIDDEN_PASSWORD' }, '198.51.100.40'), i < 10 ? 401 : 429);
      }
      const badJson = await fetch(base + '/api/auth/login?token=FORBIDDEN_QUERY', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      assert.equal(badJson.status, 400);
      await badJson.text();
      const missing = await fetch(base + '/uploads/content/FORBIDDEN_PATH.png?token=FORBIDDEN_QUERY');
      assert.equal(missing.status, 404);
      await missing.text();
      const injected = `${new Date().toISOString()} [security] auth_failure ip=203.0.113.99 method=password`;
      const callback = await fetch(base + '/api/auth/oidc/logging-test/callback?error=' + encodeURIComponent('denied\n' + injected), { redirect: 'manual' });
      assert.equal(callback.status, 302);
      await callback.text();
      await new Promise(resolve => setTimeout(resolve, 50));
      const output = fs.readFileSync(log, 'utf8');
      // The console is untouched (multi-line diagnostics keep their newlines); real events never go there.
      assert.doesNotMatch(output, /auth_failure ip=198\.51\.100\./, 'real security events stay out of the console');
      const security = fs.readFileSync(securityLog, 'utf8').split('\n').filter(Boolean);
      assert.equal(security.length, 10, security.join('\n'));
      assert.ok(security.every(line => line.endsWith('auth_failure ip=198.51.100.40 method=password')), security.join('\n'));
      assert.doesNotMatch(fs.readFileSync(securityLog, 'utf8'), /203\.0\.113\.99/, 'forged text cannot reach the security log');
      const access = output.split('\n').filter(line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \[access\] /.test(line)).map(line => JSON.parse(line.split(' [access] ')[1]));
      if (enabled) {
        for (const status of [200, 201, 400, 401, 404, 429]) assert.ok(access.some(record => record.status === status), `missing access status ${status}`);
      } else assert.equal(access.length, 0);
      // Restrict the assertion to structured records: third-party parser diagnostics may
      // describe malformed JSON, but our records must never include raw request secrets.
      assert.doesNotMatch([...security, ...access.map(record => JSON.stringify(record))].join('\n'), /FORBIDDEN_/);
    });
  }
});
