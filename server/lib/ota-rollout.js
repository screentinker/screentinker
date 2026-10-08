'use strict';

/*
 * Health-checked player rollouts with automatic halt, and automatic ROLLBACK where the platform
 * allows it.
 *
 * A new stable player version (the staged APK, Pi .deb, or Windows installer) is offered in waves:
 * 10% of that platform's screens, then 50%, then everyone. Each wave soaks before the next opens,
 * and every few minutes the screens that took the new version are compared with the ones that have
 * not: crash exits, and screens that went dark after updating and did not come back. If the new
 * version is clearly worse, the rollout HALTS: nobody else is offered it, platform admins are told,
 * and on Pi and Windows the screens that already took it are offered the previous version back.
 *
 * ⚠️ ANDROID CANNOT ROLL BACK. Every release raises versionCode, Android refuses a lower versionCode
 * over a higher one without uninstalling (which loses pairing), and no released APK can request a
 * downgrade. So on Android a halt STOPS the spread and the fix is forward: stage a newer build, and
 * it gets its own rollout. The Pi helper installs with apt --allow-downgrades and the Windows
 * installer has no downgrade block, so there the halt really does take screens back.
 *
 * ⚠️ THE ROLLBACK PACKAGE IS THE ANNOUNCED RELEASE. The Pi and Windows helpers trust a package only
 * when its sha256 equals what this server announces (an anonymous update check). So during a
 * rollback the previous package becomes the effective release for every question — announce,
 * offer, download — not a special case for some screens only.
 *
 * Waves are decided per screen by a stable rank (sha256 of version + device id), so a screen's
 * wave never changes between checks. Beta-channel screens and an admin's "force update" skip the
 * waves (they asked for it), but never a halt. OTA_STAGED_ROLLOUT=off restores the old behaviour.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function dbOf() { return require('../db/database').db; }

const WAVES = [10, 50, 100];
const FAMILIES = { android: ['android'], pi: ['linux'], win: ['windows'] };   // our family -> platformFamily()
const ARCHIVE_KEEP = 3;
const RANK_TTL_MS = 60 * 1000;
const TICK_MS = 5 * 60 * 1000;

let clock = () => Date.now();
const rankCache = new Map();   // `${family}|${version}` -> { at, order: [deviceId…] }

const enabled = () => String(process.env.OTA_STAGED_ROLLOUT || 'on').toLowerCase() !== 'off';
const soakMs = () => Math.max(1, Number(process.env.OTA_ROLLOUT_SOAK_MIN) || 120) * 60 * 1000;
const STALL_MS = 24 * 3600 * 1000;   // a wave whose screens never update still opens the next after a day

/* ============================== rows ============================== */

function getRow(db, family, version) {
  return db.prepare('SELECT * FROM ota_rollouts WHERE family = ? AND version = ?').get(family, version);
}

function archiveDir(family) {
  const config = require('../config');
  return path.join(config.dataDir, 'ota-archive', family);
}

/** Copy a package aside so it can be served again as a rollback. Returns its archived info. */
function archive(family, pkg) {
  if (!pkg || !pkg.exists || !pkg.path || family === 'android') return null;
  try {
    const dir = archiveDir(family);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, pkg.filename);
    if (!fs.existsSync(dest)) fs.copyFileSync(pkg.path, dest);
    // Bounded: keep the newest few archived packages per platform.
    const files = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const f of files.slice(ARCHIVE_KEEP)) { try { fs.unlinkSync(path.join(dir, f.n)); } catch (_) { /* */ } }
    return { path: dest, filename: pkg.filename, sha256: pkg.sha256 || null, size: pkg.size || fs.statSync(dest).size };
  } catch (e) {
    console.warn(`[ota-rollout] could not archive ${family} ${pkg.version}: ${e.message}`);
    return null;
  }
}

/**
 * The rollout for this staged version, created the first time a check sees it. Its `prev_*` fields
 * point at the newest earlier version that was not itself halted, archived for rollback.
 */
