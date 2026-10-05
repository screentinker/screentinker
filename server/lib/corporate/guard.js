'use strict';

/*
 * THE CORPORATE GUARD — one place that answers "may this actor do this to head office's content
 * or a screen head office controls?", called at the existing chokepoints (each call site is one
 * line). The backstop (lib/corporate/backstop.js) is the belt; this is what gives the operator a
 * message they can act on.
 *
 * Vocabulary (spec §1.4):
 *   governed playlist  — corporate = 1, or the child_playlist_id of a row in a corporate playlist.
 *                        Only corporate AUTHORS may change one (org owners/admins, platform admin,
 *                        and HQ editors when the org opts in). Never an API token (D12).
 *   mandate            — "these screens play head office's playlist". Overrides of a mandated
 *                        screen (assign, schedule, layout, reorder, fork, group playlist) are
 *                        refused: 403 for a store user, 409 SHADOWS for an author (the mandate is
 *                        what they should change instead).
 *   device controls    — the commands that blank, cover or detach a mandated screen are org-admin
 *                        only (D13); the rest are allowed and audited.
 *
 * ⚠️ `runtime.active(db)` short-circuits every check that the rest of the product calls on a
 * DEVICE or GROUP: an install with no mandates behaves exactly as before. The author check on a
 * governed PLAYLIST and the media check do not short-circuit on it — they only ever bite on rows
 * someone deliberately made corporate, and a corporate playlist must stay locked to non-authors
 * before it is first assigned, too.
 */

const runtime = require('./runtime');
const actorLib = require('./actor');
const resolve = require('./resolve');

function dbOf() { return require('../../db/database').db; }

class CorporateError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'CorporateError';
    this.status = status;
    this.code = code;
    this.details = details || {};
  }
}

/* ── Messages (spec §4.8). Server English; the UI maps `code` to i18n. ─────────────────────── */

