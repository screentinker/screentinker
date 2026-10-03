'use strict';

/**
 * Community hardware reports for the public Certified Hardware page.
 *
 * ⚠️ THE ONE RULE THIS FILE EXISTS TO ENFORCE: a submission can never become Certified Hardware.
 * Reseller agreements define that term as the models published on the page, and support obligations
 * attach to them. Certification therefore stays in certified-hardware.json, committed by a human
 * who tested the device. Everything arriving here is published as community-reported, validated by
 * "Community", under a heading that says in writing it carries no support commitment.
 *
 * That is enforced HERE, not in the form. A form is a suggestion to a browser; anyone can post
 * whatever they like to the endpoint. So `status` and `validated_by` are assigned, never read from
 * the request, and no code path in this module can produce any other value.
 */

const crypto = require('node:crypto');

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days: these get actioned whenever the owner gets to them

const CATEGORIES = ['streaming-player', 'soc-display', 'media-player', 'browser', 'sbc'];

/** Field caps. A public endpoint gets whatever the internet feels like sending. */
const LIMITS = {
  name: 120,
  manufacturer: 80,
  model_numbers: 200,
  os: 80,
  player: 120,
  max_resolution: 20,
  player_version: 20,
  notes: 2000,
  submitter_name: 80,
  submitter_email: 200,
};

function str(v, max) {
  if (v == null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

/** Deep-link anchors live in reseller quotes, so a slug has to be stable and url-safe. */
function slugify(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * ⚠️ Free text on a public page is a link-spam target, and the page ranks. Anything that looks like
 * a URL is refused outright rather than stripped: a submission whose notes were silently gutted is
 * worse than one the submitter is told to fix.
 */
function containsLink(text) {
  if (!text) return false;
  return /(https?:\/\/|www\.|\[url|<a\s|\b[a-z0-9-]+\.(com|net|org|ru|cn|io|shop|top|xyz)\b)/i.test(text);
}

class SubmissionError extends Error {
  constructor(message) { super(message); this.name = 'SubmissionError'; this.status = 400; }
}

/**
 * Turn a request body into a row, or throw. Note what is NOT read from input: status, validated_by,
 * validated_on, min_version and provisioning_url. Those are certification claims and a stranger
 * does not get to make them.
 */
function normalise(body, ip) {
  if (!body || typeof body !== 'object') throw new SubmissionError('Nothing was submitted');

  // Honeypot: a real browser leaves this empty because it is hidden. Bots fill everything in.
  if (str(body.website, 200)) throw new SubmissionError('Submission rejected');

  const name = str(body.name, LIMITS.name);
  if (!name) throw new SubmissionError('A device name is required');

  const category = str(body.category, 40);
  if (!CATEGORIES.includes(category)) throw new SubmissionError('Pick a device category from the list');

  const notes = str(body.notes, LIMITS.notes);
  const email = str(body.submitter_email, LIMITS.submitter_email);
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) throw new SubmissionError('That email address does not look right');

  for (const [field, text] of [['notes', notes], ['name', name]]) {
    if (containsLink(text)) throw new SubmissionError(`Please remove links from the ${field}`);
  }

  return {
    slug: slugify(name) || 'device',
    name,
    manufacturer: str(body.manufacturer, LIMITS.manufacturer),
    model_numbers: str(body.model_numbers, LIMITS.model_numbers),
    category,
    os: str(body.os, LIMITS.os),
    player: str(body.player, LIMITS.player),
    max_resolution: str(body.max_resolution, LIMITS.max_resolution),
    player_version: str(body.player_version, LIMITS.player_version),
    notes,
    submitter_name: str(body.submitter_name, LIMITS.submitter_name),
    submitter_email: email,
    submitted_ip: ip || null,
    submitted_at: Math.floor(Date.now() / 1000),
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Store a pending submission and return { id, token }. The token is returned ONCE, for the email. */
function create(db, body, ip) {
  const row = normalise(body, ip);
  const token = crypto.randomBytes(32).toString('hex');
  const info = db.prepare(`INSERT INTO hardware_submissions
    (slug, name, manufacturer, model_numbers, category, os, player, max_resolution, player_version,
     notes, submitter_name, submitter_email, submitted_ip, submitted_at, status,
     decision_token_hash, decision_token_expires)
    VALUES (@slug, @name, @manufacturer, @model_numbers, @category, @os, @player, @max_resolution,
     @player_version, @notes, @submitter_name, @submitter_email, @submitted_ip, @submitted_at,
     'pending', @hash, @expires)`)
    .run({ ...row, hash: hashToken(token), expires: row.submitted_at + TOKEN_TTL_SEC });
  return { id: info.lastInsertRowid, token, row };
}

/**
 * Act on an emailed link. Single use: the token is cleared whichever way the decision goes, so the
 * link in an inbox (or a forwarded copy of it) cannot be replayed to flip an entry back.
 */
function decide(db, token, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw new SubmissionError('Unknown decision');
  if (!token || typeof token !== 'string') return null;
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare('SELECT * FROM hardware_submissions WHERE decision_token_hash = ?')
    .get(hashToken(token));
  if (!row) return null;
  if (!row.decision_token_expires || row.decision_token_expires < now) return null;
  db.prepare(`UPDATE hardware_submissions
    SET status = ?, decided_at = ?, decided_by = 'email-link',
        decision_token_hash = NULL, decision_token_expires = NULL
    WHERE id = ?`).run(decision, now, row.id);
  return { ...row, status: decision };
}

/**
 * Approved submissions, shaped as page devices.
 *
 * ⚠️ status and validated_by are written here as constants rather than read from the row. Even if a
 * row were tampered with directly in the database, it still renders as a community report.
 */
function publishedDevices(db) {
  const rows = db.prepare(
    "SELECT * FROM hardware_submissions WHERE status = 'approved' ORDER BY decided_at ASC, id ASC").all();
  const seen = new Set();
  return rows.map((r) => {
    // Anchors must be unique across the whole page or a deep link lands on the wrong device.
    let id = `community-${r.slug}`;
    if (seen.has(id)) id = `${id}-${r.id}`;
    seen.add(id);
    return {
      id,
      name: r.name,
      manufacturer: r.manufacturer,
      model_numbers: r.model_numbers ? r.model_numbers.split(',').map((s) => s.trim()).filter(Boolean) : null,
      category: r.category,
      os: r.os,
      player: r.player,
      status: 'community-reported',
      max_resolution: r.max_resolution,
      validated_on: null,
      validated_by: 'Community',
      player_version: r.player_version,
      min_version: null,
      provisioning_url: null,
      notes: [
        ...(r.notes ? [r.notes] : []),
        `Reported by ${r.submitter_name || 'a user'}. Not tested by ScreenTinker, and not Certified Hardware.`,
      ],
      eol: null,
    };
  });
}

module.exports = {
  create, decide, publishedDevices, normalise, slugify, containsLink, hashToken,
  SubmissionError, CATEGORIES, TOKEN_TTL_SEC, LIMITS,
};
