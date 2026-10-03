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
const http = require('http');
const https = require('https');

class SsrfError extends Error {
  constructor(reason) {
    super('blocked: ' + reason);
    this.name = 'SsrfError';
    this.code = 'ssrf';
    this.reason = reason;
  }
}

class GuardedRequestError extends Error {
  constructor(message, code, statusCode = null) {
    super(message);
    this.name = 'GuardedRequestError';
    this.code = code;
    if (statusCode) this.statusCode = statusCode;
  }
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
// Parse + scheme-check + credentials check + literal IP vet (sync).
// Returns { url, host, normalized, isLiteralIp, addresses? }.
// Throws SsrfError on anything unsafe.
function parseSafeUrl(urlString) {
  const normalized = String(urlString || '').trim().replace(/^webcal:\/\//i, 'https://');
  let url;
  try {
    url = new URL(normalized);
  } catch (e) {
    throw new SsrfError('bad-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('bad-scheme');
  }
  if (url.username || url.password) {
    throw new SsrfError('userinfo'); // http://internal@evil.com tricks
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError('blocked-ip:' + host);
    return { url, host, normalized, isLiteralIp: true, addresses: [host] };
  }
  return { url, host, normalized, isLiteralIp: false };
}

// Parse + scheme-check + DNS-resolve + vet EVERY resolved address. Returns { url, addresses } where
// `addresses` are the vetted IPs to pin the socket to. Throws SsrfError on anything unsafe.
async function assertSafeUrl(urlString) {
  const parsed = parseSafeUrl(urlString);
  if (parsed.isLiteralIp) {
    return { url: parsed.url, addresses: parsed.addresses };
  }

  let resolved;
  try {
    resolved = await dns.lookup(parsed.host, { all: true, verbatim: true });
  } catch (e) {
    throw new SsrfError('dns-fail');
  }
  if (!resolved || !resolved.length) {
    throw new SsrfError('no-address');
  }
  for (const a of resolved) {
    if (isBlockedIp(a.address)) throw new SsrfError('blocked-ip:' + a.address);
  }
  return { url: parsed.url, addresses: resolved.map((a) => a.address) };
}

function pinnedLookup(vettedAddresses) {
  const addrs = (Array.isArray(vettedAddresses) ? vettedAddresses : [vettedAddresses]).filter(Boolean);
  const list = addrs.map((a) => ({ address: a, family: net.isIP(a) }));
  const first = list[0];

  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    /*
     * ⚠️ FAIL CLOSED. An empty vetted list once fell back to 127.0.0.1, which PINNED THE SOCKET
     * TO THIS SERVER'S LOOPBACK on the requested port with no error, on a primitive whose whole
     * job is to keep a request off exactly that address. No current caller passes an empty list;
     * the next one must get an error, not the API.
     */
    if (!first) {
      const err = Object.assign(new Error('pinnedLookup: no vetted address for ' + hostname), { code: 'ENOTFOUND' });
      process.nextTick(() => cb(err));
      return;
    }
    const isAll = Boolean(options && options.all);
    if (isAll) {
      process.nextTick(() => cb(null, list));
    } else {
      process.nextTick(() => cb(null, first.address, first.family));
    }
  };
}

/**
 * Execute an HTTP/HTTPS request with complete SSRF protections:
 * - Scheme enforcement (http/https only)
 * - DNS resolution & private/reserved IP filtering on all resolved addresses
 * - Socket address pinning (defeating DNS rebinding)
 * - SNI / TLS validation against original hostname
 * - Per-hop SSRF validation across redirects
 * - Bounded timeouts (overall deadline and socket idle timer) and optional response size caps
 *
 * @param {string} urlString Target URL
 * @param {object} [options] Request options
 * @param {string} [options.method='GET'] HTTP method
 * @param {object} [options.headers={}] HTTP headers
 * @param {number} [options.maxRedirects=4] Maximum redirect hops to follow
 * @param {number} [options.timeoutMs=10000] Overall request deadline timeout in milliseconds
 * @param {number} [options.idleTimeoutMs] Socket idle timeout in milliseconds (survives into body stream)
 * @param {number} [options.maxBytes] Maximum response body size in bytes
 * @param {object} [options.validators] ETag / Last-Modified conditional headers { etag, lastModified }
 * @param {'stream'|'text'|'buffer'} [options.responseType='stream'] Response format
 * @param {string|Buffer} [options.body] Optional request body (capped at 64KiB)
 * @param {boolean} [options.accept2xx=false] Treat any 2xx as success (webhooks: Discord 204)
 * @returns {Promise<{res?: import('http').IncomingMessage, text?: string, buffer?: Buffer, notModified?: boolean, statusCode: number, headers: object}>}
 */
// Headers that must not survive a cross-origin redirect. Matched case-insensitively.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);
function stripSensitiveHeaders(hdrs) {
  const out = {};
  for (const [k, v] of Object.entries(hdrs || {})) {
    if (!SENSITIVE_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function guardedRequest(urlString, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = { ...(options.headers || {}) };
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 4;
  const timeoutMs = options.timeoutMs || 10000;
  const idleTimeoutMs = options.idleTimeoutMs || null;
  const maxBytes = options.maxBytes || null;
  const validators = options.validators || null;
  const responseType = options.responseType || 'stream';
  const accept2xx = !!options.accept2xx;

  let bodyBuf = null;
  if (options.body != null) {
    bodyBuf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body), 'utf8');
    if (bodyBuf.length > 64 * 1024) {
      return Promise.reject(new GuardedRequestError('Request body too large', 'size-limit'));
    }
    if (headers['content-length'] == null && headers['Content-Length'] == null) {
      headers['content-length'] = String(bodyBuf.length);
    }
  }

  if (validators) {
    if (validators.etag) headers['if-none-match'] = validators.etag;
    if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
  }

  const deadline = Date.now() + timeoutMs;

  const follow = (targetUrl, redirectsLeft, hdrs = headers) => new Promise((resolve, reject) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return reject(new GuardedRequestError('Request timed out', 'timeout'));
    }

    assertSafeUrl(targetUrl).then(({ url, addresses }) => {
      const mod = url.protocol === 'https:' ? https : http;
      let deadlineTimer = null;

      const clearDeadlineTimer = () => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
      };

      const req = mod.request(url, {
        method,
        lookup: pinnedLookup(addresses),
        servername: url.hostname,
        headers: hdrs,
      }, (res) => {
        const sc = res.statusCode;

        if (sc === 304) {
          res.resume();
          clearDeadlineTimer();
          return resolve({ notModified: true, statusCode: 304, headers: res.headers });
        }

        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          clearDeadlineTimer();
          if (redirectsLeft <= 0) {
            return reject(new GuardedRequestError('Too many redirects', 'too-many-redirects'));
          }
          let next;
          try { next = new URL(res.headers.location, url).toString(); }
          catch (_) { return reject(new GuardedRequestError('Invalid redirect location', 'bad-redirect')); }
          // Never carry credentials to a DIFFERENT origin. A redirect to another host (which is
          // re-vetted for SSRF, so any public host is reachable) must not receive the caller's
          // Authorization / Cookie, or a plugin fetch becomes a token-exfiltration channel. This
          // mirrors what the platform fetch() does; same-origin redirects keep the headers.
          let nextHdrs = hdrs;
          try {
            if (new URL(next).origin !== url.origin) nextHdrs = stripSensitiveHeaders(hdrs);
          } catch (_) { nextHdrs = stripSensitiveHeaders(hdrs); }
          return follow(next, redirectsLeft - 1, nextHdrs).then(resolve, reject);
        }

        const ok = accept2xx ? (sc >= 200 && sc < 300) : (sc === 200);
        if (!ok) {
          res.resume();
          clearDeadlineTimer();
          return reject(new GuardedRequestError(`Request failed with status ${sc}`, 'upstream-status', sc));
        }

        if (responseType === 'stream') {
          clearDeadlineTimer();
          return resolve({ res, statusCode: sc, headers: res.headers });
        }

        const chunks = [];
        let total = 0;

        res.on('data', (chunk) => {
          total += chunk.length;
          if (maxBytes !== null && total > maxBytes) {
            clearDeadlineTimer();
            res.destroy(new GuardedRequestError('Response exceeds size limit', 'size-limit'));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          clearDeadlineTimer();
          const buf = Buffer.concat(chunks);
          if (responseType === 'text') {
            resolve({ text: buf.toString('utf8'), statusCode: sc, headers: res.headers });
          } else {
            resolve({ buffer: buf, statusCode: sc, headers: res.headers });
          }
        });

        res.on('error', (err) => {
          clearDeadlineTimer();
          reject(err);
        });
      });

      // Socket idle timeout (remains active through stream body consumption)
      if (idleTimeoutMs) {
        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new GuardedRequestError('Socket idle timeout', 'timeout'));
        });
      }

      // Overall request deadline timeout
      const timeRemaining = Math.max(100, deadline - Date.now());
      deadlineTimer = setTimeout(() => {
        req.destroy(new GuardedRequestError('Request timed out', 'timeout'));
      }, timeRemaining);
      deadlineTimer.unref?.();

      req.on('error', (err) => {
        clearDeadlineTimer();
        reject(err);
      });

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    }, reject);
  });

  return follow(urlString, maxRedirects);
}

module.exports = { parseSafeUrl, assertSafeUrl, isBlockedIp, isBlockedV4, isBlockedV6, pinnedLookup, SsrfError, GuardedRequestError, guardedRequest, stripSensitiveHeaders };