function ensure(db, family, pkg) {
  if (!pkg || !pkg.version) return null;
  let row = getRow(db, family, pkg.version);
  if (row) {
    // The sha256 is computed after the first sighting; fill it in for a rollback that later needs it.
    if (!row.archive_sha256 && pkg.sha256 && row.archive_path) db.prepare('UPDATE ota_rollouts SET archive_sha256 = ? WHERE id = ?').run(pkg.sha256, row.id);
    return getRow(db, family, pkg.version);
  }
  const now = Math.floor(clock() / 1000);
  const prev = db.prepare(`SELECT * FROM ota_rollouts WHERE family = ? AND version != ? AND status != 'halted'
    ORDER BY started_at DESC LIMIT 1`).get(family, pkg.version);
  const arc = archive(family, pkg);
  db.prepare(`INSERT OR IGNORE INTO ota_rollouts (family, version, status, wave, started_at, wave_started_at,
      prev_version, archive_path, archive_filename, archive_sha256, archive_size)
    VALUES (?, ?, 'rolling', 0, ?, ?, ?, ?, ?, ?, ?)`).run(family, pkg.version, now, now,
    prev ? prev.version : null, arc ? arc.path : null, arc ? arc.filename : null, arc ? arc.sha256 : null, arc ? arc.size : null);
  // Only one rollout per platform is live at a time: the newer staged version supersedes the older.
  db.prepare("UPDATE ota_rollouts SET status = 'superseded' WHERE family = ? AND version != ? AND status IN ('rolling','paused')").run(family, pkg.version);
  return getRow(db, family, pkg.version);
}

/* ============================== waves ============================== */

function familyDevices(db, family) {
  const { platformFamily } = require('./player-capabilities');
  const want = FAMILIES[family] || [];
  return db.prepare('SELECT id, platform, android_version, client_type, app_version FROM devices WHERE app_version IS NOT NULL').all()
    .filter((d) => want.includes(platformFamily(d)));
}

