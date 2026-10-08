'use strict';

/*
 * Tracked QR links: a short address (/q/<code>) that redirects to a target URL and counts the scan.
 * Put the short address in a QR (a slide's QR element, or the downloaded SVG) and the target can
 * change later without reprinting anything.
 *
 * ⚠️ PRIVACY. A scan stores a time and a coarse platform (iPhone / Android / other) and nothing
 * else: no IP address, no full user agent, no cookie. IP + user agent are used only in memory, to
 * count a camera app that opens the same code twice in a few seconds as one scan. Not the IP alone:
 * everyone on a venue's guest Wi-Fi shares one public address, and they are different people.
 * Link-preview bots (Slack, WhatsApp, iMessage, social crawlers) are not counted at all.
 */

const crypto = require('crypto');

const CODE_LEN = 7;
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/l/I
const DEDUPE_MS = 10 * 1000;
const BOT_RE = /bot\b|crawl|spider|preview|slack|whatsapp|facebookexternalhit|twitterbot|telegrambot|discordbot|linkedinbot|embedly|skypeuripreview|bingpreview|googleother|curl\/|wget\//i;

const recent = new Map();   // `${linkId}|${ip}` -> ms (in memory only)

function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

function checkTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return 'Enter the address the QR should open, starting with https://'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'The address must start with http:// or https://';
  if (u.username || u.password) return 'The address must not contain a username or password.';
  if (String(raw).length > 2000) return 'The address is too long.';
  return null;
}

function normaliseInput(body, existing = null) {
  const b = body || {};
  const out = {};
  if (b.name !== undefined || !existing) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name required' };
    out.name = name;
  }
  if (b.target_url !== undefined || !existing) {
    const e = checkTarget(b.target_url);
    if (e) return { error: e };
    out.target_url = String(b.target_url).trim();
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  return { fields: out };
}

function platformOf(ua) {
  const s = String(ua || '');
  if (/iPhone|iPad|iPod/i.test(s)) return 'ios';
  if (/Android/i.test(s)) return 'android';
  return 'other';
}

/** Count a scan (unless it is a bot or a repeat). Returns the link to redirect to, or null. */
function recordScan(db, code, { ip, ua, now = Date.now() } = {}) {
  const link = db.prepare('SELECT * FROM qr_links WHERE code = ?').get(String(code || ''));
  if (!link || !link.enabled) return link && !link.enabled ? { link, counted: false, disabled: true } : null;
  if (BOT_RE.test(String(ua || ''))) return { link, counted: false };
  const key = `${link.id}|${ip || ''}|${String(ua || '').slice(0, 300)}`;
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return { link, counted: false };
  recent.set(key, now);
  if (recent.size > 20000) for (const [k, t] of recent) { if (now - t > DEDUPE_MS) recent.delete(k); }
  db.prepare('INSERT INTO qr_scans (link_id, at, platform) VALUES (?, ?, ?)').run(link.id, Math.floor(now / 1000), platformOf(ua));
  return { link, counted: true };
}

/** Totals, the last 30 days by day (UTC), and the platform split. */
function stats(db, linkId, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  const total = db.prepare('SELECT COUNT(*) n, MAX(at) last FROM qr_scans WHERE link_id = ?').get(linkId);
  const since = nowSec - 30 * 86400;
  const rows = db.prepare(`SELECT date(at, 'unixepoch') d, COUNT(*) n FROM qr_scans WHERE link_id = ? AND at >= ? GROUP BY d`).all(linkId, since);
  const byDay = new Map(rows.map((r) => [r.d, r.n]));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date((nowSec - i * 86400) * 1000).toISOString().slice(0, 10);
    days.push({ date: d, scans: byDay.get(d) || 0 });
  }
  const plat = { ios: 0, android: 0, other: 0 };
  for (const r of db.prepare('SELECT platform, COUNT(*) n FROM qr_scans WHERE link_id = ? GROUP BY platform').all(linkId)) plat[r.platform] = r.n;
  const last7 = days.slice(-7).reduce((a, d) => a + d.scans, 0);
  return { total: total.n, last_scan_at: total.last || null, last_7_days: last7, days, platforms: plat };
}

function _resetDedupe() { recent.clear(); }

module.exports = { newCode, normaliseInput, checkTarget, platformOf, recordScan, stats, BOT_RE, _resetDedupe };
