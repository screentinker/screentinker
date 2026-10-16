'use strict';

/*
 * CONTENT REQUESTS — a shareable form through which people WITHOUT an account (staff, students,
 * departments) send something for the screens. docs/content-requests.md is the user-facing story.
 *
 * Universities run this outside their CMS today (a Box upload plus a web form, or an IT ticket that
 * an editor then re-enters by hand). Here a request becomes, at submission, exactly what an editor
 * would have made of it: a content row with an expiry and a SUBMISSION in the existing review queue.
 * Nothing about publishing is new:
 *
 *   - approving goes through lib/approvals.decide (the reviewer list applies when the workspace
 *     requires approval; when it does not, any member who could publish decides — a request still
 *     never goes live without somebody pressing Approve);
 *   - the screens change through lib/releases.releasePlaylist, behind lib/release-policy's gate, the
 *     same path a dashboard Publish takes. With approval on, the playlist change gets its own
 *     submission, decided by the same reviewer in the same click, so the gate sees an approval for
 *     EXACTLY the state going live — the request is not a side door around it;
 *   - expiry is the content row's expires_at (services/content-expiry.js) plus a dated schedule block
 *     on the playlist item, the same pair the agency portal writes.
 *
 * HOW THIS DIFFERS FROM THE AGENCY PORTAL (routes/agency.js). The agency is a known third party with
 * an API token bound to an allowlist of playlists, which it fills itself and may even auto-publish.
 * A requester is an anonymous member of the public (or of a campus): they hold no credential beyond a
 * link (and, depending on the form, a verified email or an SSO sign-in), they choose only among
 * friendly target NAMES, never playlist ids, and nothing they send can reach a screen without a human
 * decision. The patterns carried over are the agency's: confinement by one query against an allowlist
 * the admin wrote, the shared ingest so the bytes are first-class content, and dated schedule blocks.
 *
 * ⚠️ ABUSE SURFACE. Everything public lives in routes/request-public.js and is bounded here:
 *   - the form code is 128 bits, rotates on demand, and unknown codes count against the caller's IP
 *     (guessing locks the IP out — see noteMiss);
 *   - per-IP limits per action, and per-form / per-email / per-IP daily quotas in the database;
 *   - bytes are sniffed at the first chunk (a disallowed type is refused before the rest arrives),
 *     sniffed again by the shared ingest, and measured (dimensions, aspect, video length) BEFORE any
 *     content row exists, so a refused file never touches the library;
 *   - text fields refuse markup outright rather than "cleaning" it;
 *   - a paused or closed form refuses everything except the status link.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { trimTrailing } = require('./trim-trailing');
const { db } = require('../db/database');
const approvals = require('./approvals');
const revisions = require('./revisions');
const policy = require('./release-policy');
const releases = require('./releases');
const uploadSession = require('./upload-session');
const { sniffMime, readHead, SNIFF_BYTES } = require('./upload-sniff');
const { audit } = require('./audit');

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (bytes) => crypto.randomBytes(bytes).toString('base64url');

class RequestError extends Error {
  constructor(message, status = 400, code = null, extra = null) {
    super(message); this.name = 'RequestError'; this.status = status; this.code = code; this.extra = extra;
  }
}

// ─── limits (exported so tests and docs name the same numbers) ───────────────────────────────

const LIMITS = {
  TICKET_TTL: 2 * 3600,            // a requester has two hours from passing the gate to submitting
  CHALLENGE_TTL: 15 * 60,          // an emailed code lives fifteen minutes...
  CHALLENGE_ATTEMPTS: 5,           // ...and survives five wrong guesses
  CHALLENGES_PER_EMAIL_HOUR: 3,    // codes mailed to one address for one form, per hour
  CHALLENGES_PER_FORM_HOUR: 60,    // codes mailed for one form, per hour, to anyone
  PER_EMAIL_DAY: 5,                // requests from one address to one form per 24h
  PER_IP_DAY: 10,                  // requests from one IP to one form per 24h
  OPEN_UPLOADS_PER_TICKET: 2,
  OPEN_UPLOADS_PER_FORM: 10,
  MISS_MAX: 20,                    // unknown codes / status tokens from one IP...
  MISS_WINDOW_MS: 15 * 60 * 1000,  // ...within this window lock it out...
  MISS_LOCK_MS: 15 * 60 * 1000,    // ...for this long
};

// The media a request may carry. Deliberately narrower than the library: no SVG (active content,
// no dimensions to check), no HTML bundles (a stranger's code on the screens), no audio, no HEIC
// (most players cannot show it).
const KIND_MIMES = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
};
const kindOf = (mime) => Object.keys(KIND_MIMES).find((k) => KIND_MIMES[k].includes(mime)) || null;

// ─── text hygiene ────────────────────────────────────────────────────────────────────────────

/*
 * Requester text is plain text, and MARKUP IS REFUSED, not stripped. Stripping silently changes what
 * someone wrote and invites the "<scr<b>ipt>" games; refusing tells them. Everything is rendered with
 * textContent / esc() anyway — this is the second wall, and it keeps the review queue and the emails
 * free of anything that looks like a tag. Control characters other than newline/tab go too.
 */
const MARKUP_RE = /<\s*[a-z!/?]|&#|&[a-z]+;/i;
function plainText(v, { field, max, required = false, multiline = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new RequestError(`${field} must be text`, 400, 'bad_field', { field });
  let s = v.normalize('NFC').replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') : s.replace(/[\x00-\x1f\x7f]/g, ' ');
  s = s.trim();
  if (required && !s) throw new RequestError(`${field} is required`, 400, 'field_required', { field });
  if (s.length > max) throw new RequestError(`${field} is too long (at most ${max} characters)`, 400, 'field_too_long', { field, max });
  if (MARKUP_RE.test(s)) throw new RequestError(`${field} cannot contain HTML or markup`, 400, 'markup_not_allowed', { field });
  return s;
}

// Strict on purpose: ASCII local part, a real hostname, one @, nothing else. Anything that is not
// unambiguously ONE address is refused rather than tidied (the "a@uni.edu@evil.test" family).
const EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function normEmail(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s.length > 254 || !EMAIL_RE.test(s)) throw new RequestError('Enter a valid email address', 400, 'bad_email');
  return s;
}
const domainOf = (email) => email.slice(email.lastIndexOf('@') + 1);
function domainList(v) { return String(v || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean); }
/** Exact match only: a subdomain is a different domain unless the admin lists it. */
function domainAllowed(form, email) {
  const allowed = domainList(form.allowed_domains);
  return allowed.length === 0 || allowed.includes(domainOf(email));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(v, field) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) throw new RequestError(`${field} must be a date (YYYY-MM-DD)`, 400, 'bad_date', { field });
  const ms = Date.parse(v + 'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw new RequestError(`${field} is not a real date`, 400, 'bad_date', { field });
  return ms / 1000;
}
const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
/*
 * Dates are calendar days. The lead time is counted from today in UTC; the screens apply the window
 * in their OWN local time (playlist_item_schedules), and the content's expires_at is set past the end
 * of the last day everywhere on Earth (+38h after midnight UTC) so the expiry sweep never cuts a
 * screen west of Greenwich short. The schedule block is what ends it on time locally.
 */
function todayUtc() { return Math.floor(nowSec() / DAY) * DAY; }
function expiryFor(endDate) { return parseDate(endDate, 'end_date') + DAY + 14 * 3600; }

// ─── per-IP limits held in memory (one process; the edge limits a fleet of them) ─────────────

const hits = new Map();
function limited(bucket, key, max, windowMs = 60000) {
  const k = bucket + '|' + key;
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => t > now - windowMs);
  if (list.length >= max) { hits.set(k, list); return Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)); }
  list.push(now); hits.set(k, list);
  if (hits.size > 20000) for (const [kk, v] of hits) if (!v.some((t) => t > now - windowMs)) hits.delete(kk);
  return 0;
}

/*
 * Code guessing. A form code is 128 random bits, so guessing one is hopeless; the point is to make a
 * scan visibly expensive and to keep it from costing DB work: after MISS_MAX unknown codes or status
 * tokens in the window the IP is refused outright for MISS_LOCK_MS, valid codes included.
 */