function rankOrder(db, family, version) {
  const k = `${family}|${version}`;
  const hit = rankCache.get(k);
  if (hit && clock() - hit.at < RANK_TTL_MS) return hit.order;
  const order = familyDevices(db, family)
    .map((d) => ({ id: d.id, h: crypto.createHash('sha256').update(`${version}|${d.id}`).digest('hex').slice(0, 12) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0)).map((x) => x.id);
  rankCache.set(k, { at: clock(), order });
  return order;
}

/** Is this screen inside the rollout's current wave? Unknown screens wait for the last wave. */
function inWave(db, row, deviceId) {
  const pct = WAVES[Math.min(row.wave, WAVES.length - 1)];
  if (pct >= 100) return true;
  if (!deviceId) return false;
  const order = rankOrder(db, row.family, row.version);
  const idx = order.indexOf(deviceId);
  if (idx < 0) return false;
  return idx < Math.max(1, Math.ceil((order.length * pct) / 100));
}

/* ============================== the gate ============================== */

/**
 * What a check may be told for this platform's staged package `pkg`.
 *   { action: 'offer' }                         — proceed as before (the breaker still decides)
 *   { action: 'wait', reason }                  — not this screen's wave yet / paused
 *   { action: 'halted', reason }                — the version is halted and there is nothing to go back to
 *   { action: 'rollback', release }             — offer `release` (the previous package) instead
 * `ctx`: { deviceId, currentVersion, beta, forced }.
 */
function gate(family, pkg, ctx = {}) {
  if (!enabled() || !pkg || !pkg.version) return { action: 'offer' };
  const db = dbOf();
  let row;
  try { row = ensure(db, family, pkg); } catch (e) { return { action: 'offer' }; }   // never block updates on our own fault
  if (!row) return { action: 'offer' };
  if (row.status === 'halted') {
    const prev = row.prev_version ? getRow(db, family, row.prev_version) : null;
    if (family !== 'android' && prev && prev.archive_path && prev.archive_sha256 && fs.existsSync(prev.archive_path)) {
      return { action: 'rollback', release: { version: prev.version, path: prev.archive_path, filename: prev.archive_filename, sha256: prev.archive_sha256, size: prev.archive_size, exists: true } };
    }
    return { action: 'halted', reason: 'rollout-halted' };
  }
  if (ctx.beta || ctx.forced) return { action: 'offer' };
  if (row.status === 'paused') return { action: 'wait', reason: 'rollout-paused' };
  if (row.status === 'complete') return { action: 'offer' };
  return inWave(db, row, ctx.deviceId) ? { action: 'offer' } : { action: 'wait', reason: 'rollout-wave' };
}

/* ============================== health ============================== */

/**
 * The rollout's evidence. Updated = screens with an upgrade event to this version since it started.
 * A screen counts as BAD when, after updating, it crashed twice, or it is now dark (offline for 15+
 * minutes since its upgrade). The baseline is the same "dark" share among this platform's screens
 * that have not updated, so a site-wide outage does not read as a bad release.
 */
function health(db, row, now = Math.floor(clock() / 1000)) {
  const ups = db.prepare(`SELECT e.device_id, MIN(e.timestamp) AS at FROM device_events e
    WHERE e.type = 'upgrade' AND e.detail LIKE ? AND e.timestamp >= ? GROUP BY e.device_id`).all(`% → ${row.version}`, row.started_at);
  const fam = new Set(familyDevices(db, row.family).map((d) => d.id));
  const updated = ups.filter((u) => fam.has(u.device_id));
  let bad = 0;
  const crashes = db.prepare("SELECT COUNT(*) n FROM device_events WHERE device_id = ? AND type = 'offline' AND reason = 'crashed' AND timestamp >= ?");
  const state = db.prepare('SELECT status, last_heartbeat FROM devices WHERE id = ?');
  for (const u of updated) {
    const c = crashes.get(u.device_id, u.at).n;
    const s = state.get(u.device_id) || {};
    const dark = s.status === 'offline' && (s.last_heartbeat || 0) < now - 15 * 60 && (s.last_heartbeat || 0) >= u.at - 60;
    if (c >= 2 || dark) bad++;
  }
  const updatedIds = new Set(updated.map((u) => u.device_id));
  const others = familyDevices(db, row.family).filter((d) => !updatedIds.has(d.id));
  let otherDark = 0, otherSeen = 0;
  for (const d of others) {
    const s = state.get(d.id) || {};
    if (!s.last_heartbeat || s.last_heartbeat < now - 24 * 3600) continue;   // long-dead screens say nothing
    otherSeen++;
    if (s.status === 'offline' && s.last_heartbeat < now - 15 * 60) otherDark++;
  }
  const badShare = updated.length ? bad / updated.length : 0;
  const baseShare = otherSeen ? otherDark / otherSeen : 0;
  return { updated: updated.length, bad, bad_share: badShare, baseline_share: baseShare, family_size: fam.size };
}

/** Halt when the updated screens are clearly worse than the rest. */
function verdict(h) {
  const minSample = Math.min(3, Math.max(1, h.family_size));
  if (h.updated < minSample) return null;
  if (h.bad_share >= 0.3 && h.bad_share - h.baseline_share >= 0.2) return 'halt';
  return null;
}

/* ============================== tick ============================== */

async function notifyHalt(db, row, h, why) {
  try {
    const { logActivity } = require('../services/activity');
    logActivity(null, 'ota.rollout_halted', `${row.family} ${row.version} halted: ${why}`);
  } catch (_) { /* */ }
  try {
    const { sendEmail } = require('../services/email');
    const admins = db.prepare("SELECT email FROM users WHERE role IN ('superadmin','platform_admin') AND email IS NOT NULL").all();
    const back = row.family === 'android' ? 'Screens that already updated stay on it (Android cannot downgrade); stage a newer build to fix forward.'
      : (row.prev_version ? `Screens that updated are being offered ${row.prev_version} back.` : 'No earlier package was kept, so screens that updated stay on it.');
    for (const a of admins) {
      await sendEmail({ to: a.email, subject: `Player rollout halted: ${row.family} ${row.version}`,
        text: `The ${row.family} player ${row.version} rollout was halted automatically.\n\n${why}\n\nNobody else will be offered it. ${back}\n\nResume or release it from Platform → Player rollouts.\n\n- ScreenTinker` });
    }
  } catch (_) { /* best effort */ }
}

function halt(db, row, why, { by = 'auto' } = {}) {
  const now = Math.floor(clock() / 1000);
  db.prepare("UPDATE ota_rollouts SET status = 'halted', halted_at = ?, halted_reason = ?, halted_by = ? WHERE id = ?").run(now, why.slice(0, 500), by, row.id);
}

/** Every few minutes: halt a bad rollout, or open the next wave of a healthy one. */
async function tick(db = dbOf()) {
  if (!enabled()) return [];
  const out = [];
  let rows;
  try { rows = db.prepare("SELECT * FROM ota_rollouts WHERE status = 'rolling'").all(); } catch (_) { return out; }
  const now = Math.floor(clock() / 1000);
  for (const row of rows) {
    const h = health(db, row, now);
    if (verdict(h) === 'halt') {
      const why = `${h.bad} of ${h.updated} updated screens crashed repeatedly or went dark after updating (${Math.round(h.bad_share * 100)}%, against ${Math.round(h.baseline_share * 100)}% of the rest).`;
      halt(db, row, why);
      out.push({ family: row.family, version: row.version, action: 'halted', why });
      await notifyHalt(db, row, h, why);
      continue;
    }
    const age = now * 1000 - row.wave_started_at * 1000;
    if (row.wave >= WAVES.length - 1) {
      if (age >= soakMs()) { db.prepare("UPDATE ota_rollouts SET status = 'complete', completed_at = ? WHERE id = ?").run(now, row.id); out.push({ family: row.family, version: row.version, action: 'complete' }); }
      continue;
    }
    const order = rankOrder(db, row.family, row.version);
    const waveSize = Math.max(1, Math.ceil((order.length * WAVES[row.wave]) / 100));
    const enoughData = h.updated >= Math.min(waveSize, 3);
    if (age >= soakMs() && (enoughData || age >= STALL_MS) && h.bad === 0) {
      db.prepare('UPDATE ota_rollouts SET wave = wave + 1, wave_started_at = ? WHERE id = ?').run(now, row.id);
      out.push({ family: row.family, version: row.version, action: 'wave', wave: row.wave + 1 });
    }
  }
  return out;
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.warn(`[ota-rollout] tick failed: ${e && e.message}`)); }, TICK_MS);
  if (timer.unref) timer.unref();
}

