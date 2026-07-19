'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl, SsrfError } = require('../lib/ssrf-guard');

const BLOCK = [
  ['bad scheme', 'ftp://example.com/x.png'],
  ['userinfo trick', 'http://internal@8.8.8.8/x.png'],
  ['loopback literal', 'http://127.0.0.1/x.png'],
  ['loopback:port', 'http://127.0.0.1:3001/x.png'],
  ['0.0.0.0', 'http://0.0.0.0/x'],
  ['private 10/8', 'http://10.1.2.3/x'],
  ['private 192.168', 'http://192.168.0.1/x'],
  ['private 172.16', 'http://172.16.5.5/x'],
  ['CGNAT 100.64', 'http://100.64.0.1/x'],
  ['cloud metadata 169.254.169.254', 'http://169.254.169.254/latest/meta-data/'],
  ['v6 loopback', 'http://[::1]/x'],
  ['v6 ULA fc00', 'http://[fc00::1]/x'],
  ['v6 link-local fe80', 'http://[fe80::1]/x'],
  ['v4-mapped loopback', 'http://[::ffff:127.0.0.1]/x'],
  ['localhost (DNS->127.0.0.1)', 'http://localhost:3001/x'],
];
const ALLOW = [
  ['public v4 8.8.8.8', 'http://8.8.8.8/x.png'],
  ['public v4 1.1.1.1 https', 'https://1.1.1.1/x.png'],
  ['public v6', 'http://[2606:4700:4700::1111]/x'],
];

for (const [name, url] of BLOCK) {
  test('BLOCK ' + name, async () => {
    await assert.rejects(() => assertSafeUrl(url), (e) => e instanceof SsrfError, 'expected SsrfError for ' + url);
  });
}
for (const [name, url] of ALLOW) {
  test('ALLOW ' + name, async () => {
    const r = await assertSafeUrl(url);
    assert.ok(r.addresses.length > 0, 'expected vetted addresses for ' + url);
  });
}