const misses = new Map();
function isLockedOut(ip) {
  const m = misses.get(ip);
  return !!(m && m.until > Date.now());
}
function noteMiss(ip) {
  const now = Date.now();
  const m = misses.get(ip) || { at: [], until: 0 };
  m.at = m.at.filter((t) => t > now - LIMITS.MISS_WINDOW_MS);
  m.at.push(now);
  if (m.at.length >= LIMITS.MISS_MAX) { m.until = now + LIMITS.MISS_LOCK_MS; m.at = []; }
  misses.set(ip, m);
  if (misses.size > 20000) for (const [k, v] of misses) if (v.until < now && !v.at.length) misses.delete(k);
}
function _resetLimits() { hits.clear(); misses.clear(); inflight.clear(); }

/** The IP as stored: keyed-hashed, so the table can count per IP without holding addresses. */
function ipHash(ip) { return crypto.createHmac('sha256', String(config.jwtSecret || 'st')).update('req-ip:' + String(ip || '')).digest('hex').slice(0, 32); }

// ─── forms ───────────────────────────────────────────────────────────────────────────────────

const parseJson = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
function hydrate(row) {
  if (!row) return null;
  return { ...row, targets: parseJson(row.targets, []), fields: parseJson(row.fields, {}), file_rules: parseJson(row.file_rules, {}) };
}
function getForm(id, workspaceId) {
  return hydrate(db.prepare('SELECT * FROM request_forms WHERE id = ? AND workspace_id = ?').get(id, workspaceId));
}
const CODE_RE = /^[A-Za-z0-9_-]{22}$/;
function formByCode(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
  return hydrate(db.prepare('SELECT * FROM request_forms WHERE code = ?').get(code));
}
function listForms(workspaceId) {
  return db.prepare('SELECT * FROM request_forms WHERE workspace_id = ? ORDER BY created_at DESC').all(workspaceId).map(hydrate).map((f) => ({
    ...f,
    pending: db.prepare("SELECT COUNT(*) AS n FROM content_requests WHERE form_id = ? AND status = 'pending'").get(f.id).n,
    total: db.prepare('SELECT COUNT(*) AS n FROM content_requests WHERE form_id = ?').get(f.id).n,
  }));
}

/** The org's identity provider a form in this workspace would send requesters to, or null. */
function ssoProviderFor(workspaceId) {
  try {
    const ws = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!ws || !ws.organization_id) return null;
    const rows = db.prepare('SELECT slug FROM org_sso_providers WHERE organization_id = ? AND enabled = 1 ORDER BY created_at').all(ws.organization_id);
    for (const r of rows) {
      // Verified domains are what confine an org provider (routes/auth.js emailAllowedForProvider);
      // one without any can sign nobody in, so it is not offered.
      const verified = db.prepare('SELECT 1 FROM org_sso_domains WHERE provider_id = (SELECT id FROM org_sso_providers WHERE slug = ?) AND verified_at IS NOT NULL LIMIT 1').get(r.slug);
      if (verified) return r.slug;
    }
  } catch (_) { /* no SSO tables on this install */ }
  return null;
}
function emailConfigured() { try { return require('../services/email').isConfigured(); } catch { return false; } }

/*
 * Where a target sends a request. The admin picks a screen, a group, or a playlist and gives it a
 * friendly name; the PLAYLIST is what the item lands in, and it is resolved and stored here, at
 * configuration time, where the admin can see it — not guessed at approval time from whatever a
 * schedule happens to be playing. The reviewer is shown the playlist and how many screens play it.
 */
function resolveTarget(workspaceId, t) {
  let playlistId = null, deviceId = null, groupId = null;
  if (t.device_id) {
    const d = db.prepare('SELECT id FROM devices WHERE id = ? AND workspace_id = ?').get(String(t.device_id), workspaceId);
    if (!d) throw new RequestError('A target screen is not in this workspace', 400, 'bad_target');
    deviceId = d.id;
    playlistId = require('./resolve-device-playlist').resolveDevicePlaylistId(d.id);
    if (!playlistId) throw new RequestError('That screen has no playlist yet. Give it one first, or pick a playlist as the target.', 400, 'target_no_playlist');
  } else if (t.group_id) {
    const g = db.prepare('SELECT id, playlist_id FROM device_groups WHERE id = ? AND workspace_id = ?').get(String(t.group_id), workspaceId);
    if (!g) throw new RequestError('A target group is not in this workspace', 400, 'bad_target');
    groupId = g.id;
    playlistId = g.playlist_id;
    if (!playlistId) throw new RequestError('That group has no playlist yet. Give it one first, or pick a playlist as the target.', 400, 'target_no_playlist');
  } else if (t.playlist_id) {
    playlistId = String(t.playlist_id);
  } else {
    throw new RequestError('Each target needs a screen, a group or a playlist', 400, 'bad_target');
  }
  const pl = db.prepare('SELECT id, name, workspace_id FROM playlists WHERE id = ?').get(playlistId);
  if (!pl || pl.workspace_id !== workspaceId) throw new RequestError('A target playlist is not in this workspace', 400, 'bad_target');
  const why = targetProblem(pl.id);
  if (why) throw new RequestError(why.message, 400, why.code);
  return { playlist_id: pl.id, device_id: deviceId, group_id: groupId };
}

/** Playlists a request can never be added to — the agency portal's guardrails, same reasons. */
function targetProblem(playlistId) {
  const { isZonedPlaylist, isGovernedPlaylist } = require('./agency-targets');
  try { if (isGovernedPlaylist(db, playlistId)) return { code: 'target_corporate', message: 'A head-office (corporate) playlist cannot take requests' }; } catch (_) { /* no corporate tables */ }
  if (require('./smart-playlist').smartAddError(db, playlistId)) return { code: 'target_smart', message: 'A smart playlist picks its own items, so it cannot take requests' };
  if (isZonedPlaylist(db, playlistId)) return { code: 'target_zoned', message: 'This playlist feeds a zone of a layout; a full-screen request cannot target it' };
  return null;
}

const int = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const FIELD_MODES = ['off', 'optional', 'required'];
const ASPECT_RE = /^(\d{1,3}):(\d{1,3})$/;

function normalizeForm(workspaceId, input, existing = null) {
  const b = input || {};
  const cur = existing || {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!existing || has('title')) out.title = plainText(b.title, { field: 'title', max: 120, required: true });
  // The intro is the ADMIN's text, but it is shown to the public: same no-markup rule.
  if (!existing || has('intro')) out.intro = plainText(b.intro, { field: 'intro', max: 2000, multiline: true });
  if (has('status')) {
    if (!['open', 'paused', 'closed'].includes(b.status)) throw new RequestError('status must be open, paused or closed');
    out.status = b.status;
  }
  const mode = has('access_mode') ? b.access_mode : (cur.access_mode || 'link');
  if (!['link', 'email', 'sso'].includes(mode)) throw new RequestError('access_mode must be link, email or sso');
  out.access_mode = mode;
  const domains = has('allowed_domains')
    ? (Array.isArray(b.allowed_domains) ? b.allowed_domains : domainList(b.allowed_domains)).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
    : domainList(cur.allowed_domains);
  if (domains.length > 20) throw new RequestError('At most 20 domains');
  for (const d of domains) if (!DOMAIN_RE.test(d) || d.length > 253) throw new RequestError(`"${d}" is not a domain`, 400, 'bad_domain');
  out.allowed_domains = [...new Set(domains)].join(',');
  if (mode === 'email') {
    if (!domains.length) throw new RequestError('Email verification needs at least one allowed email domain', 400, 'domains_required');
    if (!emailConfigured()) throw new RequestError('Email verification needs outgoing email, which this server does not have configured', 400, 'email_not_configured');
  }
  if (mode === 'sso' && !ssoProviderFor(workspaceId)) {
    throw new RequestError('Single sign-on needs an identity provider with a verified domain for this organization (Settings, Single sign-on)', 400, 'sso_not_configured');
  }
  if (!existing || has('targets')) {
    if (!Array.isArray(b.targets) || b.targets.length === 0) throw new RequestError('Pick at least one place a request can go', 400, 'targets_required');
    if (b.targets.length > 50) throw new RequestError('At most 50 targets');
    const seen = new Set();
    out.targets = JSON.stringify(b.targets.map((t) => {
      const label = plainText(t && t.label, { field: 'target name', max: 80, required: true });
      const r = resolveTarget(workspaceId, t || {});
      let id = t && typeof t.id === 'string' && /^[a-f0-9]{8,32}$/.test(t.id) ? t.id : crypto.randomBytes(6).toString('hex');
      if (seen.has(id)) id = crypto.randomBytes(6).toString('hex');
      seen.add(id);
      return { id, label, ...r };
    }));
  }
  if (!existing || has('fields')) {
    const f = (b.fields && typeof b.fields === 'object') ? b.fields : {};
    out.fields = JSON.stringify({
      audience: FIELD_MODES.includes(f.audience) ? f.audience : 'optional',
      notes: FIELD_MODES.includes(f.notes) ? f.notes : 'optional',
    });
  }
  if (!existing || has('file_rules')) {
    const r = (b.file_rules && typeof b.file_rules === 'object') ? b.file_rules : {};
    const kinds = (Array.isArray(r.kinds) ? r.kinds : ['image', 'video']).filter((k) => KIND_MIMES[k]);
    if (!kinds.length) throw new RequestError('Allow at least one kind of file (image or video)', 400, 'kinds_required');
    const maxMbCeiling = Math.max(1, Math.floor(config.maxFileSize / 1048576));
    let aspect = null;
    if (r.aspect) {
      const m = ASPECT_RE.exec(String(r.aspect));
      if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new RequestError('aspect must look like 16:9', 400, 'bad_aspect');
      aspect = `${Number(m[1])}:${Number(m[2])}`;
    }
    out.file_rules = JSON.stringify({
      kinds: [...new Set(kinds)],
      max_mb: int(r.max_mb, Math.min(200, maxMbCeiling), 1, maxMbCeiling),
      min_width: int(r.min_width, 0, 0, 16384),
      min_height: int(r.min_height, 0, 0, 16384),
      aspect,
      max_video_sec: int(r.max_video_sec, 0, 0, 3600),
    });
  }
  if (!existing || has('lead_days')) out.lead_days = int(b.lead_days, 0, 0, 365);
  if (!existing || has('max_window_days')) out.max_window_days = int(b.max_window_days, 60, 1, 366);
  if (!existing || has('item_duration_sec')) out.item_duration_sec = int(b.item_duration_sec, 10, 3, 600);
  if (!existing || has('daily_quota')) out.daily_quota = int(b.daily_quota, 20, 1, 500);
  if (has('folder_id')) {
    if (b.folder_id) {
      const f = db.prepare('SELECT id FROM content_folders WHERE id = ? AND workspace_id = ?').get(String(b.folder_id), workspaceId);
      if (!f) throw new RequestError('That folder is not in this workspace', 400, 'bad_folder');
      out.folder_id = f.id;
    } else out.folder_id = null;
  }
  return out;
}

