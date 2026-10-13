'use strict';

/*
 * #618: a self-hoster whose calendar is on the LAN got "The address is not allowed" with no way to
 * open it. OUTBOUND_ALLOW_HOSTS (names / IPs / CIDRs) and OUTBOUND_ALLOW_PRIVATE (every private
 * range) open private addresses on purpose. Both are off by default, so hosted is unchanged, and
 * cloud metadata stays blocked whatever is set.
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const guard = require('../lib/ssrf-guard');
const endpoint = require('../lib/storage/endpoint-guard');

const saved = { p: process.env.OUTBOUND_ALLOW_PRIVATE, h: process.env.OUTBOUND_ALLOW_HOSTS };
afterEach(() => {
  for (const [k, v] of [['OUTBOUND_ALLOW_PRIVATE', saved.p], ['OUTBOUND_ALLOW_HOSTS', saved.h]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
const set = (priv, hosts) => {
  if (priv === undefined) delete process.env.OUTBOUND_ALLOW_PRIVATE; else process.env.OUTBOUND_ALLOW_PRIVATE = priv;
  if (hosts === undefined) delete process.env.OUTBOUND_ALLOW_HOSTS; else process.env.OUTBOUND_ALLOW_HOSTS = hosts;
};
const refused = (url) => assert.throws(() => guard.parseSafeUrl(url), /blocked/, url);
const allowed = (url) => assert.doesNotThrow(() => guard.parseSafeUrl(url), url);

const METADATA = ['http://169.254.169.254/latest/meta-data/', 'http://169.254.170.2/', 'http://[fd00:ec2::254]/',
  'http://[::ffff:169.254.169.254]/', 'http://100.100.100.200/'];

test('by default every private, loopback and metadata address is refused (hosted unchanged)', () => {
  set(undefined, undefined);
  for (const u of ['http://192.168.1.5/cal.ics', 'http://10.0.0.8/', 'http://127.0.0.1:8080/', 'http://[::1]/',
    'http://[fd12:3456::1]/', 'http://[::ffff:192.168.1.5]/', ...METADATA]) refused(u);
  allowed('https://calendar.google.com/calendar/ical/x/basic.ics');
});

test('OUTBOUND_ALLOW_PRIVATE opens private-network ranges, and nothing else', () => {
  set('1', undefined);
  for (const u of ['http://192.168.1.5/cal.ics', 'http://10.0.0.8/', 'http://172.20.1.1/', 'http://100.64.3.3/',
    'http://127.0.0.1:8080/', 'http://[::1]/', 'http://[fd12:3456::1]/', 'http://[::ffff:192.168.1.5]/']) allowed(u);
  // Not private-network space: still refused.
  for (const u of ['http://0.0.0.0/', 'http://224.0.0.1/', 'http://192.0.2.1/', 'http://[2001:db8::1]/', ...METADATA]) refused(u);
});

test('OUTBOUND_ALLOW_HOSTS opens what it names: hosts, *.suffixes, IPs and CIDRs', () => {
  set(undefined, 'calendar.lan, *.home.arpa, 10.1.2.0/24, 192.168.9.9, fd00:abcd::/32');
  assert.equal(guard.isBlockedFor('192.168.5.5', 'calendar.lan'), false, 'a named host may resolve privately');
  assert.equal(guard.isBlockedFor('192.168.5.5', 'CALENDAR.LAN.'), false, 'case and a trailing dot are ignored');
  assert.equal(guard.isBlockedFor('192.168.5.5', 'ha.home.arpa'), false, '*.suffix');
  assert.equal(guard.isBlockedFor('192.168.5.5', 'other.lan'), true, 'an unnamed host is not');
  assert.equal(guard.isBlockedFor('10.1.2.7', 'anything'), false, 'inside the CIDR');
  assert.equal(guard.isBlockedFor('10.1.3.7', 'anything'), true, 'outside it');
  allowed('http://192.168.9.9/feed');
  refused('http://192.168.9.10/feed');
  assert.equal(guard.isBlockedFor('fd00:abcd::5', 'x'), false, 'a v6 CIDR');
  assert.equal(guard.isBlockedFor('169.254.169.254', 'calendar.lan'), true, '⚠️ metadata, even for a named host');
  set(undefined, '0.0.0.0/0');
  assert.equal(guard.isBlockedFor('169.254.169.254', 'x'), true, '⚠️ metadata, even when everything is listed');
});

test('a real request to a LAN-style calendar: refused by default, served once allowed', async () => {
  const srv = http.createServer((req, res) => { res.setHeader('content-type', 'text/calendar'); res.end('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/cal.ics`;
  try {
    set(undefined, undefined);
    await assert.rejects(guard.guardedRequest(url, { responseType: 'text', timeoutMs: 3000 }), /blocked/);
    set(undefined, '127.0.0.1');
    const r = await guard.guardedRequest(url, { responseType: 'text', timeoutMs: 3000 });
    assert.equal(r.statusCode, 200);
    assert.match(r.text, /BEGIN:VCALENDAR/);
  } finally { srv.close(); }
});

test('the storage / AI / OIDC guard honours the same policy, after its own never-allowed list', async () => {
  set(undefined, undefined);
  assert.throws(() => endpoint.vetRequestHost('10.1.2.7'), /blocked/);
  set(undefined, '10.1.2.0/24');
  assert.doesNotThrow(() => endpoint.vetRequestHost('10.1.2.7'));
  await assert.doesNotReject(endpoint.checkEndpoint('http://10.1.2.7:9000/'));
  set('1', '0.0.0.0/0');
  assert.throws(() => endpoint.vetRequestHost('169.254.169.254'), /blocked/, 'metadata stays refused here too');
});

test('a refused private address says how to allow it on a self-hosted instance, and only there', () => {
  const config = require('../config');
  const { notAllowedMessage } = require('../lib/data-sources/service');
  const was = config.selfHosted;
  try {
    config.selfHosted = true;
    assert.match(notAllowedMessage(), /OUTBOUND_ALLOW_HOSTS/);
    config.selfHosted = false;
    assert.equal(notAllowedMessage(), 'The address is not allowed');
  } finally { config.selfHosted = was; }
});
