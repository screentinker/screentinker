'use strict';

/*
 * Azure Blob: what a SCREEN is handed, and that every request goes through the guarded agent.
 *
 *   ⚠️ a screen gets a service SAS for ONE blob, read-only, short-lived — never the account key and
 *      never the operator's own SAS (which may carry write/list over the whole container)
 *   ⚠️ SAS-only credentials -> no presign (proxy instead)
 *   ⚠️ an endpoint override (Azurite, a private name) is not presigned unless a public endpoint is set
 *   ⚠️ the pipeline carries the SSRF-guarded agent: a refused address is refused at connect time
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { AzureBackend, parseConnectionString } = require('../lib/storage/azure');

const KEY = Buffer.from('k'.repeat(64)).toString('base64');
const NOW = new Date('2026-10-06T12:00:00Z');

test('presign: a read-only service SAS for one blob, short TTL, no key in the URL', () => {
  const be = new AzureBackend({ id: 'az', bucket: 'signage', prefix: 'tenant', credentials: { accountName: 'acct', accountKey: KEY } });
  const url = be.presignGet('st/o/w/abc.mp4', { expiresSec: 900, now: NOW });
  const u = new URL(url);
  assert.equal(u.origin, 'https://acct.blob.core.windows.net');
  assert.equal(u.pathname, '/signage/tenant/st/o/w/abc.mp4');
  assert.equal(u.searchParams.get('sp'), 'r', 'read only');
  assert.equal(u.searchParams.get('sr'), 'b', 'scoped to the blob');
  assert.equal(u.searchParams.get('spr'), 'https');
  assert.equal(new Date(u.searchParams.get('se')).getTime(), NOW.getTime() + 900 * 1000);
  assert.ok(u.searchParams.get('sig'));
  assert.ok(!url.includes(KEY) && !url.includes(encodeURIComponent(KEY)), 'the account key never appears');
});

test('presign: SAS-only credentials cannot mint a narrower SAS -> null (served by proxy)', () => {
  const be = new AzureBackend({ id: 'az', bucket: 'signage', credentials: { accountName: 'acct', sasToken: '?sv=2024&ss=b&srt=sco&sp=rwdlac&sig=abc' } });
  assert.equal(be.presignGet('st/x.mp4'), null);
});

test('presign: an endpoint override is not presigned unless a public endpoint is set', () => {
  const azurite = new AzureBackend({ id: 'az', bucket: 'signage', endpoint: 'http://azurite:10000/devstoreaccount1', credentials: { accountName: 'devstoreaccount1', accountKey: KEY } });
  assert.equal(azurite.presignGet('st/x.mp4'), null, 'never hand a TV an internal Docker name');
  const pub = new AzureBackend({ id: 'az', bucket: 'signage', endpoint: 'http://azurite:10000/devstoreaccount1', public_endpoint: 'https://media.example.com/devstoreaccount1', credentials: { accountName: 'devstoreaccount1', accountKey: KEY } });
  assert.match(pub.presignGet('st/x.mp4', { now: NOW }), /^https:\/\/media\.example\.com\/devstoreaccount1\/signage\/st\/x\.mp4\?.*sp=r/);
});

test('connection strings: account, key and endpoint are read from them', () => {
  const cs = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;`;
  assert.equal(parseConnectionString(cs).AccountName, 'devstoreaccount1');
  const be = new AzureBackend({ id: 'az', bucket: 'c', credentials: { connectionString: cs } });
  assert.equal(be.endpointUrl(), 'http://127.0.0.1:10000/devstoreaccount1', 'the endpoint the SSRF check must vet');
  assert.equal(be.accountKey, KEY);
});

test('every request carries the guarded agent: loopback is refused without the opt-in, allowed with it', async () => {
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(404, { 'x-ms-error-code': 'BlobNotFound' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}/devstoreaccount1`;
  try {
    const refused = new AzureBackend({ id: 'a1', bucket: 'c', endpoint, credentials: { accountName: 'devstoreaccount1', accountKey: KEY } });
    await assert.rejects(refused.head('st/x.mp4'));
    assert.equal(hits, 0, 'nothing reached the loopback server');

    const allowed = new AzureBackend({ id: 'a2', bucket: 'c', endpoint, allow_private: 1, credentials: { accountName: 'devstoreaccount1', accountKey: KEY } });
    assert.equal(await allowed.head('st/x.mp4'), null, 'a 404 BlobNotFound is "missing", not an error');
    assert.ok(hits >= 1);
  } finally { srv.close(); }
});