function createForm(workspaceId, input, userId) {
  const vals = normalizeForm(workspaceId, input, null);
  const id = crypto.randomUUID();
  const code = token(16);
  db.prepare(`INSERT INTO request_forms (id, workspace_id, code, title, intro, status, access_mode, allowed_domains, targets, fields, file_rules,
                lead_days, max_window_days, item_duration_sec, daily_quota, folder_id, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, code, vals.title, vals.intro, vals.status || 'open', vals.access_mode, vals.allowed_domains, vals.targets, vals.fields, vals.file_rules,
      vals.lead_days, vals.max_window_days, vals.item_duration_sec, vals.daily_quota, vals.folder_id || null, userId || null);
  return getForm(id, workspaceId);
}

function updateForm(form, input) {
  const vals = normalizeForm(form.workspace_id, input, form);
  const keys = Object.keys(vals);
  if (keys.length) {
    db.prepare(`UPDATE request_forms SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => vals[k]), nowSec(), form.id);
  }
  return getForm(form.id, form.workspace_id);
}

/** A new link; the old one stops working at once. Open tickets for the old link die with it. */
function rotateCode(form) {
  db.prepare('UPDATE request_forms SET code = ?, updated_at = ? WHERE id = ?').run(token(16), nowSec(), form.id);
  db.prepare('DELETE FROM request_tickets WHERE form_id = ?').run(form.id);
  return getForm(form.id, form.workspace_id);
}

function deleteForm(form) {
  // Requests already made outlive their form: their status links keep working and anything approved
  // keeps playing until its end date. Only the way in is removed.
  db.prepare('DELETE FROM request_tickets WHERE form_id = ?').run(form.id);
  db.prepare('DELETE FROM request_email_challenges WHERE form_id = ?').run(form.id);
  db.prepare('DELETE FROM request_forms WHERE id = ?').run(form.id);
}

/** What the admin screen shows for a form: targets with their playlist names and screen counts. */
function adminForm(form) {
  const dp = require('./devices-playing');
  return {
    ...form,
    targets: form.targets.map((t) => {
      const pl = db.prepare('SELECT name FROM playlists WHERE id = ?').get(t.playlist_id);
      return { ...t, playlist_name: pl ? pl.name : null, screens: pl ? dp.devicesOnPlaylist(t.playlist_id).length : 0 };
    }),
    path: `/r/${form.code}`,
  };
}

// ─── the public view of a form ───────────────────────────────────────────────────────────────