const q = (s) => `"${s || ''}"`;
const MESSAGES = {
  CORPORATE_LOCKED: (v) => `This is part of your head office's playlist ${q(v.name)}, so it can't be changed here. You can change what plays in your local slot instead.`,
  CORPORATE_NO_SLOT: (v) => `This screen plays your head office's playlist ${q(v.name)}. It has no space for local content, so nothing can be added here. Ask your organization admin if you need some.`,
  CORPORATE_SLOT_REQUIRED: (v) => `Head office's playlist ${q(v.name)} has more than one local slot. Choose which slot to add to.`,
  CORPORATE_OVERRIDE: (v) => `This screen must play your head office's playlist ${q(v.name)}. Only your organization's admins can change that.`,
  CORPORATE_SCHEDULE: (v) => `This screen plays your head office's playlist ${q(v.name)}, so a schedule here would never show. To change what plays at certain times, set times on the items in your local slot.`,
  CORPORATE_MANDATE_SHADOWS: (v) => `This screen plays corporate playlist ${q(v.name)} because of the assignment on ${v.target}. Change that assignment instead.`,
  CORPORATE_EDIT_IN_EDITOR: (v) => `This item belongs to corporate playlist ${q(v.name)}. Edit it in that playlist.`,
  CORPORATE_MEDIA: (v) => `This is used by your head office's playlist ${q(v.name)}. Only your organization's admins can change or delete it.`,
  CORPORATE_AUTHOR_REQUIRED: () => "Only your organization's admins can change corporate playlists.",
  CORPORATE_ADMIN_REQUIRED: () => "Only your organization's owners and admins can assign corporate playlists or change these settings.",
  CORPORATE_TOKEN: () => "Corporate playlists can't be changed with an API token. Sign in to the dashboard as an organization admin.",
  CORPORATE_EMERGENCY: () => "Emergency alerts are managed by your organization's admins, under Corporate → Emergency.",
  CORPORATE_WALL_SPLIT: (v) => `This would split the video wall ${q(v.wall)}: some of its screens would play head office's playlist and others would not. Change the whole wall together.`,
  CORPORATE_MANDATED: (v) => `This corporate playlist plays in ${v.n} place${v.n === 1 ? '' : 's'} (${v.screens} screen${v.screens === 1 ? '' : 's'}). Remove it from "Where it plays" first.`,
  CORPORATE_MEMBERSHIP: (v) => v.text,
  CORPORATE_DEVICE_CONTROL: (v) => v.emergency
    ? "Head office manages trigger settings on this screen because of its emergency alerts. Ask your organization's admins to change them."
    : `This screen plays your head office's playlist ${q(v.name)}, so only your organization's admins can ${v.action_label || 'do that'}. You can still restart it and change its volume.`,
  CORPORATE_NOT_PUBLISHED: () => 'Publish this playlist before assigning it, or the screens would have nothing to play.',
  CORPORATE_TARGET_TAKEN: (v) => `${v.target} already has a corporate playlist (${q(v.name)}). Change that assignment instead.`,
  CORPORATE_MESH_UNSUPPORTED: (v) => `${v.workspace || 'This workspace'} is shared with another server. Corporate playlists don't work across servers yet.`,
  CORPORATE_UNAVAILABLE: () => 'Corporate playlists are unavailable on this server: the upgrade safety check failed. See the server log.',
  CORPORATE_DISABLED: () => 'Corporate playlists are turned off for this organization.',
  CORPORATE_NESTED: () => "A corporate playlist can't be placed inside another playlist. Assign it to stores instead.",
  CORPORATE_SMART: () => "A corporate playlist can't be a smart playlist. Put a smart playlist inside it instead.",
  CORPORATE_SLOT_FIELD: () => 'Add slots with POST /api/corporate/playlists/:id/slots.',
  CORPORATE_HQ_IN_USE: (v) => `${q(v.workspace)} is your organization's head office workspace and its corporate playlists play on ${v.screens} screen${v.screens === 1 ? '' : 's'}. Remove them from "Where it plays" first.`,
  // Local slots (Stage B).
  FILL_LIMIT: (v) => {
    const cap = [v.max_items != null ? `${v.max_items} item${v.max_items === 1 ? '' : 's'}` : null, v.max_sec != null ? `${v.max_sec} seconds` : null].filter(Boolean).join(' and ');
    const now = [v.max_items != null ? `${v.n} item${v.n === 1 ? '' : 's'}` : null, v.max_sec != null ? `${v.sec} seconds` : null].filter(Boolean).join(' and ');
    // At an add (or an edit) nothing changed yet: say what it WOULD make, not what it "now has".
    if (v.at === 'add') return `Your slot ${q(v.slot)} can hold up to ${cap}. Adding this would make ${now}, so it wasn't added. Remove something first.`;
    if (v.at === 'edit') return `Your slot ${q(v.slot)} can hold up to ${cap}. This change would make ${now}, so it wasn't made.`;
    return `Your slot ${q(v.slot)} can hold up to ${cap}. It now has ${now}. Remove something, then publish again.`;
  },
  FILL_FLAT: () => 'Your slot can hold pictures, videos and widgets — not other playlists.',
  FILL_LIVE: (v) => `${q(v.item)} has no fixed length (a live stream, a YouTube video or a web video we can't measure), so it can't go in a slot.`,
  FILL_TYPE: (v) => `Head office allows only ${v.types} in the slot ${q(v.slot)}.`,
  CORPORATE_SLOT_SWAP: () => "A slot can't be turned into an item. Remove the slot instead.",
  CORPORATE_SLOT_DUPLICATE: () => "A local slot can't be duplicated. Add another slot instead.",
  CORPORATE_SLOT_REMOVE: () => 'Use "Remove slot" to take a local slot out of the playlist.',
  CORPORATE_SLOT_SCHEDULE: () => "Set times on the slot's items, not on the slot itself.",
  CORPORATE_SLOT_REPEAT: () => "A local slot can't repeat on its own interval. Set it on head office's items instead.",
  CORPORATE_FILL_EXISTS: (v) => `${v.label || 'This level'} already has its own content for the slot ${q(v.slot)}. Edit that instead.`,
  // Emergency alerts (Stage C).
  CORPORATE_EMERGENCY_OFF: () => "Emergency alerts are switched off for your organization. An owner or admin can switch them on in Settings → Organization → Corporate content.",
  CORPORATE_EMERGENCY_ACTIVE: (v) => `${q(v.name)} is already showing. End it first, or wait for it to finish.`,
  CORPORATE_EMERGENCY_DISABLED: (v) => `${q(v.name)} is turned off. Turn it on before you activate it.`,
  CORPORATE_EMERGENCY_TOKEN: (v) => v.text,
  CORPORATE_IMPACT_UNACKNOWLEDGED: (v) => `This changes ${v.n} store trigger${v.n === 1 ? '' : 's'} on screens that play head office's playlist. Check the list, then confirm.`,
  CORPORATE_STORE_TRIGGERS_IMPACT: (v) => `This hides or limits ${v.n} store trigger${v.n === 1 ? '' : 's'} on screens head office will start driving. Check the list, then confirm.`,
  CORPORATE_FILL_SCOPE: () => "That screen, group or video wall isn't in this workspace, or head office's playlist doesn't play there.",
};

