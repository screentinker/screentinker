'use strict';

/*
 * The server's requests to an address an org admin typed (Grafana, Tableau Server).
 *
 * Every resolved address is vetted (lib/storage/endpoint-guard vetAddress) and the socket is pinned
 * to the vetted address (lib/ssrf-guard pinnedLookup), so DNS rebinding cannot walk it elsewhere.
 * Metadata and link-local are refused always; private and loopback only on a connection whose
 * allow_private an operator switched on (lib/bi/connections.js).
 *
 * ⚠️ REDIRECTS ARE NOT FOLLOWED. A Grafana render or a Tableau sign-in does not redirect when it
 * works, and following one would carry the Authorization header to wherever it pointed.
 */

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { vetAddress } = require('../storage/endpoint-guard');
const { pinnedLookup, SsrfError } = require('../ssrf-guard');

async function vetted(url, allowPrivate) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(metadata|metadata\.google\.internal|instance-data)$/i.test(host)) throw new SsrfError('blocked-host');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address); }
    catch { throw new SsrfError('dns-fail'); }
  }
  if (!addrs.length) throw new SsrfError('no-address');
  for (const a of addrs) vetAddress(a, { allowPrivate });
  return addrs;
}

/**
 * @returns {Promise<{status:number, headers:object, body:Buffer}>} — any status; the caller decides.
 * Throws on a refused address, a timeout, or a body over maxBytes.
 */
async function request(urlString, { method = 'GET', headers = {}, body = null, allowPrivate = false, timeoutMs = 20000, maxBytes = 12 * 1024 * 1024 } = {}) {
  const url = new URL(urlString);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SsrfError('bad-scheme');
  if (url.username || url.password) throw new SsrfError('userinfo');
  const addresses = await vetted(url, allowPrivate);
  const bodyBuf = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  const hdrs = { ...headers };
  if (bodyBuf) hdrs['content-length'] = String(bodyBuf.length);
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers: hdrs, lookup: pinnedLookup(addresses), servername: net.isIP(url.hostname) ? undefined : url.hostname }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) { res.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    timer.unref?.();
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** A short, safe description of a failure for an admin — never the request headers. */
function describe(err) {
  if (!err) return 'unknown error';
  if (err.name === 'SsrfError' || /blocked-|bad-scheme|userinfo|dns-fail|no-address/.test(err.message || '')) {
    if (/dns-fail|no-address/.test(err.message)) return 'that address does not resolve';
    return 'that address is on a private or reserved network, which this server does not connect to';
  }
  if (/timed out/.test(err.message || '')) return 'no answer within 20 seconds';
  if (err.code === 'ECONNREFUSED') return 'the connection was refused';
  if (/certificate|SSL|TLS/i.test(err.message || '') || /^ERR_TLS|CERT/.test(err.code || '')) return 'its TLS certificate is not trusted';
  return String(err.message || err).slice(0, 160);
}

module.exports = { request, describe };
