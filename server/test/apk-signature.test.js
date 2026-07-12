'use strict';

// #device-owner: the DER walk that pulls the signing cert out of an APK's PKCS#7 v1 block,
// so the provisioning QR checksum is computed from the served build (not hardcoded). Driven by a
// synthetic PKCS#7 SignedData (no APK needed) that exercises both short- and long-form DER lengths
// (real certs are >127 bytes -> long form). The end-to-end value against the real release APK is
// verified at deploy time; this guards the parser against regressions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { _firstCertFromPkcs7 } = require('../lib/apk-signature');

// Minimal DER TLV encoder (definite length, short + long form).
function der(tag, content) {
  let len;
  if (content.length < 0x80) {
    len = Buffer.from([content.length]);
  } else {
    const bytes = [];
    let n = content.length;
    while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function buildPkcs7(certContent1, certContent2) {
  const cert1 = der(0x30, certContent1);                 // first X.509 cert (SEQUENCE)
  const cert2 = der(0x30, certContent2);                 // a second cert we must NOT pick
  const certs = der(0xa0, Buffer.concat([cert1, cert2]));// [0] IMPLICIT certificates
  const signedData = der(0x30, Buffer.concat([
    der(0x02, Buffer.from([0x01])),                      // version
    der(0x31, Buffer.alloc(0)),                          // digestAlgorithms SET (empty)
    der(0x30, Buffer.alloc(0)),                          // encapContentInfo (empty)
    certs,
  ]));
  const oid = der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02])); // signedData OID
  const contentInfo = der(0x30, Buffer.concat([oid, der(0xa0, signedData)]));
  return { pkcs7: contentInfo, cert1 };
}

test('firstCertFromPkcs7 extracts the FIRST cert, exact bytes (short-form lengths)', () => {
  const { pkcs7, cert1 } = buildPkcs7(Buffer.from([0x02, 0x01, 0x2a]), Buffer.from([0x02, 0x01, 0x2b]));
  const got = _firstCertFromPkcs7(pkcs7);
  assert.ok(got, 'a cert was found');
  assert.deepEqual(Buffer.from(got), cert1, 'returns the full DER of cert1, not cert2 or a slice');
});

test('firstCertFromPkcs7 handles long-form lengths (real certs are >127 bytes)', () => {
  const big1 = Buffer.alloc(300, 0xaa);   // forces long-form length at cert + every wrapper
  const big2 = Buffer.alloc(280, 0xbb);
  const { pkcs7, cert1 } = buildPkcs7(big1, big2);
  const got = Buffer.from(_firstCertFromPkcs7(pkcs7));
  assert.deepEqual(got, cert1);
  // And the checksum is a stable base64url(no-pad) SHA-256 of exactly those cert bytes.
  const expect = crypto.createHash('sha256').update(cert1).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const actual = crypto.createHash('sha256').update(got).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(actual, expect);
  assert.match(actual, /^[A-Za-z0-9_-]{43}$/, 'SHA-256 base64url is 43 chars, url-safe, unpadded');
});

test('returns null on garbage / non-PKCS7 input (caller falls back, never emits a wrong QR)', () => {
  assert.equal(_firstCertFromPkcs7(Buffer.from([0x30, 0x00])), null);        // empty SEQUENCE
  assert.equal(_firstCertFromPkcs7(Buffer.from([0x04, 0x01, 0x00])), null);  // not a SEQUENCE-of-signedData
});