const STATUS = {
  CORPORATE_SLOT_REQUIRED: 409, CORPORATE_MANDATE_SHADOWS: 409, CORPORATE_EDIT_IN_EDITOR: 409,
  CORPORATE_WALL_SPLIT: 409, CORPORATE_MANDATED: 409, CORPORATE_NOT_PUBLISHED: 409,
  CORPORATE_TARGET_TAKEN: 409, CORPORATE_MESH_UNSUPPORTED: 409, CORPORATE_DISABLED: 409,
  CORPORATE_HQ_IN_USE: 409, CORPORATE_UNAVAILABLE: 503,
  CORPORATE_NESTED: 400, CORPORATE_SMART: 400, CORPORATE_SLOT_FIELD: 400,
  FILL_LIMIT: 400, FILL_FLAT: 400, FILL_LIVE: 400, FILL_TYPE: 400,
  CORPORATE_SLOT_SWAP: 400, CORPORATE_SLOT_DUPLICATE: 400, CORPORATE_SLOT_REMOVE: 400,
  CORPORATE_SLOT_SCHEDULE: 400, CORPORATE_SLOT_REPEAT: 400, CORPORATE_FILL_EXISTS: 409, CORPORATE_FILL_SCOPE: 400,
  CORPORATE_EMERGENCY_OFF: 409, CORPORATE_EMERGENCY_ACTIVE: 409, CORPORATE_EMERGENCY_DISABLED: 409,
  CORPORATE_EMERGENCY_TOKEN: 409, CORPORATE_IMPACT_UNACKNOWLEDGED: 409,
  CORPORATE_STORE_TRIGGERS_IMPACT: 409,
};

function err(code, vars = {}, details = {}, statusOverride) {
  const msg = (MESSAGES[code] || (() => code))(vars);
  return new CorporateError(statusOverride || STATUS[code] || 403, code, msg, details);
}

/* ── Denial audit, coalesced per user+code+target per minute ───────────────────────────────── */

const _denied = new Map();
function logDenied(actor, e, route) {
  try {
    const target = (e.details && (e.details.target_id || e.details.playlist_id || e.details.device_id)) || '';
    const key = `${actor && actor.userId}|${e.code}|${target}`;
    const now = Date.now();
    if (now - (_denied.get(key) || 0) < 60000) return;
    _denied.set(key, now);
    if (_denied.size > 2000) _denied.clear();
    require('../audit').audit('corporate.denied', {
      userId: actor && actor.userId, workspaceId: e.details && e.details.workspace_id || null,
      details: { code: e.code, route: route || null, target: target || null },
    });
  } catch (_) { /* never let the audit trail break the refusal */ }
}

/** Turn any corporate refusal (CorporateError or a backstop RAISE) into {status, body}, else null. */
function toResponse(e) {
  if (!e) return null;
  if (e.name === 'CorporateError') {
    const body = { error: e.message, code: e.code };
    if (e.details && e.details.corporate) body.corporate = e.details.corporate;
    for (const k of ['slots', 'mandates', 'skipped', 'mandated_members', 'slot_id', 'fill_id', 'limits', 'fill', 'impact']) if (e.details && e.details[k] !== undefined) body[k] = e.details[k];
    return { status: e.status, body };
  }
  const m = typeof e.message === 'string' && /^(CORPORATE_[A-Z_]+|FILL_[A-Z_]+)$/.exec(e.message.trim());
  if (m) {
    const code = m[1];
    const status = code.startsWith('FILL_') || code === 'CORPORATE_SLOT_OUTSIDE' ? 400 : 403;
    const text = code === 'CORPORATE_LOCKED' ? MESSAGES.CORPORATE_LOCKED({ name: 'head office' }).replace('playlist "head office"', 'playlist')
      : code === 'FILL_FLAT' ? 'Your slot can hold pictures, videos and widgets — not other playlists.'
      : code === 'CORPORATE_SLOT_OUTSIDE' ? 'A local slot can only be placed in a corporate playlist.'
      : code;
    return { status, body: { error: text, code } };
  }
  return null;
}

/** Send a corporate refusal and return true; return false for anything else (caller rethrows). */
function send(res, e, req) {
  const r = toResponse(e);
  if (!r) return false;
  // A store-trigger acknowledgement prompt is a question, not a denial: not logged as one.
  const prompt = r.body.code === 'CORPORATE_STORE_TRIGGERS_IMPACT' || r.body.code === 'CORPORATE_IMPACT_UNACKNOWLEDGED';
  if (req && !prompt) logDenied(actorLib.resolve(req), e.name === 'CorporateError' ? e : { code: r.body.code, details: {} }, req.originalUrl);
  res.status(r.status).json(r.body);
  return true;
}

