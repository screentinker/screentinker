'use strict';

/*
 * HTTP Digest authentication (RFC 7616 / 2617) for the cameras that want it instead of, or as well
 * as, the WS-Security UsernameToken: several Hikvision, Dahua and Axis firmwares answer a SOAP POST
 * with `401` + `WWW-Authenticate: Digest ...` and only accept the retry. Pure functions; the caller
 * does the retry through whichever transport reached the camera.
 */

const crypto = require('crypto');

/** The parameters of a `WWW-Authenticate: Digest ...` header, or null when it isn't Digest. */
function parseChallenge(header) {
  const h = Array.isArray(header) ? header.find((x) => /^\s*digest\s/i.test(x)) : header;
  if (typeof h !== 'string' || !/^\s*digest\s/i.test(h)) return null;
  const out = {};
  const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(h.replace(/^\s*digest\s+/i, '')))) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  return out.nonce ? out : null;
}

function hash(alg, s) {
  return crypto.createHash(/sha-?256/i.test(alg) ? 'sha256' : 'md5').update(s, 'utf8').digest('hex');
}

/**
 * The Authorization header answering `challenge` for one request. qop=auth is used when offered (the
 * common case); auth-int is not (no camera seen requires it). cnonce/nc are parameters so tests are
 * deterministic.
 */
function authorization(challenge, { username, password, method, uri, cnonce = crypto.randomBytes(8).toString('hex'), nc = 1 }) {
  const alg = challenge.algorithm || 'MD5';
  const sess = /-sess$/i.test(alg);
  let ha1 = hash(alg, `${username}:${challenge.realm || ''}:${password}`);
  if (sess) ha1 = hash(alg, `${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = hash(alg, `${method}:${uri}`);
  const qops = String(challenge.qop || '').split(',').map((s) => s.trim());
  const ncHex = nc.toString(16).padStart(8, '0');
  const useQop = qops.includes('auth');
  const response = useQop
    ? hash(alg, `${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:auth:${ha2}`)
    : hash(alg, `${ha1}:${challenge.nonce}:${ha2}`);
  const q = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
  const parts = [
    `username=${q(username)}`, `realm=${q(challenge.realm || '')}`, `nonce=${q(challenge.nonce)}`, `uri=${q(uri)}`,
    `algorithm=${alg}`, `response=${q(response)}`,
  ];
  if (challenge.opaque) parts.push(`opaque=${q(challenge.opaque)}`);
  if (useQop) parts.push('qop=auth', `nc=${ncHex}`, `cnonce=${q(cnonce)}`);
  return `Digest ${parts.join(', ')}`;
}

module.exports = { parseChallenge, authorization };
