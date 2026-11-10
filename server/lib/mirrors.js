'use strict';

/*
 * 3.0 display-link MIRRORS (docs/web-player.md).
 *
 * A display link (`/player?k=…`) is a credential for ONE display. People open it in more than one
 * place on purpose — a lobby TV and the reception PC, Chrome and Firefox on the same box — and until
 * now every opening registered as that same display: each registration evicted the previous socket,
 * the evicted player reconnected about 45 seconds later and evicted back, and the screens took turns
 * showing content while the other said "Waiting for content" and remote view flipped between them.
 *
 * Now a second opening of a link, from a DIFFERENT install while the display is live, becomes a
 * MIRROR: an additive device row linked to the original by `mirror_of`. It has everything that is
 * about a physical screen of its own — socket, online/offline, heartbeat, screenshots and live view,
 * screen verification, proof-of-play, energy — and nothing that is about content: its payload is the
 * original's (ws/deviceSocket.js buildPlaylistPayload), and every push to the original is repeated
 * to its mirrors (lib/command-queue.js). It counts as a screen for plan limits.
 *
 * `mirror_fingerprint` is the per-install fingerprint that owns the row, so the same browser
 * reopening the link (a reload, a reboot) comes back as the SAME mirror, never a new one.
 *
 * Pure helpers + small DB accessors only. No sockets here, so the screen-share work can call
 * mirrorsOf() without dragging the device socket in.
 */

const crypto = require('crypto');
const { db } = require('../db/database');

// A mirror never becomes the source of another mirror: links are always to the ORIGINAL.
const MAX_MIRRORS_PER_DISPLAY = 25;

/** The mirror rows of a display (never the display itself). [] for a mirror or an unknown id. */
function mirrorsOf(deviceId) {
  if (!deviceId) return [];
  try {
    return db.prepare(`SELECT id, name, status, last_heartbeat, ip_address, mirror_location, created_at
                       FROM devices WHERE mirror_of = ? ORDER BY created_at ASC, id ASC`).all(String(deviceId));
  } catch (e) { return []; }   // a DB from before the migration has no column: no mirrors
}

/** The original a mirror follows, or null when `deviceId` is not a mirror. */
function sourceOf(deviceId) {
  if (!deviceId) return null;
  try {
    const row = db.prepare('SELECT mirror_of FROM devices WHERE id = ?').get(String(deviceId));
    return (row && row.mirror_of) || null;
  } catch (e) { return null; }
}

/** The mirror of `originalId` owned by this install, or null. */
function findMirror(originalId, fingerprint) {
  if (!originalId || !fingerprint) return null;
  try {
    return db.prepare('SELECT * FROM devices WHERE mirror_of = ? AND mirror_fingerprint = ?').get(String(originalId), String(fingerprint)) || null;
  } catch (e) { return null; }
}

/*
 * "Chrome on Windows", "Firefox on Linux", "Safari on iOS". Deliberately coarse: it is a hint that
 * lets a person tell their openings apart, not an inventory. HeadlessChrome reads as Chrome.
 */