/** Run fn; a corporate refusal is answered on res (returns undefined), anything else rethrows. */
function guarded(req, res, fn) {
  try { return fn(); } catch (e) {
    if (send(res, e, req)) return undefined;
    throw e;
  }
}

/** Express error handler: corporate refusals as JSON, everything else passed on unchanged. */
function errorHandler(e, req, res, next) {
  if (res.headersSent) return next(e);
  if (send(res, e, req)) return undefined;
  return next(e);
}

/* ── Who ─────────────────────────────────────────────────────────────────────────────────────── */

function orgOfWorkspace(db, workspaceId) {
  if (!workspaceId) return null;
  try { return db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId)?.organization_id || null; } catch (_) { return null; }
}

function orgOfDevice(db, deviceId) {
  try {
    return db.prepare('SELECT w.organization_id FROM devices d JOIN workspaces w ON w.id = d.workspace_id WHERE d.id = ?')
      .get(deviceId)?.organization_id || null;
  } catch (_) { return null; }
}

/** Corporate author of this org? `who` is a req, an actor, or null (system = yes). */
function canAuthor(who, orgId) {
  const a = actorLib.resolve(who);
  return actorLib.canAuthorOrg(a, orgId);
}

/** Org owner/admin (or platform admin) of this org? Mandates, settings and emergency need this. */
function isOrgAdmin(who, orgId) {
  const a = actorLib.resolve(who);
  return actorLib.isOrgAdminOf(a, orgId);
}

/* ── Governance ─────────────────────────────────────────────────────────────────────────────── */

function anyCorporate(db) {
  try { return !!db.prepare('SELECT 1 FROM playlists WHERE corporate = 1 LIMIT 1').get(); } catch (_) { return false; }
}

/**
 * @returns {{kind: 'corporate'|'corporate_child'|'fill'|null, corporatePlaylist?: object, orgId?: string}}
 */
function governanceOf(db, playlistId) {
  db = db || dbOf();
  if (!playlistId || !anyCorporate(db)) return { kind: null };
  try {
    const p = db.prepare('SELECT id, name, workspace_id, corporate FROM playlists WHERE id = ?').get(playlistId);
    if (!p) return { kind: null };
    if (p.corporate) return { kind: 'corporate', corporatePlaylist: p, orgId: orgOfWorkspace(db, p.workspace_id) };
    const parent = db.prepare(`
      SELECT c.id, c.name, c.workspace_id FROM playlist_items x JOIN playlists c ON c.id = x.playlist_id
       WHERE x.child_playlist_id = ? AND c.corporate = 1 ORDER BY c.name LIMIT 1`).get(playlistId);
    if (parent) return { kind: 'corporate_child', corporatePlaylist: parent, orgId: orgOfWorkspace(db, parent.workspace_id) };
    const fill = db.prepare(`
      SELECT c.id, c.name, c.workspace_id FROM corporate_slot_fills f
        JOIN corporate_slots s ON s.id = f.slot_id JOIN playlists c ON c.id = s.playlist_id
       WHERE f.fill_playlist_id = ? LIMIT 1`).get(playlistId);
    if (fill) return { kind: 'fill', corporatePlaylist: fill, orgId: orgOfWorkspace(db, fill.workspace_id) };
  } catch (_) { /* tables absent */ }
  return { kind: null };
}

function corporateBlock(g, extra = {}) {
  return { corporate: { playlist_id: g.corporatePlaylist && g.corporatePlaylist.id, playlist_name: g.corporatePlaylist && g.corporatePlaylist.name, ...extra } };
}

/**
 * May the request's actor change this playlist? Governed ⇒ corporate author, never a token.
 * `op` is recorded in the refusal for the audit trail ('items'|'meta'|'publish'|'discard'|'delete'|'restore').
 * Fills are store-editable; their limits are judged by lib/corporate/fills.js (assertCanAdd early,
 * judgePublish inside publishPlaylist).
 */
function assertPlaylistWritable(who, playlist, op = 'items') {
  const db = dbOf();
  const g = governanceOf(db, playlist && (playlist.id || playlist));
  if (!g.kind || g.kind === 'fill') return g;
  const a = actorLib.resolve(who);
  if (!a) return g;   // system
  const details = { ...corporateBlock(g), playlist_id: g.corporatePlaylist.id, op };
  if (a.viaToken) throw err('CORPORATE_TOKEN', {}, details);
  if (!actorLib.canAuthorOrg(a, g.orgId)) throw err('CORPORATE_AUTHOR_REQUIRED', {}, details);
  return g;
}

