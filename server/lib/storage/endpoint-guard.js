'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { isBlockedIp, SsrfError } = require('../ssrf-guard');

/*
 * ⚠️ A STORAGE ENDPOINT IS A URL AN ORG ADMIN TYPED, AND THE SERVER CONNECTS TO IT.
 *
 * That is the SSRF shape exactly: on a hosted instance, a tenant who could point a profile at
 * http://169.254.169.254 would have this server fetch its own cloud credentials and — through
 * "test connection" and "list objects" — read the answer back. So every endpoint goes through the
 * same vetting the data-source fetcher uses (lib/ssrf-guard.js), with one deliberate difference:
 *
 *   allowPrivate (per profile, off by default) lets loopback and private-LAN addresses through.
 *   MinIO on the same host, or as `http://minio:9000` on a compose network, is a real deployment and
 *   resolves to exactly the addresses the guard refuses. It is an operator's decision, so only a
 *   platform admin (or anyone on a self-hosted instance) may set it — never a tenant on SaaS.
 *
 * ⚠️ METADATA AND LINK-LOCAL ARE REFUSED EVEN WITH allowPrivate. There is no storage product that
 * lives at 169.254.169.254 or fd00:ec2::254, and that is the address an attacker wants.
 *
 * ⚠️ CHECKED AT CONNECT TIME, NOT ONLY AT SAVE TIME. A hostname that resolved to a public address
 * when the profile was saved can resolve to 127.0.0.1 tomorrow (DNS rebinding). The agents below
 * carry a lookup that vets every resolved address for every new socket, so the SDKs cannot be
 * walked onto a refused address however their own resolution behaves.
 */

const METADATA_V4 = ['169.254.169.254', '100.100.100.200'];

function v4Int(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}
function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4Int(ip) & mask) === (v4Int(base) & mask);
}

/** Canonical compressed text form of an IPv6 literal (WHATWG URL does the normalising). */
function canonV6(ip) {
  try { return new URL(`http://[${String(ip).replace(/^\[|\]$/g, '').split('%')[0]}]`).hostname.slice(1, -1).toLowerCase(); }
  catch (e) { return null; }
}

/** The v4 address embedded in ::ffff:a.b.c.d (in either text form), or null. */
function mappedV4(ip) {
  const c = canonV6(ip);
  if (!c) return null;
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(c);
  if (!m) return null;
  const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** Never reachable, whatever the profile says. */
function isNeverAllowed(ip) {
  const v4 = net.isIPv4(ip) ? ip : mappedV4(ip);
  if (v4) return METADATA_V4.includes(v4) || inCidr4(v4, '169.254.0.0', 16) || inCidr4(v4, '0.0.0.0', 8);
  const s = canonV6(ip);
  if (!s) return true;
  if (s === '::') return true;
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;              // fe80::/10 link-local
  if (s === 'fd00:ec2::254') return true;                     // AWS IMDS over IPv6
  return false;
}

/** Loopback or RFC1918 / CGNAT / ULA — what allowPrivate lets through. */
function isPrivateOrLoopback(ip) {
  const v4 = net.isIPv4(ip) ? ip : mappedV4(ip);
  if (v4) {
    return inCidr4(v4, '127.0.0.0', 8) || inCidr4(v4, '10.0.0.0', 8) || inCidr4(v4, '172.16.0.0', 12)
      || inCidr4(v4, '192.168.0.0', 16) || inCidr4(v4, '100.64.0.0', 10);
  }
  const s = canonV6(ip) || '';
  return s === '::1' || /^f[cd][0-9a-f]{2}:/.test(s);
}

function vetAddress(ip, { allowPrivate = false } = {}) {
  if (!net.isIP(ip)) throw new SsrfError('blocked-ip:' + ip);
  if (isNeverAllowed(ip)) throw new SsrfError('blocked-ip:' + ip);
  if (!isBlockedIp(ip)) return true;
  if (allowPrivate && isPrivateOrLoopback(ip)) return true;
  throw new SsrfError('blocked-ip:' + ip);
}

/** Parse and vet a typed endpoint URL. Returns the URL. Throws SsrfError. */
function parseEndpoint(urlString) {
  let url;
  try { url = new URL(String(urlString || '').trim()); } catch (e) { throw new SsrfError('bad-url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('bad-scheme');
  if (url.username || url.password) throw new SsrfError('userinfo');
  if (url.search || url.hash) throw new SsrfError('bad-url');
  return url;
}

/** Full check: parse, resolve, vet every address. */
async function checkEndpoint(urlString, opts = {}) {
  const url = parseEndpoint(urlString);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) { vetAddress(host, opts); return url; }
  if (/^(metadata|metadata\.google\.internal|instance-data)$/i.test(host)) throw new SsrfError('blocked-host');
  let addrs;
  try { addrs = await dns.promises.lookup(host, { all: true, verbatim: true }); }
  catch (e) { throw new SsrfError('dns-fail'); }
  if (!addrs.length) throw new SsrfError('no-address');
  for (const a of addrs) vetAddress(a.address, opts);
  return url;
}

/** dns.lookup-compatible, vetting what it hands the socket. */
function guardedLookup(opts = {}) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const host = String(hostname).replace(/^\[|\]$/g, '');
    const done = (err, list) => {
      if (err) return cb(err);
      try { for (const a of list) vetAddress(a.address, opts); }
      catch (e) { return cb(Object.assign(new Error('storage endpoint address refused'), { code: 'ECONNREFUSED', name: 'SsrfError' })); }
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    };
    if (net.isIP(host)) return process.nextTick(() => done(null, [{ address: host, family: net.isIP(host) }]));
    dns.lookup(host, { all: true, verbatim: true, family: (options && options.family) || 0 }, done);
  };
}

/*
 * ⚠️ NODE NEVER CALLS `lookup` FOR AN IP LITERAL. A socket to http://127.0.0.1:9000 connects
 * straight to the address, so the guarded agents below cannot see it. Every request therefore also
 * passes its host through this check (a pipeline policy for Azure, SDK middleware for S3), which
 * vets literals and leaves names to the lookup.
 */
function vetRequestHost(host, opts = {}) {
  const h = String(host || '').replace(/^\[|\]$/g, '');
  if (net.isIP(h)) vetAddress(h, opts);
  else if (/^(metadata|metadata\.google\.internal|instance-data)$/i.test(h)) throw new SsrfError('blocked-host');
}

const agentCache = new Map();
/** Keep-alive agents with the guarded lookup. One pair per allowPrivate setting. */
function agentsFor({ allowPrivate = false } = {}) {
  const k = allowPrivate ? 'private' : 'public';
  if (!agentCache.has(k)) {
    const lookup = guardedLookup({ allowPrivate });
    agentCache.set(k, {
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 64, lookup }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 64, lookup }),
    });
  }
  return agentCache.get(k);
}

module.exports = { checkEndpoint, parseEndpoint, vetAddress, vetRequestHost, guardedLookup, agentsFor, isNeverAllowed, isPrivateOrLoopback };
