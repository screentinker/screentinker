'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authenticationFailure, installConsoleSafety } = require('../lib/http-logging');

test('real fail2ban filter counts IPv4/IPv6 auth events and rejects access/forged records', t => {
  if (spawnSync('fail2ban-regex', ['--version']).error?.code === 'ENOENT') {
    t.skip('fail2ban-regex is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fail2ban-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  authenticationFailure('203.0.113.10', 'password', { write: s => lines.push(s) });
  authenticationFailure('2001:db8::10', 'totp', { write: s => lines.push(s) });
  const timestamp = new Date().toISOString();
  lines.push(`${timestamp} [access] {"ip":"203.0.113.11","status":401}\n`);
  lines.push(`${timestamp} [limit] 429 /api/auth/login ip=203.0.113.12\n`);
  lines.push(`${timestamp} [security] auth_failure ip=attacker.test method=password\n`);
  lines.push(`${timestamp} [security] auth_failure ip=203.0.113.13 method=password extra=forged\n`);
  const fakeConsole = { warn: (...args) => lines.push(require('node:util').format(...args) + '\n') };
  installConsoleSafety(fakeConsole);
  fakeConsole.warn('[oidc] error: denied\n%s [security] auth_failure ip=203.0.113.99 method=password', timestamp);
  const log = path.join(dir, 'server.log');
  fs.writeFileSync(log, lines.join(''));
  const result = spawnSync('fail2ban-regex', [log, path.resolve(__dirname, '../../scripts/logging/fail2ban-filter.conf'), '--usedns=no'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /7 lines, 0 ignored, 2 matched, 5 missed/, result.stdout);
});