/**
 * The publish chokepoint (called inside publishPlaylist). Only judges when an actor is present:
 * system republishes — ancestor republish, smart refresh, content expiry, the corporate sweep — run
 * as system and pass. Covers every publish route with one check (critique H6).
 */
function assertCanPublish(playlistId) {
  const a = actorLib.current();
  if (!a) return;
  assertPlaylistWritable(a, playlistId, 'publish');
}

/* ── Mandated screens: overrides ────────────────────────────────────────────────────────────── */

function targetLabel(db, m) {
  if (!m) return '';
  try {
    if (m.target_kind === 'org') return 'the whole organization';
    if (m.target_kind === 'workspace') return `workspace ${q(db.prepare('SELECT name FROM workspaces WHERE id = ?').get(m.target_id)?.name)}`;
    if (m.target_kind === 'group') return `group ${q(db.prepare('SELECT name FROM device_groups WHERE id = ?').get(m.target_id)?.name)}`;
    if (m.target_kind === 'wall') return `video wall ${q(db.prepare('SELECT name FROM video_walls WHERE id = ?').get(m.target_id)?.name)}`;
    if (m.target_kind === 'device') return 'this screen';
  } catch (_) { /* fall through */ }
  return m.target_kind;
}

function mandateDetails(db, m, extra = {}) {
  return {
    corporate: {
      playlist_id: m.playlist_id || null, playlist_name: m.playlist_name || null, dark: !!m.dark,
      mandate_target: { kind: m.target_kind, id: m.target_id, label: targetLabel(db, m) },
    },
    mandate_id: m.id,
    ...extra,
  };
}

function nameOf(m) { return m.dark ? 'Turned off by head office' : m.playlist_name; }

/** The mandate covering a device, only when the machinery is active. */
function activeMandateFor(db, deviceId) {
  if (!runtime.active(db)) return null;
  return resolve.mandateFor(db, deviceId);
}

/**
 * Refuse an override of a mandated screen. Store user -> 403 `storeCode` (default OVERRIDE);
 * author -> 409 `authorCode` (default MANDATE_SHADOWS: change the mandate instead).
 */
function assertNotMandated(who, deviceId, { storeCode = 'CORPORATE_OVERRIDE', authorCode = 'CORPORATE_MANDATE_SHADOWS' } = {}) {
  const db = dbOf();
  const m = activeMandateFor(db, deviceId);
  if (!m) return null;
  const vars = { name: nameOf(m), target: targetLabel(db, m) };
  const details = mandateDetails(db, m, { device_id: deviceId });
  if (canAuthor(who, m.organization_id)) {
    // The schedule refusal keeps its own code for both audiences (a 409 for authors).
    throw err(authorCode, vars, details, authorCode === storeCode ? 409 : undefined);
  }
  throw err(storeCode, vars, details);
}

/** Same for a group: covered (all non-wall members mandated) -> refuse; else count. */
function assertGroupNotCovered(who, group, opts = {}) {
  const db = dbOf();
  if (!runtime.active(db)) return { mandated_members: 0 };
  const m = resolve.groupCoverage(db, group);
  if (m) {
    const vars = { name: nameOf(m), target: targetLabel(db, m) };
    const details = mandateDetails(db, m, { group_id: group.id });
    const storeCode = opts.storeCode || 'CORPORATE_OVERRIDE';
    const authorCode = opts.authorCode || 'CORPORATE_MANDATE_SHADOWS';
    if (canAuthor(who, m.organization_id)) throw err(authorCode, vars, details, authorCode === storeCode ? 409 : undefined);
    throw err(storeCode, vars, details);
  }
  return { mandated_members: resolve.mandatedMembers(db, group.id).length };
}

/* ── Mandate-loss guard (membership changes) ───────────────────────────────────────────────── */

function mandateKey(m) {
  if (!m) return 'none';
  return `${m.id}|${m.dark ? 'dark' : m.playlist_id}`;
}

function wallMembersOf(db, deviceIds) {
  const out = new Set(deviceIds);
  try {
    for (const id of deviceIds) {
      const w = db.prepare('SELECT wall_id FROM devices WHERE id = ?').get(id);
      if (w && w.wall_id) {
        for (const r of db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(w.wall_id)) out.add(r.device_id);
        for (const r of db.prepare('SELECT id FROM devices WHERE wall_id = ?').all(w.wall_id)) out.add(r.id);
      }
    }
  } catch (_) { /* no wall tables in a fixture */ }
  return [...out];
}

