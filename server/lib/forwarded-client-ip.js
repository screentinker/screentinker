'use strict';

/*
 * The real client address, carried across this server's OWN loopback calls.
 *
 * ⚠️ WHY THIS EXISTS. routes/mcp.js runs every tool as an HTTP request to our own API over
 * 127.0.0.1 (deliberately — see the note at the top of that file). So every MCP tool call from every
 * tenant arrived with req.ip = 127.0.0.1: one shared rate-limit bucket for the whole install (tenant
 * B's 30 list_content calls got tenant A's next call a 429) and an activity log that recorded
 * 127.0.0.1 for every action an agent took.
 *
 * The MCP route therefore forwards the caller's address in an internal header, and getClientIp
 * believes it ONLY when all three hold:
 *
 *   1. the TCP peer is loopback — the call really came from a process on this box;
 *   2. the HMAC verifies — the key is random per process and never leaves it, so a client cannot
 *      mint a value, and a reverse proxy on loopback forwarding a client's invented header (the
 *      exact trap CF-Connecting-IP fell into, see services/activity.js) does not get one through;
 *   3. it is fresh and for THIS path — the MAC covers the timestamp and the request path, so a value
 *      lifted from one call cannot be replayed later or against a different endpoint.
 *
 * Anything else and the header is ignored, silently: attribution falls back to the ordinary rules.
 *
 * ⚠️ PER PROCESS, and that is the safe direction. A loopback call answered by a different process
 * (another node on the same box) cannot verify the MAC and simply attributes to 127.0.0.1, which is
 * the old behaviour — never a forged address.
 */

const crypto = require('crypto');
const net = require('net');

const HEADER = 'x-st-forwarded-client';
// A few seconds: a loopback call lands in milliseconds, and anything older is a replay.
const MAX_AGE_MS = 5000;
const KEY = crypto.randomBytes(32);

// The path the MAC is bound to: what was requested, never the query string.
const pathOf = (url) => String(url || '').split('?')[0];

function mac(ip, ts, path) {
  return crypto.createHmac('sha256', KEY).update(`${ip}\n${ts}\n${path}`).digest('hex');
}

/* The header value for a loopback call to `path` on behalf of client `ip`. */
function sign(ip, path, now = Date.now()) {
  return `${ip};${now};${mac(ip, now, pathOf(path))}`;
}

function isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/*
 * The forwarded client address if this request carries a valid one, else null. Reads the TCP peer
 * (req.socket), never req.ip: req.ip is itself derived from headers a client controls.
 */
function verify(req, now = Date.now()) {
  const raw = req && req.headers && req.headers[HEADER];
  if (typeof raw !== 'string' || raw.length > 200) return null;
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return null;
  const parts = raw.split(';');
  if (parts.length !== 3) return null;
  const [ip, tsRaw, given] = parts;
  if (!net.isIP(ip) || !/^\d{1,16}$/.test(tsRaw) || !/^[0-9a-f]{64}$/.test(given)) return null;
  const ts = Number(tsRaw);
  if (Math.abs(now - ts) > MAX_AGE_MS) return null;
  const want = mac(ip, ts, pathOf(req.originalUrl || req.url));
  if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(want, 'hex'))) return null;
  return ip;
}

module.exports = { HEADER, MAX_AGE_MS, sign, verify, isLoopback };
