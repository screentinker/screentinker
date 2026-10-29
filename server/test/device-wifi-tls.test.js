'use strict';

// #720: the TLS gate in front of Wi-Fi passwords (lib/device-wifi.js isTlsSocket). X-Forwarded-Proto
// counts only from a proxy in the trusted list — on a LAN self-host any host can send the header, and
// believing it from anyone would hand the passwords out over a plain socket to whoever asked nicely.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-wifitls-'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isTlsSocket, cleanMode } = require('../lib/device-wifi');

const sock = (address, { secure = false, proto } = {}) => ({
  handshake: { address, secure, headers: proto ? { 'x-forwarded-proto': proto } : {} },
});

test('native TLS is TLS', () => {
  assert.equal(isTlsSocket(sock('203.0.113.9', { secure: true })), true);
});

test('⚠️ a direct connection cannot claim https with X-Forwarded-Proto', () => {
  assert.equal(isTlsSocket(sock('203.0.113.9', { proto: 'https' })), false);
  assert.equal(isTlsSocket(sock('2001:db8::5', { proto: 'https' })), false);
});

test('a trusted proxy (loopback, LAN, Cloudflare) saying https is believed', () => {
  assert.equal(isTlsSocket(sock('127.0.0.1', { proto: 'https' })), true);
  assert.equal(isTlsSocket(sock('::ffff:127.0.0.1', { proto: 'https' })), true);
  assert.equal(isTlsSocket(sock('10.0.0.2', { proto: 'https' })), true);
  assert.equal(isTlsSocket(sock('172.18.0.3', { proto: 'HTTPS' })), true);
  assert.equal(isTlsSocket(sock('173.245.48.10', { proto: 'https' })), true); // a Cloudflare range
});

test('the FIRST forwarded value is the client\'s scheme (what Express\'s req.protocol reads)', () => {
  assert.equal(isTlsSocket(sock('127.0.0.1', { proto: 'https, http' })), true);
  assert.equal(isTlsSocket(sock('127.0.0.1', { proto: 'http, https' })), false);
});

test('plain, or no handshake at all, is not TLS', () => {
  assert.equal(isTlsSocket(sock('127.0.0.1')), false);
  assert.equal(isTlsSocket(sock('127.0.0.1', { proto: 'http' })), false);
  assert.equal(isTlsSocket(null), false);
  assert.equal(isTlsSocket({}), false);
});

test('wifi_mode keeps only the four modes', () => {
  for (const m of ['owner', 'direct', 'suggestions', 'unsupported']) assert.equal(cleanMode(m), m);
  for (const m of [undefined, null, '', 'OWNER', 'root', 1]) assert.equal(cleanMode(m), null);
});