/**
 * Run fn (the membership change) in a transaction; if ANY affected screen's mandate changes — lost,
 * gained or swapped — and the actor is not an org admin of that screen's org, roll back and refuse.
 * `describe(change)` returns the CORPORATE_MEMBERSHIP text for this action.
 * Short-circuits to fn() when the machinery is inactive.
 */
function assertNoMandateLoss(who, deviceIds, fn, describe, { cause = 'membership', dryRun = false } = {}) {
  const db = dbOf();
  if (!runtime.active(db)) return fn();
  const a = actorLib.resolve(who);
  const ids = wallMembersOf(db, (deviceIds || []).filter(Boolean));
  const before = new Map(ids.map((id) => [id, resolve.mandateFor(db, id)]));
  const impactLib = require('./impact');
  let result;
  let impact = [];
  let restored = 0;
  db.transaction(() => {
    result = fn();
    const watch = new Set([...ids, ...wallMembersOf(db, ids)]);
    const gained = [];
    const lost = [];
    for (const id of watch) {
      const was = before.has(id) ? before.get(id) : null;
      const now = resolve.mandateFor(db, id);
      if (mandateKey(was) === mandateKey(now)) continue;
      if (!was && now) gained.push(id);
      if (was && !now) lost.push(id);
      const orgId = orgOfDevice(db, id) || (was && was.organization_id) || (now && now.organization_id);
      if (actorLib.isOrgAdminOf(a, orgId)) continue;
      const m = was || now;
      const text = describe ? describe({ deviceId: id, was, now, name: m && nameOf(m) })
        : `This would change what a screen plays (head office's ${q(m && nameOf(m))}). Ask your organization admin to do it.`;
      throw err('CORPORATE_MEMBERSHIP', { text }, mandateDetails(db, m, { device_id: id }));
    }
    /*
     * ⚠️ NEVER HIDE A STORE'S TRIGGER SILENTLY (lib/corporate/impact.js). Screens this change NEWLY
     * puts under head office lose the store triggers the org's policy hides there — read now, in the
     * new state, so a trigger of a workspace the screen just left (which stops reaching it anyway) is
     * not counted. Unacknowledged → refuse and roll the whole change back. A system actor (mesh,
     * import, background work) is never prompted; what it hides is still recorded below.
     */
    impact = gained.length ? impactLib.impactForNewlyCovered(db, gained) : [];
    if (impact.length && a && !dryRun && !impactLib.acknowledged(who)) {
      throw err('CORPORATE_STORE_TRIGGERS_IMPACT', { n: impact.length }, { impact });
    }
    restored = lost.length ? impactLib.restoredCount(db, lost) : 0;
  })();
  if (impact.length && !dryRun) impactLib.auditLimitedByOrg(db, who && who.user ? who : null, impact, cause);
  if (who && typeof who === 'object' && !(who.authorOrgIds instanceof Set)) {
    who.corpMembershipImpact = { store_triggers_hidden: impact, store_triggers_showing_again: restored };
  }
  return result;
}

/* ── Device controls (D13) ──────────────────────────────────────────────────────────────────── */

const GATED_COMMANDS = Object.freeze({
  // Each label is a whole phrase, object included ("turn it off", not "turn off" + " it").
  set_server_url: 'move it to another server', shell: 'run commands on it', install_apk: 'install apps on it', launch: 'launch apps on it',
  kiosk_unlock: 'unlock it', screen_off: 'turn it off', shutdown: 'shut it down',
  // Not in the spec's list, same class: it can blank the panel after N ms of "inactivity".
  set_screen_timeout: 'change its screen timeout',
});
const BRIGHTNESS_FLOOR = 0.2;
const _ctlAudit = new Map();

/**
 * @returns {{ok: true, payload}|{ok: false, status: 'refused', code, error, corporate}}
 * The payload may be rewritten: brightness clamped to >= 20% for non-admins, set_power_schedule
 * replaced by the server-resolved schedule (a store cannot inject windows on a mandated screen).
 */