/* ============================== admin ============================== */

/** True only when the previous package is really there to serve, not just named. */
function canRollBack(db, r) {
  if (r.family === 'android' || !r.prev_version) return false;
  const prev = getRow(db, r.family, r.prev_version);
  return !!(prev && prev.archive_path && prev.archive_sha256 && fs.existsSync(prev.archive_path));
}

function list(db = dbOf()) {
  return db.prepare("SELECT * FROM ota_rollouts ORDER BY started_at DESC LIMIT 30").all().map((r) => ({
    family: r.family, version: r.version, status: r.status, wave: r.wave, wave_percent: WAVES[Math.min(r.wave, WAVES.length - 1)],
    started_at: r.started_at, wave_started_at: r.wave_started_at, completed_at: r.completed_at,
    halted_at: r.halted_at, halted_reason: r.halted_reason, halted_by: r.halted_by,
    prev_version: r.prev_version, can_roll_back: canRollBack(db, r),
    health: r.status === 'superseded' ? null : health(db, r),
  }));
}

/** pause | resume | release (everyone now) | halt (and roll back where possible) | clear (un-halt, resume waves) */
function act(db, family, version, action, { by = 'admin' } = {}) {
  const row = getRow(db, family, version);
  if (!row) return { error: 'No such rollout', status: 404 };
  const now = Math.floor(clock() / 1000);
  switch (action) {
    case 'pause': if (row.status !== 'rolling') return { error: 'Only a rolling rollout can be paused', status: 409 };
      db.prepare("UPDATE ota_rollouts SET status = 'paused' WHERE id = ?").run(row.id); break;
    case 'resume': if (row.status !== 'paused') return { error: 'Only a paused rollout can be resumed', status: 409 };
      db.prepare("UPDATE ota_rollouts SET status = 'rolling', wave_started_at = ? WHERE id = ?").run(now, row.id); break;
    case 'release': if (!['rolling', 'paused'].includes(row.status)) return { error: 'Only a rolling or paused rollout can be released', status: 409 };
      db.prepare(`UPDATE ota_rollouts SET status = 'complete', wave = ?, completed_at = ? WHERE id = ?`).run(WAVES.length - 1, now, row.id); break;
    case 'halt': if (['halted', 'superseded'].includes(row.status)) return { error: 'Already stopped', status: 409 };
      halt(db, row, 'Halted by a platform admin.', { by }); break;
    case 'clear': if (row.status !== 'halted') return { error: 'Only a halted rollout can be cleared', status: 409 };
      db.prepare("UPDATE ota_rollouts SET status = 'rolling', halted_at = NULL, halted_reason = NULL, halted_by = NULL, wave_started_at = ? WHERE id = ?").run(now, row.id); break;
    default: return { error: 'Unknown action', status: 400 };
  }
  return { ok: true };
}

function _setClock(fn) { clock = fn || (() => Date.now()); rankCache.clear(); }

module.exports = { WAVES, FAMILIES, enabled, ensure, gate, inWave, health, verdict, tick, start, list, act, archive, _setClock };
