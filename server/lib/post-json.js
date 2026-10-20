'use strict';

const http = require('http');
const https = require('https');

/**
 * POST some JSON to the other node.
 *
 * ⚠️ node:https RATHER THAN fetch(), for one reason: the per-edge TLS opt-out has to apply to THIS
 * request too. global fetch() offers no way to relax certificate checking without an undici
 * dispatcher, so enrolling into a self-signed on-prem hub failed at the very first call — while the
 * schema, the UI and the socket all promised the opt-out was available. An option that exists
 * everywhere except the one call that has to happen first is not an option.
 *
 * ⚠️ tlsVerify defaults to TRUE and the caller must ask to turn it off. Nothing here infers it from
 * the failure — retrying insecurely after a certificate error is how an opt-out becomes the default.
 */
function postJson(urlStr, body, { tlsVerify = true, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url')); }
    const payload = Buffer.from(JSON.stringify(body));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      rejectUnauthorized: tlsVerify,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(text); } catch (e) { json = {}; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json });
      });
    });
    // Bounded: an enrollment that hangs must not hold an operator's request open until a proxy
    // times out and shows them a page with no explanation on it.
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { postJson };