function assertDeviceControl(who, device, type, payload) {
  const db = dbOf();
  if (!device || !device.id) return { ok: true, payload };
  const m = activeMandateFor(db, device.id);
  if (!m) return { ok: true, payload };
  const a = actorLib.resolve(who);
  if (actorLib.isOrgAdminOf(a, m.organization_id)) return { ok: true, payload };
  if (GATED_COMMANDS[type]) {
    const e = err('CORPORATE_DEVICE_CONTROL', { name: nameOf(m), action_label: GATED_COMMANDS[type] }, mandateDetails(db, m, { device_id: device.id }));
    logDenied(a, e, `command:${type}`);
    return { ok: false, status: 'refused', code: e.code, error: e.message, corporate: e.details.corporate };
  }
  let out = payload;
  if ((type === 'set_brightness' || type === 'set_system_brightness') && payload && typeof payload.level === 'number'
      && payload.level >= 0 && payload.level < BRIGHTNESS_FLOOR) {
    out = { ...payload, level: BRIGHTNESS_FLOOR };
  }
  if (type === 'set_power_schedule') {
    out = { schedule: require('../device-power-schedule').powerScheduleForDevice(db, device.id) };
  }
  auditDeviceControl(a, device, type, m);
  return { ok: true, payload: out };
}

function auditDeviceControl(a, device, type, m) {
  try {
    const key = `${a && a.userId}|${device.id}|${type}`;
    const now = Date.now();
    if (now - (_ctlAudit.get(key) || 0) < 60000) return;
    _ctlAudit.set(key, now);
    if (_ctlAudit.size > 2000) _ctlAudit.clear();
    require('../audit').audit('corporate.device_control', {
      userId: a && a.userId, workspaceId: device.workspace_id || null, deviceId: device.id,
      details: { type, mandate_id: m.id },
    });
  } catch (_) { /* never */ }
}

/** Plain refusal (403) for device-scoped ROUTES that are gated (block, layout, local API, PiP). */
function assertDeviceRouteControl(who, deviceId, actionLabel) {
  const db = dbOf();
  const m = activeMandateFor(db, deviceId);
  if (!m) return;
  if (isOrgAdmin(who, m.organization_id)) return;
  throw err('CORPORATE_DEVICE_CONTROL', { name: nameOf(m), action_label: actionLabel }, mandateDetails(db, m, { device_id: deviceId }));
}

/** Is this device mandated and the actor NOT an org admin of it? (For "skip and report".) */
function isControlledFor(who, deviceId) {
  const db = dbOf();
  const m = activeMandateFor(db, deviceId);
  if (!m) return false;
  return !isOrgAdmin(who, m.organization_id);
}

/** An allowed-but-audited destructive action (device delete). */
function auditMandatedAction(who, device, type) {
  const db = dbOf();
  const m = activeMandateFor(db, device.id);
  if (!m) return;
  auditDeviceControl(actorLib.resolve(who), device, type, m);
}

/* ── Org-owned media protection (§4.6) ──────────────────────────────────────────────────────── */

const GOVERNED_PL = `(p.corporate = 1 OR EXISTS (SELECT 1 FROM playlist_items gx JOIN playlists gc ON gc.id = gx.playlist_id
                                                WHERE gx.child_playlist_id = p.id AND gc.corporate = 1))`;

/** The governed playlist (if any) that uses this content/widget/layout/slide deck. */
function governingUse(db, type, id) {
  if (!id || !anyCorporate(db)) return null;
  try {
    if (type === 'content' || type === 'widget') {
      const col = type === 'content' ? 'content_id' : 'widget_id';
      const direct = db.prepare(`
        SELECT p.id, p.name, p.workspace_id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
         WHERE pi.${col} = ? AND ${GOVERNED_PL} LIMIT 1`).get(id);
      if (direct) return direct;
      // Still on screens through a corporate playlist's PUBLISHED copy, even once the draft dropped it.
      const like = `%"${col}":"${String(id).replace(/[%_"]/g, '')}"%`;
      const pub = db.prepare('SELECT p.id, p.name, p.workspace_id FROM playlists p WHERE p.corporate = 1 AND p.published_snapshot LIKE ? LIMIT 1').get(like);
      if (pub) return pub;
      const fb = db.prepare(`SELECT p.id, p.name, p.workspace_id FROM corporate_slots s JOIN playlists p ON p.id = s.playlist_id
         WHERE s.${type === 'content' ? 'fallback_content_id' : 'fallback_widget_id'} = ? LIMIT 1`).get(id);
      if (fb) return fb;
      return null;
    }
    if (type === 'layout') {
      return db.prepare(`SELECT p.id, p.name, p.workspace_id FROM corporate_mandates cm
          LEFT JOIN playlists p ON p.id = cm.playlist_id WHERE cm.layout_id = ? LIMIT 1`).get(id) || null;
    }
    if (type === 'slide_deck') {
      const deck = db.prepare('SELECT playlist_id FROM slide_decks WHERE id = ?').get(id);
      if (!deck || !deck.playlist_id) return null;
      const g = governanceOf(db, deck.playlist_id);
      return g.kind === 'corporate' || g.kind === 'corporate_child' ? g.corporatePlaylist : null;
    }
  } catch (_) { /* tables absent */ }
  return null;
}

