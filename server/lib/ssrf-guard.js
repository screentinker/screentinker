'use strict';
// SSRF guard for the media proxy. The proxy fetches a customer-supplied URL and re-serves it
// same-origin so a <canvas>/WebGL transition can read it. That makes it an open fetch primitive
// running on the box that also serves the dashboard — so it MUST NOT be reachable to internal /
// loopback / link-local / cloud-metadata targets. We therefore (1) allow only http/https, (2) DNS-
// resolve the host and reject if ANY resolved address is private/reserved (multi-A rebinding), and
// (3) return the vetted addresses so the caller PINS the socket to one of them — a re-resolve at
// connect time can't be rebound to 127.0.0.1/169.254.169.254 after we vetted it. Redirects are
// re-vetted the same way (the caller re-invokes assertSafeUrl on each hop).

const dns = require('dns').promises;
const net = require('net');

class SsrfError extends Error {
  constructor(reason) { super('blocked: ' + reason); this.name = 'SsrfError'; this.reason = reason; }
}

// ---- IPv4 ----
function v4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    const b = Number(part);
    if (!Number.isInteger(b) || b < 0 || b > 255 || !/^\d{1,3}$/.test(part)) return null;
    n = (n * 256) + b;
  }
  return n >>> 0;
}
function inV4(ip, cidr) {
  const [base, bitsStr] = cidr.split('/');
  const ipn = v4ToInt(ip), basen = v4ToInt(base);
  if (ipn === null || basen === null) return false;
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipn & mask) === (basen & mask);
}
// 0.0.0.0/8 (this host), 10/8, 100.64/10 (CGNAT), 127/8 (loopback), 169.254/16 (link-local incl.
// cloud metadata 169.254.169.254), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16,
// 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 (multicast), 240/4 (reserved/broadcast).
const V4_BLOCK = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
function isBlockedV4(ip) { return v4ToInt(ip) === null || V4_BLOCK.some((c) => inV4(ip, c)); }

// ---- IPv6 ----
// Expand any IPv6 text form (compressed ::, dotted-quad tail, hex) to 8 numeric hextets, or null.
function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]; // strip brackets / zone id
  const dotted = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/); // trailing embedded v4 -> 2 hextets
  if (dotted) {
    const v = dotted[2].split('.').map(Number);
    if (v.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = dotted[1] + ((v[0] << 8) | v[1]).toString(16) + ':' + ((v[2] << 8) | v[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(Array(fill).fill('0'), tail);
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (g === '' ? NaN : parseInt(g, 16)));
  if (out.some((x) => Number.isNaN(x) || x < 0 || x > 0xffff)) return null;
  return out;
}
function isBlockedV6(ip) {
  const h = expandV6(ip);
  if (!h) return true; // unparseable → block
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d → vet the embedded v4
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isBlockedV4([(h[6] >> 8) & 255, h[6] & 255, (h[7] >> 8) & 255, h[7] & 255].join('.'));
  }
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    return isBlockedV4([(h[6] >> 8) & 255, h[6] & 255, (h[7] >> 8) & 255, h[7] & 255].join('.'));
  }
  if (h.every((x) => x === 0)) return true;                                  // ::  unspecified
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true;        // ::1 loopback
  if ((h[0] & 0xfe00) === 0xfc00) return true;                              // fc00::/7  unique-local
  if ((h[0] & 0xffc0) === 0xfe80) return true;                              // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true;                             // ff00::/8  multicast
  if (h[0] === 0x2002) return true;                                        // 2002::/16 6to4
  return false;
}

// A resolved address we must never let the proxy connect to.
function isBlockedIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) return isBlockedV4(ip);
  if (v === 6) return isBlockedV6(ip);
  return true; // not a valid literal IP → block
}

// Parse + scheme-check + DNS-resolve + vet EVERY resolved address. Returns { url, addresses } where
// `addresses` are the vetted IPs to pin the socket to. Throws SsrfError on anything unsafe.
async function assertSafeUrl(urlString) {
  let url;
  try { url = new URL(String(urlString)); } catch (e) { throw new SsrfError('bad-url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('bad-scheme');
  if (url.username || url.password) throw new SsrfError('userinfo'); // http://internal@evil.com tricks

  const host = url.hostname.replace(/^\[|\]$/g, '');
  // A literal IP in the URL still gets vetted (no DNS, but same range checks).
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError('blocked-ip:' + host);
    return { url, addresses: [host] };
  }
  let resolved;
  try { resolved = await dns.lookup(host, { all: true, verbatim: true }); }
  catch (e) { throw new SsrfError('dns-fail'); }
  if (!resolved.length) throw new SsrfError('no-address');
  for (const a of resolved) {
    if (isBlockedIp(a.address)) throw new SsrfError('blocked-ip:' + a.address);
  }
  return { url, addresses: resolved.map((a) => a.address) };
}

// Build a `lookup` for http.request that pins to a pre-vetted address, so the socket connects to the
// IP we checked — not a value a rebinding DNS server hands back a second time.
function pinnedLookup(vettedAddresses) {
  const addr = vettedAddresses[0];
  const family = net.isIP(addr);
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; }
    process.nextTick(() => cb(null, addr, family));
  };
}

module.exports = { assertSafeUrl, isBlockedIp, isBlockedV4, isBlockedV6, pinnedLookup, SsrfError };
