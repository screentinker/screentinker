'use strict';

/*
 * Inbound hooks: a secret URL another system calls to make something happen on screens.
 *
 * Kinds (automation_hooks.kind):
 *   emergency          raise or clear an emergency alert (headline, message, severity, expiry)
 *   mass_notification  the same, for Alertus, Singlewire InformaCast and anything else that sends
 *                      CAP 1.2 XML or its own JSON — with a lenient, configurable field mapping
 *   trigger            fire (or clear) one of the workspace's triggers on the screens it is assigned to
 *   data               write rows into a Table data source, so slides and menu boards update
 *   playlist           switch screens to a playlist for N minutes (or stop that early)
 *
 * ⚠️ THE RULES, and why:
 *   - The URL secret is 32 random bytes, shown once, stored only as sha256. A wrong secret, an
 *     unknown hook and a disabled hook are all the same 404, compared in constant time, so the door
 *     tells a prober nothing — not even that the hook id exists.
 *   - Optional HMAC signing on top (lib/secretbox stores the signing key): when set, an unsigned or
 *     wrongly signed call is refused (401 — by then the caller has proved it holds the URL).
 *   - Emergency alerts are raised on hidden push-mode CAP feeds owned by the hook, one per screen
 *     selection (cap_feeds.source = 'hook'; see ensureFeed), so the alert card, scopes, severity
 *     ordering, expiry and the payload override are CAP's own (lib/cap/feeds.js) — one emergency
 *     mechanism, not two.
 *   - Every alert is keyed on the SENDER'S alert id. A mass-notification system that retries, or
 *     sends the same alert to two of our hooks' URLs twice, raises it once; a clear sent twice
 *     clears once. Without an id, the exact body is the id, so a duplicate POST is still one alert.
 *   - Templates are `{{body.path.to.value}}` lookups and nothing else — no expressions, no eval, no
 *     prototype walking. Everything a template produces is plain text; the card escapes it.
 *   - A trigger is relayed to the screen exactly as the LAN door would deliver it
 *     (device:trigger-wire, `ST1 <secret> <token>`), so the player's own resolver still decides.
 *     Only players that accept a relayed wire (the native Pi and Windows players) can be fired this
 *     way; the result counts the rest as unsupported rather than pretending.
 */

const crypto = require('crypto');

function dbOf() { return require('../../db/database').db; }

const KINDS = ['emergency', 'mass_notification', 'trigger', 'data', 'playlist'];
const SCOPE_KINDS = new Set(['workspace', 'group', 'device', 'tag']);
const SEVERITIES = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
const DEFAULT_EXPIRES_MIN = { emergency: 60, mass_notification: 120 };
const MAX_EXPIRES_MIN = 7 * 24 * 60;
const MAX_TEXT = 2000;
const CLEAR_WORDS = new Set(['clear', 'cleared', 'allclear', 'all clear', 'all-clear', 'cancel', 'cancelled', 'canceled',
  'end', 'ended', 'resolved', 'inactive', 'stop', 'stopped', 'expired', 'terminated', 'deactivated']);
const PER_HOOK_PER_MIN = 30;

/* ============================== secrets ============================== */