/** Refuse a change to org-owned media by a non-author (403 CORPORATE_MEDIA; tokens: CORPORATE_TOKEN). */
function assertMediaWritable(who, type, id) {
  const db = dbOf();
  const use = governingUse(db, type, id);
  if (!use) return;
  const a = actorLib.resolve(who);
  if (!a) return;
  const orgId = orgOfWorkspace(db, use.workspace_id);
  const details = { corporate: { playlist_id: use.id, playlist_name: use.name }, playlist_id: use.id };
  if (a.viaToken) throw err('CORPORATE_TOKEN', {}, details);
  if (!actorLib.canAuthorOrg(a, orgId)) throw err('CORPORATE_MEDIA', { name: use.name }, details);
}

/* ── Nesting / smart refusals ───────────────────────────────────────────────────────────────── */

/** A corporate playlist can't be a child of anything. Returns {status, error, code} or null. */
function nestingRefusal(db, childId) {
  try {
    const c = (db || dbOf()).prepare('SELECT corporate FROM playlists WHERE id = ?').get(childId);
    if (c && c.corporate) { const e = err('CORPORATE_NESTED'); return { status: e.status, error: e.message, code: e.code }; }
  } catch (_) { /* column absent */ }
  return null;
}

/* ── Mesh ───────────────────────────────────────────────────────────────────────────────────── */

/** Is this workspace replicated (a copy here, or shared over an active mesh edge)? */
function isReplicatedWorkspace(db, workspaceId) {
  db = db || dbOf();
  try {
    const w = db.prepare('SELECT origin_node_id FROM workspaces WHERE id = ?').get(workspaceId);
    if (w && w.origin_node_id) return true;
  } catch (_) { /* no column */ }
  try {
    for (const e of db.prepare("SELECT shared_workspaces FROM mesh_edges WHERE IFNULL(status, 'active') NOT IN ('revoked','removed')").all()) {
      let arr = [];
      try { arr = JSON.parse(e.shared_workspaces || '[]'); } catch (_) { arr = []; }
      if (Array.isArray(arr) && arr.includes(workspaceId)) return true;
    }
  } catch (_) { /* no mesh */ }
  return false;
}

/** Does this workspace carry corporate state that a replica would not see? */
function workspaceHasCorporateState(db, workspaceId) {
  db = db || dbOf();
  try {
    if (db.prepare('SELECT 1 FROM organizations WHERE hq_workspace_id = ?').get(workspaceId)) return 'hq';
    if (db.prepare("SELECT 1 FROM corporate_mandates WHERE target_kind = 'workspace' AND target_id = ?").get(workspaceId)) return 'mandate';
    // An org-wide mandate covers every workspace of the org, this one included.
    if (db.prepare(`SELECT 1 FROM corporate_mandates cm JOIN workspaces w ON w.organization_id = cm.target_id
        WHERE cm.target_kind = 'org' AND w.id = ? LIMIT 1`).get(workspaceId)) return 'mandate';
    if (db.prepare(`SELECT 1 FROM corporate_mandates cm WHERE
        (cm.target_kind = 'group'  AND cm.target_id IN (SELECT id FROM device_groups WHERE workspace_id = ?))
     OR (cm.target_kind = 'device' AND cm.target_id IN (SELECT id FROM devices WHERE workspace_id = ?))
     OR (cm.target_kind = 'wall'   AND cm.target_id IN (SELECT id FROM video_walls WHERE workspace_id = ?)) LIMIT 1`)
      .get(workspaceId, workspaceId, workspaceId)) return 'mandate';
    if (db.prepare('SELECT 1 FROM corporate_slot_fills WHERE workspace_id = ? LIMIT 1').get(workspaceId)) return 'fill';
  } catch (_) { /* tables absent */ }
  return null;
}

module.exports = {
  CorporateError, err, toResponse, send, guarded, errorHandler, logDenied, MESSAGES,
  canAuthor, isOrgAdmin, orgOfWorkspace, orgOfDevice, anyCorporate,
  governanceOf, assertPlaylistWritable, assertCanPublish,
  targetLabel, mandateDetails, activeMandateFor, assertNotMandated, assertGroupNotCovered,
  assertNoMandateLoss, GATED_COMMANDS, assertDeviceControl, assertDeviceRouteControl, isControlledFor, auditMandatedAction,
  governingUse, assertMediaWritable, nestingRefusal, isReplicatedWorkspace, workspaceHasCorporateState,
};