function brandFor(workspaceId) {
  try {
    const { resolveBranding, publicBranding } = require('./branding');
    const { hexColor } = require('./safe-color');
    const b = publicBranding(resolveBranding(db, { workspaceId }));
    const logo = typeof b.logo_url === 'string' && /^(https:\/\/|\/(?!\/))[^\s"'<>]*$/.test(b.logo_url) ? b.logo_url : null;
    // custom_css is NOT carried: it is the dashboard's, and a public page is not the place to run it.
    return {
      name: typeof b.brand_name === 'string' && b.brand_name.trim() ? b.brand_name.trim().slice(0, 80) : 'ScreenTinker',
      logo_url: logo,
      primary_color: hexColor(b.primary_color, null),
      bg_color: hexColor(b.bg_color, null),
      hide_branding: !!b.hide_branding,
    };
  } catch (_) { return { name: 'ScreenTinker', logo_url: null, primary_color: null, bg_color: null, hide_branding: false }; }
}

function publicForm(form) {
  const r = form.file_rules || {};
  return {
    title: form.title,
    intro: form.intro,
    status: form.status,
    access_mode: form.access_mode,
    // Shown so a requester knows which address to use; this is no secret (the page asks for it).
    allowed_domains: form.access_mode === 'link' ? [] : domainList(form.allowed_domains),
    // Friendly names ONLY. Playlist, screen and group ids never leave the server on this path.
    targets: form.targets.map((t) => ({ id: t.id, label: t.label })),
    fields: form.fields,
    file_rules: { kinds: r.kinds || [], max_mb: r.max_mb, min_width: r.min_width || 0, min_height: r.min_height || 0, aspect: r.aspect || null, max_video_sec: r.max_video_sec || 0 },
    lead_days: form.lead_days,
    max_window_days: form.max_window_days,
    earliest_start: isoDay(todayUtc() + form.lead_days * DAY),
    chunk_size: uploadSession.CHUNK_SIZE,
    brand: brandFor(form.workspace_id),
  };
}

function assertOpen(form) {
  if (!form) throw new RequestError('This request form does not exist or its link has changed', 404, 'not_found');
  if (form.status === 'paused') throw new RequestError('This form is paused and is not taking requests right now', 403, 'form_paused');
  if (form.status === 'closed') throw new RequestError('This form is closed', 403, 'form_closed');
}

// ─── tickets: proof the requester passed the form's gate ─────────────────────────────────────

function issueTicket(form, { name, email, via }) {
  const tok = token(32);
  const now = nowSec();
  db.prepare('DELETE FROM request_tickets WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO request_tickets (id, form_id, token_hash, name, email, verified_via, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), form.id, sha256(tok), name || null, email, via, now + LIMITS.TICKET_TTL);
  return tok;
}

function ticketFor(form, tok) {
  if (!form || typeof tok !== 'string' || tok.length < 20 || tok.length > 100) return null;
  const t = db.prepare('SELECT * FROM request_tickets WHERE token_hash = ?').get(sha256(tok));
  if (!t || t.form_id !== form.id || t.expires_at < nowSec()) return null;
  // A ticket from before the form switched to a stricter mode is not good enough any more.
  if (form.access_mode === 'email' && t.verified_via !== 'email') return null;
  if (form.access_mode === 'sso' && t.verified_via !== 'sso') return null;
  if (form.access_mode !== 'link' && !domainAllowed(form, t.email)) return null;
  return t;
}

/** Open link: the code in the URL is the gate; name and email are taken as given (unverified). */
function startLink(form, { name, email }) {
  assertOpen(form);
  if (form.access_mode !== 'link') throw new RequestError('This form needs you to verify your email address or sign in', 403, 'verification_required');
  const n = plainText(name, { field: 'name', max: 80, required: true });
  const e = normEmail(email);
  return { ticket: issueTicket(form, { name: n, email: e, via: 'none' }), name: n, email: e, verified: false };
}

/*
 * Email mode: a six-digit code mailed to an address in one of the form's domains.
 *
 * Bounded three ways so it cannot be used to spray mail or to guess: codes per address per hour,
 * codes per form per hour, and five wrong answers kill a code. The domain check is exact on the part
 * after the ONE @ the strict pattern allows, so "a@uni.edu@evil.test", "a@uni.edu.evil.test" and
 * "a@evil.test?@uni.edu" are all refused before any mail is sent.
 */
async function startEmail(form, { name, email }) {
  assertOpen(form);
  if (form.access_mode !== 'email') throw new RequestError('This form does not use email verification', 400, 'wrong_mode');
  const n = plainText(name, { field: 'name', max: 80, required: true });
  const e = normEmail(email);
  if (!domainAllowed(form, e)) throw new RequestError(`Use an address at ${domainList(form.allowed_domains).join(', ')}`, 403, 'domain_not_allowed');
  if (!emailConfigured()) throw new RequestError('This server cannot send email right now', 503, 'email_not_configured');
  const now = nowSec();
  db.prepare('DELETE FROM request_email_challenges WHERE expires_at < ?').run(now - 3600);
  const perEmail = db.prepare('SELECT COUNT(*) AS n FROM request_email_challenges WHERE form_id = ? AND email = ? AND created_at > ?').get(form.id, e, now - 3600).n;
  if (perEmail >= LIMITS.CHALLENGES_PER_EMAIL_HOUR) throw new RequestError('Too many codes sent to this address. Try again in an hour.', 429, 'too_many_codes');
  const perForm = db.prepare('SELECT COUNT(*) AS n FROM request_email_challenges WHERE form_id = ? AND created_at > ?').get(form.id, now - 3600).n;
  if (perForm >= LIMITS.CHALLENGES_PER_FORM_HOUR) throw new RequestError('This form is busy. Try again later.', 429, 'too_many_codes');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('INSERT INTO request_email_challenges (id, form_id, email, name, code_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), form.id, e, n, sha256(form.id + ':' + code), now + LIMITS.CHALLENGE_TTL);
  const brand = brandFor(form.workspace_id).name;
  await require('../services/email').sendEmail({
    to: e,
    subject: `${code} is your code for "${form.title}"`,
    rawSubject: true,
    text: `Your verification code for the request form "${form.title}" is:\n\n    ${code}\n\nIt expires in 15 minutes. If you did not ask for it, ignore this email.\n\n${brand}`,
  });
  return { sent: true };
}

function confirmEmail(form, { email, code }) {
  assertOpen(form);
  if (form.access_mode !== 'email') throw new RequestError('This form does not use email verification', 400, 'wrong_mode');
  const e = normEmail(email);
  const c = db.prepare('SELECT * FROM request_email_challenges WHERE form_id = ? AND email = ? AND expires_at > ? AND attempts < ? ORDER BY created_at DESC LIMIT 1')
    .get(form.id, e, nowSec(), LIMITS.CHALLENGE_ATTEMPTS);
  const bad = () => new RequestError('That code is not right, or it has expired', 400, 'bad_code');
  if (!c) throw bad();
  const given = Buffer.from(sha256(form.id + ':' + String(code || '').trim()), 'hex');
  const want = Buffer.from(c.code_hash, 'hex');
  if (!/^\d{6}$/.test(String(code || '').trim()) || !crypto.timingSafeEqual(given, want)) {
    db.prepare('UPDATE request_email_challenges SET attempts = attempts + 1 WHERE id = ?').run(c.id);
    throw bad();
  }
  // Spent, not deleted: the rows are also the per-address mail count, and deleting them on success
  // would hand a fresh allowance to anyone who verifies once.
  db.prepare('UPDATE request_email_challenges SET attempts = ? WHERE form_id = ? AND email = ?').run(LIMITS.CHALLENGE_ATTEMPTS, form.id, e);
  return { ticket: issueTicket(form, { name: c.name, email: e, via: 'email' }), name: c.name, email: e, verified: true };
}

/*
 * SSO mode, the second half (the first is routes/auth.js beginRequesterSso). routes/auth.js has
 * already verified the assertion exactly as for a sign-in; this decides only whether THAT person may
 * use THIS form. The provider must be the form's own organization's, the address must be one the
 * provider may speak for (passed in: emailAllowed = auth.js emailAllowedForProvider) and verified,
 * and the form's own domain list, if any, narrows it further. No account is created or touched.
 */
function ssoTicket({ formId, provider, email, name, emailAllowed, emailVerified }) {
  const form = hydrate(db.prepare('SELECT * FROM request_forms WHERE id = ?').get(String(formId || '')));
  if (!form) return { error: 'form_unavailable', code: null };
  const fail = (error) => ({ error, code: form.code });
  if (form.status !== 'open') return fail('form_unavailable');
  if (form.access_mode !== 'sso') return fail('wrong_mode');
  const ws = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(form.workspace_id);
  if (!provider || !provider.organizationId || !ws || provider.organizationId !== ws.organization_id) return fail('provider_mismatch');
  let e;
  try { e = normEmail(email); } catch { return fail('no_email'); }
  if (!emailAllowed) return fail('domain_not_allowed');
  if (!emailVerified) return fail('email_unverified');
  if (!domainAllowed(form, e)) return fail('domain_not_allowed');
  let n = String(name || '').replace(/[<>&\x00-\x1f]/g, ' ').trim().slice(0, 80);
  if (!n) n = e;
  return { code: form.code, ticket: issueTicket(form, { name: n, email: e, via: 'sso' }), email: e, name: n };
}

// ─── uploads (resumable, lib/upload-session) ─────────────────────────────────────────────────

const sessionOwner = (form, ticket) => `request:${form.id}:${ticket.id}`;

/** The account whose storage allowance a request draws on: whoever made the form, else the org owner. */
function ownerOf(form) {
  if (form.created_by && db.prepare('SELECT 1 FROM users WHERE id = ?').get(form.created_by)) return form.created_by;
  const o = db.prepare('SELECT o.owner_user_id AS id FROM workspaces w JOIN organizations o ON o.id = w.organization_id WHERE w.id = ?').get(form.workspace_id);
  return o && o.id ? o.id : null;
}

function storageRoom(form) {
  const owner = ownerOf(form);
  if (!owner) return null;
  try { return require('../middleware/subscription').storageRoomBytes(owner); } catch { return null; }
}

const inflight = new Map();   // form id -> submissions between the quota check and their row

/** The daily quotas, checked before bytes are accepted and again at submission. */
function assertQuota(form, { email, ip }) {
  const since = nowSec() - DAY;
  const formN = db.prepare('SELECT COUNT(*) AS n FROM content_requests WHERE form_id = ? AND created_at > ?').get(form.id, since).n + (inflight.get(form.id) || 0);
  if (formN >= form.daily_quota) throw new RequestError('This form has had as many requests as it takes in a day. Try again tomorrow.', 429, 'form_quota');
  if (email) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM content_requests WHERE form_id = ? AND requester_email = ? AND created_at > ?').get(form.id, email, since).n;
    if (n >= LIMITS.PER_EMAIL_DAY) throw new RequestError('You have sent as many requests as this form takes from one person in a day.', 429, 'email_quota');
  }
  if (ip) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM content_requests WHERE form_id = ? AND ip_hash = ? AND created_at > ?').get(form.id, ipHash(ip), since).n;
    if (n >= LIMITS.PER_IP_DAY) throw new RequestError('Too many requests from this network today.', 429, 'ip_quota');
  }
}

function createUpload(form, ticket, { filename, size }, ip) {
  assertOpen(form);
  const rules = form.file_rules || {};
  const declared = Number(size);
  if (!Number.isFinite(declared) || declared <= 0 || !Number.isInteger(declared)) throw new RequestError('size must be a positive number of bytes', 400, 'bad_size');
  const max = Math.min(config.maxFileSize, (rules.max_mb || 1) * 1048576);
  if (declared > max) throw new RequestError(`The file is larger than this form allows (${Math.round(max / 1048576)} MB)`, 413, 'too_large', { max_mb: Math.round(max / 1048576) });
  // Only a label for the session (the stored name is the request's title); flattened, never refused.
  const name = String(typeof filename === 'string' ? filename : '').replace(/[<>"'`\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 200) || 'upload';
  assertQuota(form, { email: ticket.email, ip });
  const mine = db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id = ?').get(sessionOwner(form, ticket)).n;
  if (mine >= LIMITS.OPEN_UPLOADS_PER_TICKET) throw new RequestError('Finish or cancel your other upload first', 429, 'too_many_uploads');
  const formOpen = db.prepare('SELECT COUNT(*) AS n FROM upload_sessions WHERE user_id LIKE ?').get(`request:${form.id}:%`).n;
  if (formOpen >= LIMITS.OPEN_UPLOADS_PER_FORM) throw new RequestError('This form is busy. Try again in a few minutes.', 429, 'form_busy');
  const room = storageRoom(form);
  if (room !== null && declared > room) throw new RequestError('This workspace has no room for the file. Tell the people who run the screens.', 507, 'storage_full');
  const s = uploadSession.create({ workspaceId: form.workspace_id, userId: sessionOwner(form, ticket), filename: name, declaredSize: declared, folderId: form.folder_id || null });
  return { id: s.id, offset: 0, chunk_size: uploadSession.CHUNK_SIZE, declared_size: s.declared_size };
}

function getUpload(form, ticket, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const s = uploadSession.get(id, form.workspace_id);
  return s && s.user_id === sessionOwner(form, ticket) ? s : null;
}

/** Is a file of this mime acceptable under the form's rules? */
function typeAllowed(form, mime) {
  const k = kindOf(mime);
  return !!(k && (form.file_rules.kinds || []).includes(k));
}

/*
 * Append one chunk. ⚠️ The bytes are SNIFFED as soon as the head is on disk, not at the end: a form
 * that takes images must not be made to store a gigabyte of something else first. A refused type
 * discards the session there and then.
 */
function appendChunk(form, ticket, id, offset, buf) {
  assertOpen(form);
  const s = getUpload(form, ticket, id);
  if (!s) throw new RequestError('No such upload', 404, 'no_upload');
  const before = uploadSession.offsetOf(s);
  const r = uploadSession.append(s, offset, buf);
  if (!r.ok) throw new RequestError(r.error, r.status, 'chunk_refused', { offset: r.offset });
  const head = Math.min(SNIFF_BYTES, s.declared_size);
  if (before < head && r.offset >= head) {
    let mime = null;
    try { mime = sniffMime(readHead(uploadSession.partPath(s))); } catch { mime = null; }
    if (!typeAllowed(form, mime)) {
      uploadSession.discard(s);
      throw new RequestError(`This form only takes ${(form.file_rules.kinds || []).join(' or ')} files of a common type`, 415, 'type_not_allowed');
    }
  }
  return { offset: r.offset, complete: r.offset === s.declared_size };
}

function cancelUpload(form, ticket, id) {
  const s = getUpload(form, ticket, id);
  if (s) uploadSession.discard(s);
}

// ─── measuring the file against the form's rules, before it becomes content ──────────────────

async function probeMedia(abs, mime) {
  const kind = kindOf(mime);
  if (kind === 'image') {
    try {
      const md = await require('./image-ops').metadata(abs);
      const { imageDisplayDims } = require('./media-orientation');
      const { width, height } = imageDisplayDims(md);
      return { width: width || null, height: height || null, duration: null };
    } catch { return { width: null, height: null, duration: null, unreadable: true }; }
  }
  try {
    const { execFile } = require('child_process');
    const out = await new Promise((resolve, reject) => execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', abs],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    const info = JSON.parse(out);
    const v = (info.streams || []).find((x) => x.codec_type === 'video');
    if (!v) return { width: null, height: null, duration: null, unreadable: true };
    const { videoDisplayDims } = require('./media-orientation');
    const { width, height } = videoDisplayDims(v);
    const duration = info.format && info.format.duration ? parseFloat(info.format.duration) : null;
    return { width, height, duration: Number.isFinite(duration) ? duration : null };
  } catch { return { width: null, height: null, duration: null, unreadable: true }; }
}

/** Returns null when the file passes, else { code, message } for the requester. */
function checkRules(rules, mime, m) {
  if (m.unreadable) return { code: 'unreadable', message: 'The file could not be read. Export it again as a standard JPEG, PNG or MP4.' };
  const needDims = rules.min_width || rules.min_height || rules.aspect;
  if (needDims && !(m.width && m.height)) return { code: 'unreadable', message: 'The file\'s size in pixels could not be read' };
  const dims = { width: m.width, height: m.height, min_width: rules.min_width || 0, min_height: rules.min_height || 0 };
  if (rules.min_width && m.width < rules.min_width) return { code: 'too_small', message: `The file is ${m.width}x${m.height}; it must be at least ${rules.min_width} pixels wide`, data: dims };
  if (rules.min_height && m.height < rules.min_height) return { code: 'too_small', message: `The file is ${m.width}x${m.height}; it must be at least ${rules.min_height} pixels high`, data: dims };
  if (rules.aspect) {
    const [aw, ah] = rules.aspect.split(':').map(Number);
    const want = aw / ah, got = m.width / m.height;
    if (Math.abs(got - want) / want > 0.02) return { code: 'wrong_aspect', message: `The file is ${m.width}x${m.height}; it must have a ${rules.aspect} shape`, data: { width: m.width, height: m.height, aspect: rules.aspect } };
  }
  if (kindOf(mime) === 'video' && rules.max_video_sec) {
    // Fail closed: a length limit this server cannot check (no ffprobe) refuses rather than waves through.
    if (m.duration == null) return { code: 'unreadable', message: 'The video\'s length could not be read' };
    if (m.duration > rules.max_video_sec + 0.5) return { code: 'too_long', message: `The video is ${Math.round(m.duration)} seconds; this form takes at most ${rules.max_video_sec}`, data: { seconds: Math.round(m.duration), max: rules.max_video_sec } };
  }
  return null;
}

// ─── submitting a request ────────────────────────────────────────────────────────────────────

const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newRef() {
  for (let i = 0; i < 10; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += REF_ALPHABET[crypto.randomInt(0, REF_ALPHABET.length)];
    const ref = `R-${s.slice(0, 4)}-${s.slice(4)}`;
    if (!db.prepare('SELECT 1 FROM content_requests WHERE ref = ?').get(ref)) return ref;
  }
  throw new Error('could not allocate a reference');
}

function validateRequestBody(form, body) {
  const b = body || {};
  const title = plainText(b.title, { field: 'title', max: 120, required: true });
  const fields = form.fields || {};
  const audience = fields.audience === 'off' ? null : plainText(b.audience, { field: 'audience', max: 300, required: fields.audience === 'required' }) || null;
  const notes = fields.notes === 'off' ? null : plainText(b.notes, { field: 'notes', max: 2000, required: fields.notes === 'required', multiline: true }) || null;
  const start = parseDate(b.start_date, 'start_date');
  const end = parseDate(b.end_date, 'end_date');
  const earliest = todayUtc() + form.lead_days * DAY;
  if (start < earliest) {
    throw new RequestError(form.lead_days
      ? `Requests must arrive at least ${form.lead_days} day(s) before they start; the earliest start is ${isoDay(earliest)}`
      : 'The start date is in the past', 400, 'lead_time', { earliest_start: isoDay(earliest) });
  }
  if (end < start) throw new RequestError('The end date is before the start date', 400, 'bad_window');
  if ((end - start) / DAY + 1 > form.max_window_days) throw new RequestError(`A request can run for at most ${form.max_window_days} days`, 400, 'window_too_long', { max_days: form.max_window_days });
  if (start > todayUtc() + 366 * DAY) throw new RequestError('The start date is too far ahead', 400, 'bad_window');
  // The requester names targets by the ids publicForm handed out; anything else is refused, never
  // ignored, so a forged id is an error rather than a silently smaller request.
  const ids = Array.isArray(b.targets) ? b.targets : [];
  if (!ids.length) throw new RequestError('Choose at least one place for this to show', 400, 'targets_required');
  if (ids.length > 50) throw new RequestError('Too many targets', 400, 'bad_target');
  const byId = new Map(form.targets.map((t) => [t.id, t]));
  const chosen = [];
  for (const id of new Set(ids)) {
    const t = typeof id === 'string' ? byId.get(id) : null;
    if (!t) throw new RequestError('One of the chosen places is not offered by this form', 400, 'target_not_allowed');
    chosen.push({ id: t.id, label: t.label, playlist_id: t.playlist_id });
  }
  return { title, audience, notes, start_date: b.start_date, end_date: b.end_date, targets: chosen };
}

async function submitRequest(form, ticket, body, { ip, origin } = {}) {
  assertOpen(form);
  const v = validateRequestBody(form, body);
  const session = getUpload(form, ticket, body && body.upload_id);
  if (!session) throw new RequestError('Upload the file first', 400, 'no_upload');
  if (!uploadSession.isComplete(session)) {
    throw new RequestError('The upload is not finished yet', 409, 'upload_incomplete', { offset: uploadSession.offsetOf(session), declared_size: session.declared_size });
  }
  assertQuota(form, { email: ticket.email, ip });
  inflight.set(form.id, (inflight.get(form.id) || 0) + 1);
  try {
    const part = uploadSession.partPath(session);
    let mime = null;
    try { mime = sniffMime(readHead(part)); } catch { mime = null; }
    if (!typeAllowed(form, mime)) { uploadSession.discard(session); throw new RequestError('This file type is not accepted here', 415, 'type_not_allowed'); }
    const measured = await probeMedia(part, mime);
    const bad = checkRules(form.file_rules || {}, mime, measured);
    if (bad) { uploadSession.discard(session); throw new RequestError(bad.message, 400, bad.code, bad.data || null); }
    const room = storageRoom(form);
    if (room !== null && session.declared_size > room) { uploadSession.discard(session); throw new RequestError('This workspace has no room for the file. Tell the people who run the screens.', 507, 'storage_full'); }

    // The SAME ingest a dashboard upload runs: sniff, thumbnail, dimensions, digest, storage, row.
    //
    // ⚠️ CREATED SWITCHED OFF (is_active=0), and nothing is told the library changed. A request is
    // only on screens once someone approves it, but an active row is fair game for any SMART playlist
    // whose rules it matches (its type, the form's folder, a "name contains" on the title the
    // requester chose), and in a workspace without require_approval a smart playlist's refresh
    // republishes additions straight to screens. publishRequest switches it on.
    const { ingestUploadedFile } = require('./content-ingest');
    let content;
    try {
      content = await ingestUploadedFile({ file: uploadSession.stageForIngest(session), userId: ownerOf(form), workspaceId: form.workspace_id, folderId: form.folder_id || null, active: false });
      uploadSession.forget(session.id);
    } catch (e) {
      if (e && e.name === 'StorageWriteError') e.discard();
      uploadSession.discard(session);
      if (e && e.name === 'UnsupportedUploadError') throw new RequestError(e.message, 400, 'type_not_allowed');
      throw e;
    }
    const ext = path.extname(content.filepath || '') || '';
    db.prepare('UPDATE content SET filename = ?, expires_at = ? WHERE id = ?').run(`${v.title}${ext}`, expiryFor(v.end_date), content.id);

    const id = crypto.randomUUID();
    const ref = newRef();
    const statusToken = token(32);
    const label = `${ticket.name || ticket.email} <${ticket.email}>`;
    db.prepare(`INSERT INTO content_requests (id, ref, form_id, workspace_id, status_token_hash, requester_name, requester_email, verified_via, title, audience, notes,
                  start_date, end_date, targets, content_id, status, ip_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, ref, form.id, form.workspace_id, sha256(statusToken), ticket.name || ticket.email, ticket.email, ticket.verified_via, v.title, v.audience, v.notes,
        v.start_date, v.end_date, JSON.stringify(v.targets), content.id, ip ? ipHash(ip) : null);
    const actor = { userId: null, kind: 'content_request', label };
    try { revisions.recordCurrent(db, 'content', content.id, { actor, summary: `Request ${ref}` }); } catch (_) { /* history must not fail a request */ }
    const sub = approvals.submit(db, {
      type: 'content', id: content.id, workspaceId: form.workspace_id, actor, ip, requestId: id,
      note: `Request ${ref} from ${label}: ${v.start_date} to ${v.end_date} on ${v.targets.map((t) => t.label).join(', ')}`,
    });
    db.prepare('UPDATE content_requests SET submission_id = ? WHERE id = ?').run(sub.id, id);
    audit('request:submitted', { workspaceId: form.workspace_id, ip, details: { request_id: id, ref, form_id: form.id, content_id: content.id, submission_id: sub.id, verified_via: ticket.verified_via } });

    const statusUrl = `${linkOrigin(origin)}/r/status#${statusToken}`;
    notifyReviewers(form, { ref, title: v.title, label, origin });
    // An address nobody verified gets no "we received it" mail: otherwise this form could be used to
    // send mail to anyone. Decisions are mailed (a human pressed a button), received-receipts are not.
    if (ticket.verified_via !== 'none') {
      mail(ticket.email, `Request ${ref} received: ${v.title}`,
        `Thanks, we have your request "${v.title}" (${ref}).\n\nSomeone will review it before it goes on the screens. Follow it here:\n${statusUrl}\n`);
    }
    return { ref, status_token: statusToken, status_path: `/r/status#${statusToken}`, status: 'pending' };
  } finally {
    const n = (inflight.get(form.id) || 1) - 1;
    if (n > 0) inflight.set(form.id, n); else inflight.delete(form.id);
  }
}

/*
 * The origin of a link in a request email. The route hands over lib/public-origin's answer for the
 * request (never the raw Host header: anyone can send a forged one); without it this falls back to
 * the same module's request-free answer, never to a relative link.
 */
function linkOrigin(origin) {
  return trimTrailing(String(origin || require('./public-origin').publicOrigin(null)), '/');
}

function mail(to, subject, text) {
  try {
    const email = require('../services/email');
    if (!email.isConfigured()) return;
    email.sendEmail({ to, subject, text }).catch(() => {});
  } catch (_) { /* mail is a courtesy; the status link always works */ }
}

function notifyReviewers(form, { ref, title, label, origin }) {
  try {
    let to;
    if (policy.approvalRequired(db, form.workspace_id)) to = approvals.reviewers(db, form.workspace_id).filter((r) => r.eligible).map((r) => r.email);
    else to = db.prepare("SELECT u.email FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('workspace_admin','workspace_editor')").all(form.workspace_id).map((r) => r.email);
    const link = `${linkOrigin(origin)}/app#/requests`;
    for (const addr of [...new Set(to.filter(Boolean))].slice(0, 20)) {
      mail(addr, `New content request ${ref}: ${title}`, `${label} sent a request through "${form.title}".\n\nReview it: ${link}\n`);
    }
  } catch (_) { /* best effort */ }
}

// ─── the workspace side: list, approve, reject, publish ──────────────────────────────────────

function getRequest(id, workspaceId) {
  const r = db.prepare('SELECT * FROM content_requests WHERE id = ? AND workspace_id = ?').get(String(id || ''), workspaceId);
  return r ? { ...r, targets: parseJson(r.targets, []), publish_result: parseJson(r.publish_result, {}) } : null;
}
/** A request as it may leave the server: never the status-token hash or the IP hash. */
function shareable(r) {
  if (!r) return r;
  const { status_token_hash: _t, ip_hash: _i, ...rest } = r;
  return rest;
}
function requestForSubmission(sub) {
  if (!sub || !sub.request_id) return null;
  return getRequest(sub.request_id, sub.workspace_id);
}

function listRequests(workspaceId, { status = 'pending', formId = null } = {}) {
  const clauses = ['r.workspace_id = ?'], params = [workspaceId];
  if (status && status !== 'all') { clauses.push('r.status = ?'); params.push(status); }
  if (formId) { clauses.push('r.form_id = ?'); params.push(formId); }
  return db.prepare(`SELECT r.id, r.ref, r.form_id, f.title AS form_title, r.requester_name, r.requester_email, r.verified_via, r.title, r.start_date, r.end_date,
                            r.targets, r.content_id, r.submission_id, r.status, r.reason, r.created_at, r.decided_at, c.mime_type, c.thumbnail_path
                       FROM content_requests r LEFT JOIN request_forms f ON f.id = r.form_id LEFT JOIN content c ON c.id = r.content_id
                      WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`).all(...params)
    .map((r) => ({ ...r, targets: parseJson(r.targets, []) }));
}

/** Everything a reviewer needs on one screen, including where it would land and how many screens. */
function requestDetail(reqRow, req) {
  const dp = require('./devices-playing');
  const sub = reqRow.submission_id ? approvals.getSubmission(db, reqRow.submission_id) : null;
  const content = reqRow.content_id ? db.prepare('SELECT id, filename, mime_type, width, height, duration_sec, file_size, thumbnail_path, expires_at, is_active FROM content WHERE id = ?').get(reqRow.content_id) : null;
  return {
    ...reqRow,
    ip_hash: undefined,
    form_title: (db.prepare('SELECT title FROM request_forms WHERE id = ?').get(reqRow.form_id) || {}).title || null,
    status_token_hash: undefined,
    content,
    submission: sub ? { id: sub.id, status: sub.status, version: sub.version, comment: sub.comment, reviewer_email: sub.reviewer_email } : null,
    targets: reqRow.targets.map((t) => {
      const pl = db.prepare('SELECT name FROM playlists WHERE id = ? AND workspace_id = ?').get(t.playlist_id, reqRow.workspace_id);
      const r = reqRow.publish_result && reqRow.publish_result[t.id];
      return { ...t, playlist_name: pl ? pl.name : null, screens: pl ? dp.devicesOnPlaylist(t.playlist_id).length : 0, problem: pl ? (targetProblem(t.playlist_id) || dirtyProblem(t.playlist_id)) : { code: 'gone', message: 'The playlist no longer exists' }, result: r || null };
    }),
    can_decide: reqRow.status === 'pending' && !!sub && approvals.mayDecide(db, sub, req && req.user ? { userId: req.user.id } : null, require('./permissions').canWrite(req)),
    approval_required: policy.approvalRequired(db, reqRow.workspace_id),
  };
}

/*
 * A playlist with unpublished edits is not touched. Publishing it to add a request would publish
 * somebody else's half-finished work along with it — the side door this feature must not be. The
 * reviewer is told which playlist and why, and can approve once that work is published or discarded.
 */
function dirtyProblem(playlistId) {
  // playlists.status is the product's own "has unpublished changes" flag: every edit path sets it to
  // draft (routes/playlists.js markDraft) and only a publish sets it back.
  const p = db.prepare('SELECT status, published_snapshot FROM playlists WHERE id = ?').get(playlistId);
  if (!p) return { code: 'gone', message: 'The playlist no longer exists' };
  if (!p.published_snapshot) return { code: 'unpublished', message: 'This playlist has never been published. Publish it first.' };
  if (p.status !== 'published') return { code: 'playlist_has_draft', message: 'This playlist has unpublished changes. Publish or discard them first, then approve.' };
  return null;
}

function targetProblems(reqRow, only = null) {
  const out = [];
  for (const t of reqRow.targets) {
    if (only && !only.has(t.id)) continue;
    const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND workspace_id = ?').get(t.playlist_id, reqRow.workspace_id);
    const p = !pl ? { code: 'gone', message: 'The playlist no longer exists' } : (targetProblem(t.playlist_id) || dirtyProblem(t.playlist_id));
    if (p) out.push({ target: t.label, playlist_id: t.playlist_id, ...p });
  }
  return out;
}

function actorOf(req) { return releases.actorOf(req); }

async function approveRequest(req, id, { comment, version } = {}) {
  const r = getRequest(id, req.workspaceId);
  if (!r) throw new RequestError('Request not found', 404, 'not_found');
  if (r.status !== 'pending') throw new RequestError(`This request is ${r.status}`, 409, 'not_pending');
  const content = db.prepare('SELECT id, is_active, expires_at FROM content WHERE id = ?').get(r.content_id);
  if (!content) throw new RequestError('The requested file is gone from the library', 409, 'content_gone');
  // Who may decide is answered before anything about the targets is said.
  const writer = require('./permissions').canWrite(req);
  const sub = approvals.getSubmission(db, r.submission_id);
  if (!sub || !approvals.mayDecide(db, sub, actorOf(req), writer)) throw new RequestError('You are not an assigned reviewer for this workspace, or no longer have edit access', 403, 'not_reviewer');
  if (r.end_date < isoDay(todayUtc())) throw new RequestError('This request\'s end date has passed', 409, 'window_passed');
  // Every target is checked BEFORE the decision is recorded, so an approval never half-happens
  // because one playlist had a draft in it.
  const problems = targetProblems(r);
  if (problems.length) throw new RequestError(`${problems[0].target}: ${problems[0].message}`, 409, 'targets_blocked', { problems });
  approvals.decide(db, { submissionId: r.submission_id, decision: 'approve', reviewer: actorOf(req), comment, expectedVersion: version, ip: req.ip, writer });
  const now = nowSec();
  db.prepare("UPDATE content_requests SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(req.user.id, now, now, r.id);
  audit('request:approved', { userId: req.user.id, workspaceId: r.workspace_id, ip: req.ip, details: { request_id: r.id, ref: r.ref, comment: comment || null } });
  return publishRequest(req, r.id, { origin: req.headers && req.headers.origin });
}

/*
 * Put an APPROVED request on its screens, through the release gate. Idempotent per target: a target
 * that already went live is skipped, so a retry after a failure (a playlist that had a draft) only
 * does what is left.
 */
async function publishRequest(req, id, { origin } = {}) {
  const r = getRequest(id, req.workspaceId);
  if (!r) throw new RequestError('Request not found', 404, 'not_found');
  if (r.status !== 'approved' && r.status !== 'published') throw new RequestError(`This request is ${r.status}; only an approved request can be published`, 409, 'not_approved');
  const sub = approvals.getSubmission(db, r.submission_id);
  if (!sub || (sub.status !== 'approved' && sub.status !== 'published')) throw new RequestError('This request has no approval on record', 409, 'not_approved');
  const content = db.prepare('SELECT * FROM content WHERE id = ?').get(r.content_id);
  if (!content) throw new RequestError('The requested file is gone from the library', 409, 'content_gone');
  const actor = actorOf(req);
  const writer = require('./permissions').canWrite(req);
  // The content's own release: with approval on this finds the approved submission and re-checks the
  // reviewer's standing and the bytes; with approval off it is direct. Closed only after a target
  // went live (afterRelease below).
  const contentGate = sub.status === 'approved' ? policy.assertReleasable(db, { workspaceId: r.workspace_id, type: 'content', id: r.content_id }) : null;
  const results = { ...(r.publish_result || {}) };
  const pending = r.targets.filter((t) => !(results[t.id] && results[t.id].ok));
  const form = db.prepare('SELECT item_duration_sec FROM request_forms WHERE id = ?').get(r.form_id);
  const dwell = String(content.mime_type || '').startsWith('video/')
    ? require('./item-duration').resolveItemDuration(undefined, content)
    : (form ? form.item_duration_sec : 10);
  const label = `${r.requester_name} <${r.requester_email}>`;
  const donePlaylists = new Set(Object.values(results).filter((x) => x && x.ok).map((x) => x.playlist_id));
  // The file was ingested switched off (submitRequest). It goes on now, before the releases below,
  // which drop inactive content from the snapshot; if no target goes live it goes back off, so an
  // approved request that reached no screen is not picked up by a smart playlist either.
  const activated = content.is_active === 0;
  if (activated) db.prepare('UPDATE content SET is_active = 1 WHERE id = ?').run(content.id);

  for (const t of pending) {
    if (donePlaylists.has(t.playlist_id)) { results[t.id] = { ok: true, playlist_id: t.playlist_id, shared: true, at: nowSec() }; continue; }
    const problem = targetProblems({ ...r, targets: [t] })[0];
    if (problem) { results[t.id] = { ok: false, playlist_id: t.playlist_id, code: problem.code, error: problem.message, at: nowSec() }; continue; }
    let itemId = null, plSub = null;
    try {
      // CORPORATE: head office's playlists are never request targets (targetProblem); this is the
      // second line, the same one the agency upload has, judged with the reviewer as the actor.
      require('./corporate/guard').assertPlaylistWritable(req, { id: t.playlist_id }, 'items');
      itemId = db.transaction(() => {
        const order = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM playlist_items WHERE playlist_id = ?').get(t.playlist_id).n;
        const iid = db.prepare('INSERT INTO playlist_items (playlist_id, content_id, sort_order, duration_sec) VALUES (?, ?, ?, ?)').run(t.playlist_id, r.content_id, order, dwell).lastInsertRowid;
        db.prepare("INSERT INTO playlist_item_schedules (id, playlist_item_id, active_days, start_time, end_time, start_date, end_date, sort_order) VALUES (?, ?, '0,1,2,3,4,5,6', '00:00', '24:00', ?, ?, 0)")
          .run(crypto.randomUUID(), iid, r.start_date, r.end_date);
        db.prepare("UPDATE playlists SET status = 'draft', updated_at = strftime('%s','now') WHERE id = ?").run(t.playlist_id);
        return iid;
      })();
      revisions.recordCurrent(db, 'playlist', t.playlist_id, { actor: { userId: null, kind: 'content_request', label }, summary: `Request ${r.ref}: added "${r.title}" ${r.start_date} to ${r.end_date}` });
      if (policy.approvalRequired(db, r.workspace_id)) {
        // The playlist change IS the request the reviewer just approved, item for item: the target was
        // clean (no other unpublished change) a moment ago, so the diff is exactly this one dated item.
        // It gets its own submission and the same reviewer's decision, so the gate below sees an
        // approval bound to precisely the state about to go live.
        plSub = approvals.submit(db, { type: 'playlist', id: t.playlist_id, workspaceId: r.workspace_id, actor: { userId: null, kind: 'content_request', label }, ip: req.ip, requestId: r.id,
          note: `Request ${r.ref}: add "${r.title}" ${r.start_date} to ${r.end_date}` });
        approvals.decide(db, { submissionId: plSub.id, decision: 'approve', reviewer: actor, comment: `Approved with request ${r.ref}`, ip: req.ip, writer });
      }
      releases.releasePlaylist(db, t.playlist_id, req, { actor, source: 'content_request' });
      results[t.id] = { ok: true, playlist_id: t.playlist_id, item_id: Number(itemId), at: nowSec() };
      donePlaylists.add(t.playlist_id);
    } catch (e) {
      // Leave the playlist exactly as it was: no stray draft item, no open submission for it.
      if (itemId != null) {
        try {
          db.prepare('DELETE FROM playlist_items WHERE id = ?').run(itemId);
          // It was clean (published) a moment ago — targetProblems checked — so clean is what it goes back to.
          db.prepare("UPDATE playlists SET status = 'published' WHERE id = ? AND published_snapshot IS NOT NULL").run(t.playlist_id);
        } catch (_) { /* best effort */ }
      }
      if (plSub) db.prepare("UPDATE submissions SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('submitted','approved','changes_requested')").run(nowSec(), plSub.id);
      results[t.id] = { ok: false, playlist_id: t.playlist_id, code: e.code || 'publish_failed', error: e.message, at: nowSec() };
    }
  }

  const anyOk = Object.values(results).some((x) => x && x.ok);
  const allOk = r.targets.every((t) => results[t.id] && results[t.id].ok);
  if (activated && !anyOk) db.prepare('UPDATE content SET is_active = 0 WHERE id = ?').run(content.id);
  // Smart playlists whose rules match it pick it up now, and not before.
  if (activated && anyOk) { try { require('./smart-playlist').notifyContentChanged(r.workspace_id); } catch (_) { /* best effort */ } }
  if (anyOk && contentGate) policy.afterRelease(db, { type: 'content', id: r.content_id, gate: contentGate, actor, summary: `Published (request ${r.ref})` });
  if (anyOk && sub.status === 'approved' && !contentGate.submission) {
    // Approval off: the gate is direct, so close the request's own submission here.
    db.prepare("UPDATE submissions SET status = 'published', published_at = ?, published_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = 'approved'")
      .run(nowSec(), req.user.id, nowSec(), sub.id);
  }
  const status = anyOk ? 'published' : 'approved';
  const wasPublished = r.status === 'published';
  db.prepare('UPDATE content_requests SET status = ?, publish_result = ?, updated_at = ? WHERE id = ?').run(status, JSON.stringify(results), nowSec(), r.id);
  audit('request:published', { userId: req.user.id, workspaceId: r.workspace_id, ip: req.ip, details: { request_id: r.id, ref: r.ref, results } });
  if (anyOk && !wasPublished) {
    const where = r.targets.filter((t) => results[t.id] && results[t.id].ok).map((t) => t.label).join(', ');
    mail(r.requester_email, `Approved: ${r.title} (${r.ref})`,
      `Your request "${r.title}" (${r.ref}) was approved.\n\nIt will show on: ${where}\nFrom ${r.start_date} to ${r.end_date}.\n`);
  }
  return { request: shareable(getRequest(r.id, r.workspace_id)), all_published: allOk, results };
}

function rejectRequest(req, id, { reason, version } = {}) {
  const r = getRequest(id, req.workspaceId);
  if (!r) throw new RequestError('Request not found', 404, 'not_found');
  if (r.status !== 'pending') throw new RequestError(`This request is ${r.status}`, 409, 'not_pending');
  const why = plainText(reason, { field: 'reason', max: 1000, required: true, multiline: true });
  approvals.decide(db, { submissionId: r.submission_id, decision: 'request_changes', reviewer: actorOf(req), comment: why, expectedVersion: version, ip: req.ip, writer: require('./permissions').canWrite(req) });
  const now = nowSec();
  db.prepare("UPDATE content_requests SET status = 'rejected', reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(why, req.user.id, now, now, r.id);
  // The file is not in any playlist; switching it off keeps it out of pickers and smart playlists.
  db.prepare('UPDATE content SET is_active = 0, expires_at = ? WHERE id = ?').run(now, r.content_id);
  audit('request:rejected', { userId: req.user.id, workspaceId: r.workspace_id, ip: req.ip, details: { request_id: r.id, ref: r.ref, reason: why } });
  mail(r.requester_email, `Not approved: ${r.title} (${r.ref})`,
    `Your request "${r.title}" (${r.ref}) was not approved.\n\nReason: ${why}\n`);
  return shareable(getRequest(r.id, r.workspace_id));
}

/** The submission was withdrawn from the queue (staff) or cancelled from the status link (requester). */
function cancelRequest(r, { by = null, ip = null } = {}) {
  const now = nowSec();
  db.prepare("UPDATE content_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'").run(now, r.id);
  db.prepare("UPDATE submissions SET status = 'withdrawn', updated_at = ?, version = version + 1 WHERE id = ? AND status IN ('submitted','changes_requested','approved')").run(now, r.submission_id);
  if (r.content_id) db.prepare('UPDATE content SET is_active = 0, expires_at = ? WHERE id = ?').run(now, r.content_id);
  audit('request:cancelled', { userId: by, workspaceId: r.workspace_id, ip, details: { request_id: r.id, ref: r.ref } });
}

// ─── the requester's status link ─────────────────────────────────────────────────────────────

function byStatusToken(tok) {
  if (typeof tok !== 'string' || tok.length < 30 || tok.length > 100 || !/^[A-Za-z0-9_-]+$/.test(tok)) return null;
  const r = db.prepare('SELECT * FROM content_requests WHERE status_token_hash = ?').get(sha256(tok));
  return r ? { ...r, targets: parseJson(r.targets, []), publish_result: parseJson(r.publish_result, {}) } : null;
}

/** What the requester may see: their own request, in their own words, and the decision. Nothing else. */
function publicStatus(r) {
  const form = db.prepare('SELECT title FROM request_forms WHERE id = ?').get(r.form_id);
  const today = isoDay(todayUtc());
  let state = r.status;
  if (state === 'published') state = r.end_date < today ? 'ended' : (r.start_date > today ? 'scheduled' : 'live');
  else if (state === 'approved') state = 'approved';
  return {
    ref: r.ref, title: r.title, state, start_date: r.start_date, end_date: r.end_date,
    targets: r.targets.map((t) => t.label), reason: r.status === 'rejected' ? r.reason : null,
    submitted_at: r.created_at, decided_at: r.decided_at, form_title: form ? form.title : null,
    can_cancel: r.status === 'pending', brand: brandFor(r.workspace_id),
  };
}

module.exports = {
  RequestError, LIMITS, KIND_MIMES,
  plainText, normEmail, domainAllowed, parseDate,
  limited, isLockedOut, noteMiss, _resetLimits, ipHash,
  formByCode, getForm, listForms, createForm, updateForm, rotateCode, deleteForm, adminForm, publicForm, assertOpen, ssoProviderFor, emailConfigured,
  ticketFor, startLink, startEmail, confirmEmail, ssoTicket,
  createUpload, getUpload, appendChunk, cancelUpload, checkRules, probeMedia,
  submitRequest, getRequest, requestForSubmission, listRequests, requestDetail,
  approveRequest, publishRequest, rejectRequest, cancelRequest,
  byStatusToken, publicStatus,
};
