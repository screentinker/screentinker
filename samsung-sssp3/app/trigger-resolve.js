/*
 * Trigger wire parsing and token resolution — the decision half of the fire path.
 * docs/triggers-design.md §2, §11.
 *
 * Pure and shared on purpose: the player runs this against a datagram or an HTTP body, and Node
 * runs it in tests. A fire path that only exists inside a 5,000-line HTML file is a fire path
 * nobody can test, and this one decides whether an unauthenticated packet from the LAN changes
 * what is on a screen.
 *
 * ⚠️ NOTHING HERE TOUCHES THE NETWORK OR THE DOM. Both transports parse with parseWire(), decide
 * with evaluate(), and only then call the renderer. One decision, two doors.
 */

/** `ST1 <secret> <token>` — one line, ASCII, and nothing else. */
const MAGIC = 'ST1';
const MAX_BYTES = 512;
/* Matches the server-side validator in routes/triggers.js. Printable ASCII, no space, because the
 * payload is space-separated and a token with a space in it cannot survive the wire. */
const TOKEN_RE = /^[\x21-\x7E]{1,64}$/;

/**
 * Parse one raw payload.
 *
 * ⚠️ THE MAGIC IS CHECKED FIRST AND CHEAPLY. On subnet broadcast this socket sees every stray
 * datagram on the LAN — mDNS, discovery chatter, someone's printer. Rejecting on a 3-byte compare
 * before any splitting keeps that free, and keeps the `bad_magic` counter meaningful: it separates
 * "the network is noisy" from "something is talking to us and getting it wrong".
 */
function parseWire(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'malformed' };
  // Byte length, not character length: the cap exists to bound work per datagram.
  const bytes = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length;
  if (bytes > MAX_BYTES) return { ok: false, reason: 'too_large' };

  const line = text.replace(/[\r\n]+$/, '');
  if (line.slice(0, MAGIC.length) !== MAGIC) return { ok: false, reason: 'bad_magic' };

  const parts = line.split(' ');
  // Exactly three fields. Fewer is truncated or missing a secret; more means a token contained a
  // space, which the editor refuses at save time precisely so it cannot happen here.
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [, secret, token] = parts;
  if (!secret || !TOKEN_RE.test(token)) return { ok: false, reason: 'malformed' };
  return { ok: true, secret, token };
}

/**
 * ⚠️ Length-checked compare. Not because a timing attack is the threat — the secret crosses an
 * unauthenticated LAN in cleartext, so anyone positioned to time it can simply read it — but
 * because comparing a 4-byte string to a 64-byte one should cost the same either way and the
 * habit is cheap.
 */
function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * What should happen, given a payload and the triggers this device actually holds.
 *
 * @param text          raw payload, one line
 * @param triggers      the SYNCED, DEVICE-SCOPED list. Scoping happened on the server at sync time;
 *                      a token valid on another screen resolves to nothing here.
 * @param deviceSecret  this device's shared secret
 * @param clearAllToken optional device-level "clear everything" token
 * @param source        'http' | 'udp' — a trigger that does not accept this transport must not fire
 *
 * Every rejection carries a reason from a closed set, because those reasons are the counters an
 * installer reads (§13) and "rejected: 41" without a breakdown answers nothing.
 */
