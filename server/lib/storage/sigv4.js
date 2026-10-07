'use strict';

const crypto = require('crypto');

/*
 * SigV4 QUERY-STRING PRESIGNING FOR A GET, SYNCHRONOUSLY.
 *
 * ⚠️ WHY NOT @aws-sdk/s3-request-presigner. It is async (it awaits credential providers and an
 * async hash), and the place a presigned URL is needed — the device payload built in
 * ws/deviceSocket.js — is synchronous all the way down and is called from a dozen places. Making it
 * async to sign a URL would ripple through every push path in the product. A presign is a pure
 * function of (credentials, time, method, host, path, query); computing it here is forty lines, and
 * test/storage-s3.test.js checks the output against the SDK's own presigner byte for byte, so this
 * cannot drift from what AWS accepts without a red test.
 *
 * GET only, UNSIGNED-PAYLOAD, `host` the only signed header — which is what the SDK presigner emits
 * for GetObject and what every S3-compatible store accepts.
 */

const ALGO = 'AWS4-HMAC-SHA256';

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function enc(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Object keys keep their slashes; each segment is encoded once (S3 does not double-encode). */
function encodeKeyPath(key) { return String(key).split('/').map(enc).join('/'); }

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function amzDate(d) { return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); }

/**
 * @param {object} o
 * @param {string} o.accessKeyId
 * @param {string} o.secretAccessKey
 * @param {string} [o.sessionToken]
 * @param {string} o.region
 * @param {string} o.protocol  'https:' | 'http:'
 * @param {string} o.host      host[:port] the CLIENT will connect to
 * @param {string} o.path      already-encoded path, starting with '/'
 * @param {object} [o.query]   extra query parameters (response-content-type, x-id, ...)
 * @param {number} o.expiresSec
 * @param {Date}   o.date
 */
function presignGetUrl(o) {
  const date = amzDate(o.date);
  const day = date.slice(0, 8);
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const q = {
    ...(o.query || {}),
    'X-Amz-Algorithm': ALGO,
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': date,
    'X-Amz-Expires': String(o.expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  if (o.sessionToken) q['X-Amz-Security-Token'] = o.sessionToken;
  const canonicalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  const canonicalRequest = ['GET', o.path, canonicalQuery, `host:${o.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = [ALGO, date, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + o.secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, o.region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  // Same parameter order as the SDK's presigner emits (signature sorted in with the rest), so a URL
  // from here and one from @aws-sdk/s3-request-presigner are the same string, not merely equivalent.
  q['X-Amz-Signature'] = sig;
  const finalQuery = Object.keys(q).sort().map((k) => `${enc(k)}=${enc(q[k])}`).join('&');
  return `${o.protocol}//${o.host}${o.path}?${finalQuery}`;
}

module.exports = { presignGetUrl, encodeKeyPath, enc };