function describeAgent(userAgent) {
  const ua = String(userAgent || '');
  let browser = null;
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/(Headless)?Chrom(e|ium)\//.test(ua)) browser = 'Chrome';
  else if (/Version\/[\d.]+.*Safari\//.test(ua)) browser = 'Safari';
  let os = null;
  if (/Windows NT/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Tizen/.test(ua)) os = 'Tizen';
  else if (/Web0S|webOS/.test(ua)) os = 'webOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

/** One line for the dashboard: "Chrome on Windows · 10.0.0.5". Never empty. */
function describeLocation(userAgent, ip) {
  const { browser, os } = describeAgent(userAgent);
  const who = browser && os ? `${browser} on ${os}` : (browser || os || 'Browser');
  const addr = ip ? String(ip).replace(/^::ffff:/, '') : '';
  return addr ? `${who} · ${addr}` : who;
}

/*
 * Plan limit for one more screen on the original's owner. A mirror occupies a screen, so it is
 * held to the same count checkDeviceLimit uses for pairing. null = room; otherwise the refusal.
 */
function limitRefusal(original) {
  try {
    if (!original) return null;
    const limits = require('../middleware/subscription');
    const subject = limits.limitSubject(original.user_id, original.workspace_id);   // per person, or per organization
    if (!subject.userId) return null;
    const plan = limits.subjectPlan(subject);
    if (!plan || plan.max_devices === -1 || !(plan.max_devices > 0)) return null;
    const count = limits.subjectDeviceCount(subject);
    if (count < plan.max_devices) return null;
    return { reason: 'mirror_limit', limit: plan.max_devices,
      error: `This display link is already showing somewhere else, and showing it here too needs one more screen on the plan (limit ${plan.max_devices}).` };
  } catch (e) { return null; }   // a broken plan lookup must not strand the original's link
}

/*
 * Create the mirror row for `original`, owned by `fingerprint`. Returns { mirror } or
 * { refused: { reason, error } }. The caller (the device socket) has already decided that this is a
 * different install opening the link while the original is live.
 */
function createMirror(original, { fingerprint, userAgent, ip } = {}) {
  if (!original || !fingerprint) return { refused: { reason: 'mirror_unavailable', error: 'This display link is already showing somewhere else.' } };
  const existing = mirrorsOf(original.id);
  if (existing.length >= MAX_MIRRORS_PER_DISPLAY) {
    return { refused: { reason: 'mirror_limit', error: `This display link is already showing in ${existing.length + 1} places, the most one link can show in.` } };
  }
  const refusal = limitRefusal(original);
  if (refusal) return { refused: refusal };

  const taken = new Set(existing.map((m) => m.name));
  let n = existing.length + 1;
  const base = original.name || 'Display';
  while (taken.has(`${base} (mirror ${n})`)) n++;
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const location = describeLocation(userAgent, ip);
  // offline until the socket that asked for it registers a moment later, like a web-player display.
  db.prepare(`INSERT INTO devices (id, name, user_id, workspace_id, status, device_token, ip_address,
                mirror_of, mirror_fingerprint, mirror_location, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'offline', ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))`)
    .run(id, `${base} (mirror ${n})`, original.user_id || null, original.workspace_id || null, token,
      ip || null, original.id, String(fingerprint), location);
  return { mirror: db.prepare('SELECT * FROM devices WHERE id = ?').get(id) };
}

/*
 * PING-PONG GUARD. Mirrors end the tug-of-war between DIFFERENT installs. What is left is one
 * install with two live sockets for one display — two tabs on the same link in one browser profile,
 * or a cloned identity — where each register still evicts the other (correct for the common case: a
 * half-dead socket being replaced by its own reconnect). If that alternates over and over, keep the
 * incumbent and soft-refuse the newcomer for a while instead of looping for ever.
 *
 * Keyed by device; counts evictions of a LIVE incumbent within the window.
 */
const DUEL_WINDOW_MS = 5 * 60 * 1000;
const DUEL_LIMIT = 6;
const DUEL_HOLD_MS = 2 * 60 * 1000;
const duels = new Map();   // deviceId -> [timestamps]

function noteEviction(deviceId, now = Date.now()) {
  const list = (duels.get(deviceId) || []).filter((t) => now - t < DUEL_WINDOW_MS);
  list.push(now);
  duels.set(deviceId, list);
  if (duels.size > 5000) { for (const k of duels.keys()) { duels.delete(k); if (duels.size <= 4000) break; } }
}

/** { refuse: true, retryAfterMs } when this device has been ping-ponging; else { refuse: false }. */
function pingPongVerdict(deviceId, now = Date.now()) {
  const list = (duels.get(deviceId) || []).filter((t) => now - t < DUEL_WINDOW_MS);
  if (list.length >= DUEL_LIMIT) return { refuse: true, retryAfterMs: DUEL_HOLD_MS };
  return { refuse: false };
}

function _resetDuels() { duels.clear(); }

module.exports = {
  mirrorsOf, sourceOf, findMirror, createMirror, describeAgent, describeLocation, limitRefusal,
  noteEviction, pingPongVerdict, _resetDuels,
  MAX_MIRRORS_PER_DISPLAY, DUEL_LIMIT, DUEL_WINDOW_MS,
};