function evaluate({ text, triggers, deviceSecret, clearAllToken, source }) {
  const parsed = parseWire(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  if (!deviceSecret || !secretMatches(parsed.secret, deviceSecret)) {
    return { ok: false, reason: 'bad_secret' };
  }

  if (clearAllToken && parsed.token === clearAllToken) {
    return { ok: true, action: 'clear_all' };
  }

  const list = Array.isArray(triggers) ? triggers : [];
  for (const t of list) {
    if (!t) continue;
    /*
     * ⚠️ THE TRANSPORT GATE IS PER TRIGGER, not just per device. An operator who enables only UDP
     * on an emergency trigger has said something specific — that it is fired by the panel wired to
     * the alarm, not by anything that can reach the box over HTTP. Honouring the device flag alone
     * would quietly widen that.
     */
    const accepts = source === 'udp' ? t.source_udp : t.source_http;
    if (!accepts) continue;
    if (t.match_token && parsed.token === t.match_token) return { ok: true, action: 'fire', trigger: t };
    if (t.clear_token && parsed.token === t.clear_token) return { ok: true, action: 'clear', trigger: t };
  }
  return { ok: false, reason: 'unknown_token' };
}

/**
 * Per-source token bucket.
 *
 * ⚠️ The point is not to stop a determined flood — UDP from the LAN cannot be stopped here — it is
 * to bound the WORK a flood causes, so a chatty or hostile sender cannot turn the screen into a
 * strobe or the log into a firehose. Keyed by source address, with a global ceiling so a spoofed
 * source per packet cannot walk around the per-source limit.
 */
function createRateLimiter({ perSec = 5, burst = 10, globalPerSec = 50 } = {}) {
  const buckets = new Map();
  let gTokens = globalPerSec;
  let gLast = 0;

  return {
    allow(key, now) {
      const t = typeof now === 'number' ? now : 0;
      if (!gLast) gLast = t;
      gTokens = Math.min(globalPerSec, gTokens + ((t - gLast) / 1000) * globalPerSec);
      gLast = t;
      if (gTokens < 1) return false;

      let b = buckets.get(key);
      if (!b) { b = { tokens: burst, last: t }; buckets.set(key, b); }
      b.tokens = Math.min(burst, b.tokens + ((t - b.last) / 1000) * perSec);
      b.last = t;
      if (b.tokens < 1) return false;

      b.tokens -= 1; gTokens -= 1;
      return true;
    },
    // Bounded: a spoofed-source flood would otherwise grow this map without limit, which is a slow
    // leak on the one device nobody is watching.
    prune(now, maxAgeMs = 300000) {
      for (const [k, b] of buckets) if (now - b.last > maxAgeMs) buckets.delete(k);
      return buckets.size;
    },
    get size() { return buckets.size; },
  };
}

/**
 * Which interface address to join the multicast group on.
 *
 * ⚠️ NAMING AN INTERFACE IS NOT OPTIONAL ON A MULTI-HOMED HOST. `addMembership(group)` with no
 * interface lets the OS choose, and on a box with docker bridges, a VPN, or wired + wireless up at
 * once it routinely picks the wrong one. The join succeeds, nothing logs, and the group is simply
 * never received — which is indistinguishable from "the integrator never sent anything", the exact
 * confusion §13 exists to remove.
 *
 * Same filter the player already uses for its reported IP: skip loopback, docker and veth, take the
 * first real IPv4. Deterministic, so a rejoin lands on the same interface the first join used
 * unless the address genuinely moved.
 */
function pickMulticastInterface(interfaces) {
  const ifs = interfaces || {};
  for (const name of Object.keys(ifs)) {
    if (/^(lo|docker|veth|br-|virbr)/.test(name)) continue;
    for (const a of ifs[name] || []) {
      // Node 18+ reports family as 'IPv4'; older builds used the number 4.
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) return a.address;
    }
  }
  return null;
}

const API = { parseWire, evaluate, secretMatches, createRateLimiter, pickMulticastInterface,
              MAGIC, MAX_BYTES, TOKEN_RE };

/*
 * ⚠️ BOTH EXPORTS, UNCONDITIONALLY, AND NOT AS AN IF/ELSE.
 *
 * A node-enabled BrightSign widget is a browser AND a CommonJS context at once. A UMD that tests
 * `module.exports` first and falls back to the global takes the CommonJS branch there, so
 * `window.TriggerResolve` is never assigned and every call site sees undefined — silently. That has
 * already happened in this project to transitions, dayparting, mute and wall geometry. Two
 * independent ifs is what survives it.
 */
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.TriggerResolve = API;