function newSecret() {
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}
function hashSecret(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/** Constant time on the hashes, whatever was given (any length, any bytes). */
function secretMatches(hook, given) {
  const want = Buffer.from(String((hook && hook.secret_hash) || '0'.repeat(64)), 'hex');
  const got = Buffer.from(hashSecret(given == null ? '' : given), 'hex');
  return want.length === got.length && crypto.timingSafeEqual(want, got) && !!hook;
}

/**
 * Check a request signature. Accepted headers, in order: X-ScreenTinker-Signature, X-Signature,
 * X-Hub-Signature-256. Accepted values: `sha256=<hex>`, bare `<hex>`, or `t=<unix>,v1=<hex>` (the
 * timestamped form, signed over "t.body", refused when more than 5 minutes old).
 */
function verifySignature(key, raw, headers, now = Math.floor(Date.now() / 1000)) {
  const h = headers || {};
  const value = String(h['x-screentinker-signature'] || h['x-signature'] || h['x-hub-signature-256'] || '').trim();
  if (!value) return false;
  let t = null;
  let sig = value;
  const parts = Object.fromEntries(value.split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  if (parts.t && parts.v1) { t = parts.t; sig = parts.v1; }
  else if (/^sha256=/i.test(value)) sig = value.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
  if (t !== null) {
    const n = parseInt(t, 10);
    if (!Number.isFinite(n) || Math.abs(now - n) > 300) return false;
  }
  const mac = crypto.createHmac('sha256', String(key)).update(t !== null ? `${t}.` : '').update(raw || Buffer.alloc(0)).digest();
  const got = Buffer.from(sig, 'hex');
  return got.length === mac.length && crypto.timingSafeEqual(got, mac);
}

/* ============================== per-hook rate limit ============================== */

const buckets = new Map();   // hook id -> [timestamps ms]
function allowCall(hookId, nowMs = Date.now()) {
  const list = (buckets.get(hookId) || []).filter((t) => nowMs - t < 60000);
  if (list.length >= PER_HOOK_PER_MIN) { buckets.set(hookId, list); return false; }
  list.push(nowMs);
  buckets.set(hookId, list);
  if (buckets.size > 5000) for (const k of [...buckets.keys()].slice(0, 1000)) buckets.delete(k);
  return true;
}

/* ============================== body + templates ============================== */

/** Parse a raw body by its content type. XML stays text (CAP is parsed by lib/cap/parse). */
function parseBody(raw, contentType) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  const ct = String(contentType || '').toLowerCase();
  const head = text.trimStart().slice(0, 1);
  if (ct.includes('json') || head === '{' || head === '[') {
    try { return { body: JSON.parse(text), text, format: 'json' }; } catch { return { body: null, text, format: 'invalid', error: 'The body is not valid JSON.' }; }
  }
  if (ct.includes('xml') || head === '<') return { body: null, text, format: 'xml' };
  if (ct.includes('x-www-form-urlencoded')) return { body: Object.fromEntries(new URLSearchParams(text)), text, format: 'form' };
  return { body: text ? { text } : {}, text, format: 'text' };
}

const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

/** Resolve "body.a.b.0" / "body.a[0].b" against ctx. Own properties only. undefined when absent. */
function lookup(ctx, path) {
  const parts = String(path || '').trim().replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = ctx;
  for (const p of parts) {
    if (UNSAFE.has(p) || cur == null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

/** Fill `{{path}}` placeholders. Text only: a missing value is empty, never the placeholder. */
function render(tpl, ctx, max = MAX_TEXT) {
  if (tpl == null) return '';
  return String(tpl).replace(/\{\{\s*([A-Za-z0-9_.[\]-]+)\s*\}\}/g, (_, p) => asText(lookup(ctx, p))).slice(0, max).trim();
}

/** A template that is exactly one placeholder returns the raw value (an array of rows, say). */
function renderValue(tpl, ctx) {
  const m = /^\s*\{\{\s*([A-Za-z0-9_.[\]-]+)\s*\}\}\s*$/.exec(String(tpl || ''));
  return m ? lookup(ctx, m[1]) : render(tpl, ctx);
}

/* ============================== validation ============================== */

function validateScopes(db, workspaceId, scopes) {
  if (!Array.isArray(scopes) || !scopes.length) return { error: 'Choose which screens: scopes must be a non-empty list of { scope_kind: workspace|group|device|tag, scope_id }' };
  const out = [];
  const seen = new Set();
  for (const s of scopes.slice(0, 100)) {
    const kind = s && s.scope_kind;
    if (!SCOPE_KINDS.has(kind)) return { error: `invalid scope_kind: ${kind}` };
    const sid = idField(s.scope_id, 'scope_id');
    if (sid.error) return sid;
    let id = kind === 'workspace' ? workspaceId : (sid.id || '');
    if (kind === 'group' && !db.prepare('SELECT 1 FROM device_groups WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) return { error: `group ${id} is not in this workspace` };
    if (kind === 'device' && !db.prepare('SELECT 1 FROM devices WHERE id = ? AND workspace_id = ?').get(id, workspaceId)) return { error: `screen ${id} is not in this workspace` };
    if (kind === 'tag') { id = id.replace(/^#/, '').toLowerCase(); if (!id || id.length > 64) return { error: 'a tag scope needs a tag' }; }
    const k = `${kind}|${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ scope_kind: kind, scope_id: id });
  }
  return { scopes: out };
}

function text(v, max = MAX_TEXT) { return v == null ? '' : String(v).slice(0, max); }

/*
 * ⚠️ AN ID FIELD IS A STRING OR NOTHING. These values come straight from a request body (a hook
 * edit, or a Zapier action) and go into a bound SQL parameter, and better-sqlite3 THROWS on an object
 * or an array ("Too few parameter values were provided") — which, in an async handler, used to be an
 * unhandled rejection and a dead server. Refused here with a 400 instead.
 */
function idField(v, name) {
  if (v === undefined || v === null || v === '') return { id: null };
  if (typeof v === 'string' || typeof v === 'number') return { id: String(v).trim().slice(0, 200) || null };
  return { error: `${name} must be a string` };
}
function minutes(v, def, max) {
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 && n <= max ? n : null;
}

/** Validate a kind's config. Returns { config } or { error }. */
function validateConfig(db, workspaceId, kind, c) {
  c = c && typeof c === 'object' ? c : {};
  if (kind === 'emergency' || kind === 'mass_notification') {
    const sc = validateScopes(db, workspaceId, c.scopes);
    if (sc.error) return sc;
    const exp = minutes(c.expires_min, DEFAULT_EXPIRES_MIN[kind], MAX_EXPIRES_MIN);
    if (exp === null) return { error: `expires_min must be 1–${MAX_EXPIRES_MIN}` };
    const sev = c.severity === undefined ? 'Extreme' : String(c.severity);
    if (!sev.includes('{{') && !SEVERITIES.includes(sev)) return { error: `severity must be one of ${SEVERITIES.join(', ')} (or a {{template}})` };
    const pid = idField(c.playlist_id, 'playlist_id');
    if (pid.error) return pid;
    if (pid.id && !db.prepare('SELECT 1 FROM playlists WHERE id = ? AND workspace_id = ?').get(pid.id, workspaceId)) return { error: 'playlist_id must be a playlist in this workspace' };
    const out = { scopes: sc.scopes, expires_min: exp, severity: sev, playlist_id: pid.id };
    if (kind === 'emergency') {
      const op = c.op || 'raise';
      if (!['raise', 'clear', 'auto'].includes(op)) return { error: 'op must be raise, clear or auto' };
      Object.assign(out, {
        op,
        headline: text(c.headline === undefined ? '{{body.headline}}' : c.headline, 500),
        description: text(c.description === undefined ? '{{body.message}}' : c.description),
        instruction: text(c.instruction || ''),
        event: text(c.event === undefined ? 'Emergency' : c.event, 200),
        alert_id: text(c.alert_id === undefined ? '{{body.id}}' : c.alert_id, 300),
        clear_field: text(c.clear_field === undefined ? '{{body.status}}' : c.clear_field, 300),
      });
      if (op === 'raise' && !out.headline && !out.description) return { error: 'An alert needs a headline or a message.' };
    } else {
      const m = c.mapping && typeof c.mapping === 'object' ? c.mapping : {};
      out.mapping = {};
      for (const k of ['id', 'headline', 'message', 'instruction', 'severity', 'event', 'clear']) if (m[k]) out.mapping[k] = text(m[k], 300);
      out.event = text(c.event || 'Emergency', 200);
    }
    return { config: out };
  }
  if (kind === 'trigger') {
    const tid = idField(c.trigger_id, 'trigger_id');
    if (tid.error) return tid;
    const t = db.prepare('SELECT id, kind FROM triggers WHERE id = ? AND workspace_id = ?').get(tid.id || '', workspaceId);
    if (!t) return { error: 'trigger_id must be a trigger in this workspace' };
    if (t.kind === 'emergency') return { error: "Head office emergency alerts can't be fired from a hook." };
    const op = c.op || 'fire';
    if (!['fire', 'clear'].includes(op)) return { error: 'op must be fire or clear' };
    return { config: { trigger_id: t.id, op } };
  }
  if (kind === 'data') {
    const dsid = idField(c.data_source_id, 'data_source_id');
    if (dsid.error) return dsid;
    const ds = db.prepare('SELECT id, type FROM data_sources WHERE id = ? AND workspace_id = ?').get(dsid.id || '', workspaceId);
    if (!ds) return { error: 'data_source_id must be a data source in this workspace' };
    if (ds.type !== 'table') return { error: 'A hook can write to a Table data source only.' };
    const mode = c.mode || 'replace';
    if (!['replace', 'upsert', 'append'].includes(mode)) return { error: 'mode must be replace, upsert or append' };
    const key = idField(c.key_column, 'key_column');
    if (key.error) return key;
    if (mode === 'upsert' && !key.id) return { error: 'upsert needs key_column' };
    return { config: { data_source_id: ds.id, mode, rows: text(c.rows || '{{body}}', 300), key_column: key.id ? text(key.id, 80) : null } };
  }
  if (kind === 'playlist') {
    const op = c.op || 'start';
    if (!['start', 'stop'].includes(op)) return { error: 'op must be start or stop' };
    const sc = validateScopes(db, workspaceId, c.scopes);
    if (sc.error) return sc;
    const pid = idField(c.playlist_id, 'playlist_id');
    if (pid.error) return pid;
    const pl = db.prepare('SELECT 1 FROM playlists WHERE id = ? AND workspace_id = ?').get(pid.id || '', workspaceId);
    if (op === 'start' && !pl) return { error: 'playlist_id must be a playlist in this workspace' };
    const mins = minutes(c.minutes, 30, require('./overrides').MAX_MINUTES);
    if (mins === null) return { error: 'minutes must be 1–1440' };
    return { config: { op, playlist_id: pid.id, minutes: mins, minutes_field: c.minutes_field ? text(c.minutes_field, 300) : null, scopes: sc.scopes } };
  }
  return { error: `kind must be one of: ${KINDS.join(', ')}` };
}

/** Validate a create/update body. Returns { fields } or { error }. */
function normaliseInput(db, workspaceId, body, existing = null) {
  const b = body || {};
  const out = {};
  const kind = existing ? existing.kind : b.kind;
  if (!existing && !KINDS.includes(kind)) return { error: `kind must be one of: ${KINDS.join(', ')}` };
  if (!existing) out.kind = kind;
  if (b.name !== undefined || !existing) {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return { error: 'name required' };
    out.name = name;
  }
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.config !== undefined || b.allow_get !== undefined || !existing) {
    let cfg;
    if (b.config !== undefined || !existing) {
      const v = validateConfig(db, workspaceId, kind, b.config);
      if (v.error) return v;
      cfg = v.config;
    } else cfg = parseConfig(existing);
    const prev = existing ? parseConfig(existing) : {};
    /*
     * ⚠️ `via` IS THE SERVER'S, NEVER THE FORM'S. The Zapier hook is found by via = 'zapier'
     * (routes/zapier.js); the edit form always sends a whole config, which validateConfig rebuilds
     * without it. Dropping it made the next Zapier call miss the hook an admin had just switched
     * off and create a fresh, enabled one — the off switch bypassed.
     */
    if (prev.via) cfg.via = prev.via;
    else delete cfg.via;
    // GET is opt-in (routes/hooks-in.js): a link preview or a mail scanner must not fire a hook.
    const allowGet = b.allow_get !== undefined ? !!b.allow_get : !!prev.allow_get;
    if (allowGet && !cfg.via) cfg.allow_get = true; else delete cfg.allow_get;
    out.config = JSON.stringify(cfg);
  }
  if (b.signing_secret !== undefined) {
    const s = String(b.signing_secret || '');
    if (s && (s.length < 16 || s.length > 200)) return { error: 'A signing secret must be 16–200 characters.' };
    out.hmac_secret_enc = s ? require('../secretbox').encrypt(s) : null;
  }
  return { fields: out };
}

function parseConfig(row) { try { const v = JSON.parse(row.config || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }

/* ============================== emergency (push-mode CAP feed) ============================== */

function capScopesFor(db, workspaceId, scopes) {
  // CAP scopes are workspace / group / device; a tag is resolved to its screens now.
  const rows = [];
  for (const s of scopes) {
    if (s.scope_kind === 'tag') {
      for (const id of require('./overrides').devicesFor(db, workspaceId, [s])) rows.push({ scope_kind: 'device', scope_id: id });
    } else rows.push(s);
  }
  const seen = new Set();
  return rows.filter((r) => { const k = `${r.scope_kind}|${r.scope_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/*
 * ⚠️ ONE HIDDEN FEED PER SCREEN SELECTION, NOT PER HOOK. A feed has one set of scopes and one card,
 * and the Zapier hook (routes/zapier.js) takes its screens from each CALL. With one feed per hook,
 * Zap B raising on group Y — or a clear by id, whose default scope is the whole workspace — re-scoped
 * the feed and moved Zap A's live alert off group X. So an alert is raised on the hook's feed whose
 * scopes and playlist match ITS call, and keeps them until it ends:
 *   - a raise finds the hook feed with exactly these scopes + playlist, else re-scopes one of the
 *     hook's feeds that has nothing live (which moves nobody's alert), else adds a feed;
 *   - a clear never touches scopes: it ends the named alert (or, with no id, every alert) on all of
 *     the hook's feeds;
 *   - the same alert id raised again with different screens is the sender moving ITS OWN alert: it
 *     ends on the old feed and goes live on the new one.
 * The first feed is hook.feed_id (url `hook:<id>`); the others are `hook:<id>|<n>`.
 */
const MAX_FEEDS_PER_HOOK = 20;

/** Every hidden feed a hook owns, oldest first. */
function hookFeeds(db, hook) {
  return db.prepare(`SELECT * FROM cap_feeds WHERE workspace_id = ? AND source = 'hook'
      AND (id = ? OR url = ? OR substr(url, 1, ?) = ?) ORDER BY created_at, rowid`)
    .all(hook.workspace_id, hook.feed_id || '', `hook:${hook.id}`, `hook:${hook.id}|`.length, `hook:${hook.id}|`);
}

function feedSig(scopes, playlistId) {
  return JSON.stringify([scopes.map((r) => `${r.scope_kind}|${r.scope_id}`).sort(), playlistId || null]);
}

/** The hook's feed for these screens + playlist (see above). Returns { feed, left } or { error }. */
function ensureFeed(db, hook, cfg) {
  const feeds = require('../cap/feeds');
  const resolved = capScopesFor(db, hook.workspace_id, cfg.scopes || []);
  const rows = resolved.length ? resolved : [{ scope_kind: 'device', scope_id: '__none__' }];
  const playlistId = cfg.playlist_id || null;
  const sig = feedSig(rows, playlistId);
  const all = hookFeeds(db, hook);
  let feed = all.find((f) => feedSig(feeds.scopesOf(db, f.id), f.playlist_id) === sig) || null;
  let left = [];
  if (!feed) {
    // A feed with nothing live can be re-pointed: no screen is showing anything from it.
    feed = all.find((f) => !feeds.liveAlerts(db, f).length) || null;
    if (feed) {
      const before = new Set(feeds.devicesInScope(db, feed));
      feeds.setScopes(db, feed.id, rows);
      db.prepare('UPDATE cap_feeds SET playlist_id = ? WHERE id = ?').run(playlistId, feed.id);
      const after = new Set(feeds.devicesInScope(db, feed));
      left = [...before].filter((d) => !after.has(d));
    } else if (all.length >= MAX_FEEDS_PER_HOOK) {
      return { error: `This hook already has live alerts on ${MAX_FEEDS_PER_HOOK} different screen selections. Clear some first.` };
    } else {
      const id = crypto.randomUUID();
      const url = all.length ? `hook:${hook.id}|${crypto.randomBytes(6).toString('hex')}` : `hook:${hook.id}`;
      db.prepare(`INSERT INTO cap_feeds (id, workspace_id, user_id, name, url, enabled, poll_sec, min_severity, language, playlist_id, source)
        VALUES (?, ?, ?, ?, ?, 1, 3600, 'Unknown', 'en', ?, 'hook')`)
        .run(id, hook.workspace_id, hook.created_by || null, hook.name, url, playlistId);
      feeds.setScopes(db, id, rows);
      if (!all.length) { db.prepare('UPDATE automation_hooks SET feed_id = ? WHERE id = ?').run(id, hook.id); hook.feed_id = id; }
      feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(id);
    }
  }
  db.prepare("UPDATE cap_feeds SET name = ?, enabled = 1, min_severity = 'Unknown', updated_at = strftime('%s','now') WHERE id = ?")
    .run(hook.name, feed.id);
  feed = db.prepare('SELECT * FROM cap_feeds WHERE id = ?').get(feed.id);
  feeds.ensureWidget(db, feed);
  return { feed, left };
}

function severityFrom(v, fallback) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return fallback;
  const direct = SEVERITIES.find((x) => x.toLowerCase() === s);
  if (direct) return direct;
  if (/critical|emergency|extreme|life|lockdown|evacuat|fire|shooter|tornado/.test(s)) return 'Extreme';
  if (/high|severe|major|urgent|warning/.test(s)) return 'Severe';
  if (/medium|moderate|watch/.test(s)) return 'Moderate';
  if (/low|minor|info|advisory|test/.test(s)) return 'Minor';
  return fallback;
}

// Whole seconds: CAP's liveness clock is in seconds, so an alert stamped 10:00:00.814 would not be
// live until 10:00:01 — and the refresh that follows the push runs at 10:00:00.
const nowSecond = () => new Date(Math.floor(Date.now() / 1000) * 1000);

function makeAlert(hook, { id, headline, description, instruction, event, severity, expiresMin, sent = nowSecond() }) {
  return {
    identifier: String(id).slice(0, 300), sender: `hook:${hook.id}`, sent: sent.toISOString(),
    status: 'Actual', msgType: 'Alert', references: [],
    event: text(event, 200) || 'Emergency', severity, urgency: 'Immediate', certainty: 'Observed',
    headline: text(headline, 500), description: text(description), instruction: text(instruction), senderName: hook.name,
    areaDesc: '', geocodes: [], effective: sent.toISOString(), onset: null,
    expires: new Date(sent.getTime() + expiresMin * 60000).toISOString(), ends: null, language: 'en',
  };
}

function bodyId(parsed) { return `sha256:${crypto.createHash('sha256').update(parsed.text || '').digest('hex').slice(0, 32)}`; }

function isClearValue(v) {
  if (v === true) return true;
  if (v == null || v === false) return false;
  return CLEAR_WORDS.has(String(v).trim().toLowerCase());
}

/** Raise/clear on the hook's feeds. `alerts` are CAP-shaped; `clears` are identifiers ([] none, null all). */
function applyEmergency(db, hook, cfg, { alerts = [], clears = [] }) {
  const feeds = require('../cap/feeds');
  const { alertKey, referenceKey } = require('../cap/parse');
  const touched = new Map();   // feed id -> screens that left it and need their normal payload back
  let raised = [];
  let ended = [];
  let screens = new Set();
  if (alerts.length) {
    const ef = ensureFeed(db, hook, cfg);
    if (ef.error) return { ok: false, status: 409, outcome: ef.error };
    const { feed, left } = ef;
    touched.set(feed.id, left);
    // What this push ends or moves, wherever it currently lives among the hook's other feeds.
    const keys = [];
    for (const a of alerts) {
      if (!a || !a.identifier) continue;
      keys.push(alertKey(a));
      if (a.msgType === 'Update' || a.msgType === 'Cancel') for (const r of a.references || []) keys.push(referenceKey(r));
    }
    for (const f of hookFeeds(db, hook)) {
      if (f.id === feed.id) continue;
      const e = feeds.endPushed(db, f, keys);
      if (e.length) { ended = ended.concat(e); touched.set(f.id, touched.get(f.id) || []); }
    }
    const r = feeds.applyPush(db, feed, alerts);
    raised = r.raised;
    // A move is not a clear: an alert that went live here is not also counted as cleared there.
    ended = ended.filter((k) => !raised.includes(k)).concat(r.ended);
    for (const d of feeds.devicesInScope(db, feed)) screens.add(d);
  } else if (clears === null || clears.length) {
    // A clear never re-scopes anything: it ends what it names wherever it is.
    for (const f of hookFeeds(db, hook)) {
      const e = feeds.endPushed(db, f, clears === null ? null : clears.map((id) => `hook:${hook.id}|${id}`));
      if (!e.length) continue;
      ended = ended.concat(e);
      touched.set(f.id, []);
      for (const d of feeds.devicesInScope(db, f)) screens.add(d);
    }
  }
  for (const [id, extra] of touched) feeds.refresh(db, id, { extraDevices: extra, force: extra.length > 0 });
  const n = screens.size;
  const parts = [];
  if (raised.length) parts.push(`raised ${raised.length}`);
  if (ended.length) parts.push(`cleared ${ended.length}`);
  if (!parts.length) parts.push('no change (already raised or cleared)');
  return { ok: true, raised: raised.length, cleared: ended.length, screens: n, outcome: `${parts.join(', ')} on ${n} screen(s)` };
}

function runEmergency(db, hook, cfg, ctx, parsed) {
  if (parsed.format === 'xml') return runMassNotification(db, hook, { ...cfg, mapping: {} }, ctx, parsed);
  const id = render(cfg.alert_id, ctx, 300) || bodyId(parsed);
  let op = cfg.op;
  if (op === 'auto') op = isClearValue(renderValue(cfg.clear_field, ctx)) ? 'clear' : 'raise';
  if (op === 'clear') {
    // "Clear" with no id given clears everything this hook raised (an all-clear).
    const explicit = render(cfg.alert_id, ctx, 300);
    return applyEmergency(db, hook, cfg, { clears: explicit ? [explicit] : null });
  }
  const headline = render(cfg.headline, ctx, 500);
  const description = render(cfg.description, ctx);
  if (!headline && !description) return { ok: false, status: 422, outcome: 'Nothing to show: the headline and message templates were both empty for this body.' };
  const alert = makeAlert(hook, {
    id, headline, description, instruction: render(cfg.instruction, ctx), event: render(cfg.event, ctx, 200),
    severity: severityFrom(render(cfg.severity, ctx, 60), 'Extreme'), expiresMin: cfg.expires_min || DEFAULT_EXPIRES_MIN.emergency,
  });
  return applyEmergency(db, hook, cfg, { alerts: [alert] });
}

/* ============================== mass notification (Alertus / InformaCast / CAP) ============================== */

const FIELD_GUESS = {
  id: ['id', 'alertId', 'alert_id', 'alertID', 'messageId', 'message_id', 'notificationId', 'notification_id', 'incidentId', 'incident_id', 'uuid', 'guid', 'identifier'],
  headline: ['headline', 'title', 'subject', 'alertName', 'alert_name', 'name', 'messageTitle', 'message_title', 'messageTypeName', 'presetName', 'alertProfile'],
  message: ['message', 'body', 'text', 'description', 'alertText', 'alert_text', 'messageBody', 'message_body', 'content', 'details', 'textMessage'],
  instruction: ['instruction', 'instructions', 'action', 'actions', 'whatToDo'],
  severity: ['severity', 'priority', 'level', 'urgency', 'alertLevel', 'alert_level'],
  event: ['event', 'type', 'alertType', 'alert_type', 'category', 'messageType', 'message_type'],
  // A value from one of these that reads as "clear" (cleared, cancelled, ended, true for the booleans).
  clear: ['status', 'state', 'action', 'alertStatus', 'alert_status', 'eventType', 'event_type', 'cleared', 'isClear', 'is_clear', 'allClear', 'all_clear'],
  // And these mean "still going" — so an explicit false is the clear.
  active: ['active', 'isActive', 'is_active'],
};

/** First non-empty value among the candidate keys, at the top level or one level down (data/alert/message/payload). */
function guess(body, keys) {
  const roots = [body];
  for (const k of ['data', 'alert', 'message', 'notification', 'payload', 'event', 'incident']) {
    if (body && typeof body === 'object' && body[k] && typeof body[k] === 'object' && !Array.isArray(body[k])) roots.push(body[k]);
  }
  for (const r of roots) for (const k of keys) {
    if (r && Object.prototype.hasOwnProperty.call(r, k) && r[k] !== null && r[k] !== '' && typeof r[k] !== 'object') return r[k];
  }
  return undefined;
}

function pickField(cfg, ctx, body, field) {
  const tpl = cfg.mapping && cfg.mapping[field];
  if (tpl) return renderValue(tpl, ctx);
  return guess(body, FIELD_GUESS[field]);
}

function runMassNotification(db, hook, cfg, ctx, parsed) {
  const expiresMin = cfg.expires_min || DEFAULT_EXPIRES_MIN.mass_notification;
  if (parsed.format === 'xml') {
    // CAP 1.2: Alert / Update / Cancel, keyed on the sender's own sender + identifier.
    let alerts;
    try { alerts = require('../cap/parse').parseFeed(parsed.text).alerts; } catch (e) { return { ok: false, status: 422, outcome: e.message }; }
    if (!alerts.length) return { ok: false, status: 422, outcome: 'No CAP alert in the body.' };
    const now = nowSecond();
    for (const a of alerts) {
      // Exercise / Test / System messages never take a screen.
      if (!a.sent) a.sent = now.toISOString();
      if (!a.expires) a.expires = new Date(Date.parse(a.sent) + expiresMin * 60000).toISOString();
      if (!a.identifier) a.identifier = bodyId(parsed);
      if (!a.sender) a.sender = `hook:${hook.id}`;
    }
    const out = applyEmergency(db, hook, cfg, { alerts });
    const skipped = alerts.filter((a) => a.status !== 'Actual').length;
    if (skipped) out.outcome += `; ${skipped} not Actual (test/exercise) and not shown`;
    return out;
  }
  if (parsed.format === 'invalid') return { ok: false, status: 400, outcome: parsed.error };
  const body = parsed.body && typeof parsed.body === 'object' ? parsed.body : {};
  const id = asText(pickField(cfg, ctx, body, 'id')) || bodyId(parsed);
  const active = cfg.mapping && cfg.mapping.clear ? undefined : guess(body, FIELD_GUESS.active);
  const isClear = isClearValue(pickField(cfg, ctx, body, 'clear')) || active === false || String(active).toLowerCase() === 'false';
  if (isClear) {
    const explicit = asText(pickField(cfg, ctx, body, 'id'));
    return applyEmergency(db, hook, cfg, { clears: explicit ? [explicit] : null });
  }
  const headline = asText(pickField(cfg, ctx, body, 'headline'));
  const message = asText(pickField(cfg, ctx, body, 'message'));
  if (!headline && !message) return { ok: false, status: 422, outcome: 'No headline or message found in the body. Set a field mapping for this sender.' };
  const alert = makeAlert(hook, {
    id, headline: headline || message.slice(0, 120), description: headline ? message : '',
    instruction: asText(pickField(cfg, ctx, body, 'instruction')),
    event: asText(pickField(cfg, ctx, body, 'event')) || cfg.event,
    severity: severityFrom(asText(pickField(cfg, ctx, body, 'severity')), cfg.severity && !cfg.severity.includes('{{') ? cfg.severity : 'Extreme'),
    expiresMin,
  });
  return applyEmergency(db, hook, cfg, { alerts: [alert] });
}

/* ============================== trigger relay ============================== */

function runTrigger(db, hook, cfg, io) {
  const t = db.prepare('SELECT * FROM triggers WHERE id = ? AND workspace_id = ?').get(cfg.trigger_id, hook.workspace_id);
  if (!t) return { ok: false, status: 409, outcome: 'The trigger no longer exists.' };
  const token = cfg.op === 'clear' ? t.clear_token : t.match_token;
  if (!token) return { ok: false, status: 409, outcome: 'That trigger has no clear code.' };
  const devices = db.prepare(`SELECT DISTINCT d.* FROM trigger_assignments ta JOIN devices d ON d.workspace_id = ?
      AND ((ta.target_type = 'device' AND ta.target_id = d.id)
        OR (ta.target_type = 'group' AND ta.target_id IN (SELECT group_id FROM device_group_members WHERE device_id = d.id)))
    WHERE ta.trigger_id = ?`).all(hook.workspace_id, t.id);
  const { platformFamily } = require('../player-capabilities');
  const ns = io && io.of('/device');
  const counts = { sent: 0, offline: 0, unsupported: 0, no_secret: 0 };
  for (const d of devices) {
    const fam = platformFamily(d);
    if (fam !== 'linux' && fam !== 'windows') { counts.unsupported++; continue; }
    if (!d.trigger_secret) { counts.no_secret++; continue; }
    const room = ns && ns.adapter.rooms.get(d.id);
    if (!room || !room.size) { counts.offline++; continue; }
    ns.to(d.id).emit('device:trigger-wire', { text: `ST1 ${d.trigger_secret} ${token}`, source: 'server', sourceIp: 'automation' });
    counts.sent++;
  }
  const outcome = `${cfg.op === 'clear' ? 'cleared' : 'fired'} "${t.name}" on ${counts.sent} screen(s)`
    + (counts.offline ? `; ${counts.offline} offline` : '')
    + (counts.unsupported ? `; ${counts.unsupported} can't be fired over the internet (LAN only)` : '')
    + (counts.no_secret ? `; ${counts.no_secret} have triggers switched off` : '');
  return { ok: true, ...counts, outcome };
}

/* ============================== table data source ============================== */

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const k of ['rows', 'items', 'data', 'records', 'results']) if (Array.isArray(value[k])) return value[k];
    return [value];
  }
  return null;
}

async function runData(db, hook, cfg, ctx) {
  const ds = db.prepare('SELECT * FROM data_sources WHERE id = ? AND workspace_id = ?').get(cfg.data_source_id, hook.workspace_id);
  if (!ds || ds.type !== 'table') return { ok: false, status: 409, outcome: 'The Table data source no longer exists.' };
  let conf;
  try { conf = JSON.parse(ds.config || '{}'); } catch { conf = {}; }
  const columns = Array.isArray(conf.columns) ? conf.columns : [];
  if (!columns.length) return { ok: false, status: 409, outcome: 'The table has no columns yet.' };
  const incoming = rowsFrom(renderValue(cfg.rows, ctx));
  if (!incoming) return { ok: false, status: 422, outcome: 'No rows in the body (send an array, or an object with rows/items).' };
  const lower = columns.map((c) => String(c).toLowerCase());
  const toRow = (r) => {
    if (Array.isArray(r)) return columns.map((_, i) => asText(r[i]).slice(0, 2000));
    if (r && typeof r === 'object') {
      const keyed = new Map(Object.keys(r).filter((k) => !UNSAFE.has(k)).map((k) => [k.toLowerCase(), r[k]]));
      return lower.map((c) => asText(keyed.get(c)).slice(0, 2000));
    }
    return [asText(r).slice(0, 2000), ...columns.slice(1).map(() => '')];
  };
  const fresh = incoming.slice(0, 500).map(toRow);
  let rows;
  if (cfg.mode === 'replace') rows = fresh;
  else if (cfg.mode === 'append') rows = (conf.rows || []).concat(fresh);
  else {
    const ki = lower.indexOf(String(cfg.key_column).toLowerCase());
    if (ki < 0) return { ok: false, status: 409, outcome: `The table has no column named ${cfg.key_column}.` };
    rows = (conf.rows || []).slice();
    for (const r of fresh) {
      const at = rows.findIndex((x) => String(x[ki]) === String(r[ki]));
      if (at >= 0) rows[at] = r; else rows.push(r);
    }
  }
  const { MAX_ROWS, validateTableConfig } = require('../data-sources/table-resolver');
  if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
  const next = { ...conf, rows };
  const err = validateTableConfig(next);
  if (err) return { ok: false, status: 422, outcome: err };
  db.prepare("UPDATE data_sources SET config = ?, last_fetched_at = 0, updated_at = strftime('%s','now') WHERE id = ?").run(JSON.stringify(next), ds.id);
  try {
    await require('../data-sources/service').syncDataSource(ds.id, false);
  } catch (e) {
    return { ok: false, status: 500, outcome: `Rows saved, but the data source could not refresh: ${e && e.message}` };
  }
  return { ok: true, rows: rows.length, outcome: `${cfg.mode === 'replace' ? 'replaced the table with' : cfg.mode === 'append' ? 'appended' : 'upserted'} ${fresh.length} row(s); the table has ${rows.length}` };
}

/* ============================== playlist override ============================== */

function runPlaylist(db, hook, cfg, ctx) {
  const ov = require('./overrides');
  if (cfg.op === 'stop') {
    const n = ov.stop(db, { workspaceId: hook.workspace_id, hookId: hook.id });
    return { ok: true, screens: n, outcome: `released ${n} screen(s)` };
  }
  let mins = cfg.minutes;
  if (cfg.minutes_field) {
    const v = parseInt(asText(renderValue(cfg.minutes_field, ctx)), 10);
    if (Number.isFinite(v) && v >= 1) mins = Math.min(v, ov.MAX_MINUTES);
  }
  const r = ov.start(db, { workspaceId: hook.workspace_id, hookId: hook.id, playlistId: cfg.playlist_id, minutes: mins, scopes: cfg.scopes });
  if (r.error) return { ok: false, status: 409, outcome: r.error };
  return { ok: true, screens: r.devices, ends_at: r.ends_at, outcome: `switched ${r.devices} screen(s) for ${mins} minute(s)` };
}

/* ============================== run ============================== */

/**
 * Run a hook against a parsed request. ctx = { body, query }. Returns
 * { ok, status (HTTP to answer), outcome (one line for the log), ...counts }.
 */
async function run(db, hook, parsed, { query = {}, io = null, test = false, log = true } = {}) {
  const cfg = parseConfig(hook);
  const ctx = { body: parsed.body == null ? {} : parsed.body, query: query || {}, hook: { name: hook.name } };
  let r;
  try {
    if (hook.kind === 'emergency') r = runEmergency(db, hook, cfg, ctx, parsed);
    else if (hook.kind === 'mass_notification') r = runMassNotification(db, hook, cfg, ctx, parsed);
    else if (hook.kind === 'trigger') r = runTrigger(db, hook, cfg, io);
    else if (hook.kind === 'data') r = await runData(db, hook, cfg, ctx);
    else if (hook.kind === 'playlist') r = runPlaylist(db, hook, cfg, ctx);
    else r = { ok: false, status: 500, outcome: 'Unknown hook kind' };
  } catch (e) {
    console.error(`[automation] hook ${hook.id} failed:`, e && e.message);
    r = { ok: false, status: 500, outcome: 'The hook failed on our side.' };
  }
  const status = r.ok ? 200 : (r.status || 500);
  if (log) record(db, hook, status, r.outcome, test);
  return { ...r, status };
}

function record(db, hook, status, outcome, test = false) {
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare('INSERT INTO automation_hook_calls (hook_id, at, status, outcome, test) VALUES (?, ?, ?, ?, ?)').run(hook.id, now, status, String(outcome || '').slice(0, 500), test ? 1 : 0);
    db.prepare('UPDATE automation_hooks SET last_called_at = ?, call_count = call_count + 1 WHERE id = ?').run(now, hook.id);
    db.prepare('DELETE FROM automation_hook_calls WHERE hook_id = ? AND id NOT IN (SELECT id FROM automation_hook_calls WHERE hook_id = ? ORDER BY id DESC LIMIT 100)').run(hook.id, hook.id);
  } catch (_) { /* the log is best effort; the action already happened */ }
}

/** Remove a hook and everything it owns (its feeds — clearing what it raised — and its overrides). */
function removeHook(db, hook) {
  const feeds = require('../cap/feeds');
  const gone = [];
  for (const feed of hookFeeds(db, hook)) {
    gone.push({ id: feed.id, devices: feeds.devicesInScope(db, feed) });
    if (feed.widget_id) db.prepare('DELETE FROM widgets WHERE id = ?').run(feed.widget_id);
    db.prepare('DELETE FROM cap_alerts WHERE feed_id = ?').run(feed.id);
    db.prepare('DELETE FROM cap_feed_scopes WHERE feed_id = ?').run(feed.id);
    db.prepare('DELETE FROM cap_feeds WHERE id = ?').run(feed.id);
  }
  require('./overrides').stop(db, { workspaceId: hook.workspace_id, hookId: hook.id });
  db.prepare('DELETE FROM automation_hook_calls WHERE hook_id = ?').run(hook.id);
  db.prepare('DELETE FROM automation_hooks WHERE id = ?').run(hook.id);
  for (const g of gone) feeds.refresh(db, g.id, { extraDevices: g.devices, force: true });
}

/** End everything a hook has live (switching it off). Re-enabling does not resurrect it. */
function endAll(db, hook) {
  const feeds = require('../cap/feeds');
  for (const feed of hookFeeds(db, hook)) { feeds.endPushed(db, feed, null); feeds.refresh(db, feed.id); }
}

/** How many alerts a hook has on screens now, across its feeds. */
function liveCount(db, hook) {
  const feeds = require('../cap/feeds');
  return hookFeeds(db, hook).reduce((n, f) => n + feeds.liveAlerts(db, f).length, 0);
}

function _resetBuckets() { buckets.clear(); }

module.exports = {
  KINDS, SEVERITIES, newSecret, hashSecret, secretMatches, verifySignature, allowCall, parseBody, lookup, render, renderValue,
  normaliseInput, validateConfig, parseConfig, run, record, removeHook, endAll, liveCount, hookFeeds, severityFrom, isClearValue, guess, FIELD_GUESS,
  _resetBuckets,
};
