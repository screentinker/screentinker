'use strict';

/*
 * Scale-out, primary side (docs/scale-out-design.md §3–§4).
 *
 * The primary never writes to a replica, and application code never writes the change log. SQLite
 * TRIGGERS append to `mesh_change_log` on the tables below, and those triggers exist only while an
 * active `up` edge carries the `workspace-replication` grant — created by ensureTriggers() at boot
 * and on edge change, dropped when the last such edge is revoked. A stock install has no triggers,
 * no log and no cost, which is what "cannot tell this exists" (I1) requires.
 *
 * ⚠️ TRIGGERS, NOT INSTRUMENTED HANDLERS. There are ~130 write handlers across 40 route files plus
 * ten inline routes in server.js; a list of call sites would miss one, and the inventory already
 * found three mesh modules that were tested and never called. A trigger cannot be forgotten.
 *
 * ⚠️ THE TWO KINDS OF TABLE. Configuration tables (playlists, content, schedules, layouts…) change
 * when an operator acts and are logged row by row. Volatile state (a device's heartbeat, every play
 * event, telemetry samples) would write a log row per heartbeat per screen — 400 screens is ~1M
 * rows a day — so those are NOT logged. They reach the replica the way they reach a hub today:
 * the existing 60 s `device-summary` / `proof-of-play` envelopes, which the replica applies onto
 * its copied rows (lib/mesh/replica.js). `devices` is logged only for its configuration columns
 * (`AFTER UPDATE OF <list>`), never for the ones a heartbeat touches.
 *
 * ⚠️ THE BLOCKLIST IS THE ONE DELETE-BASED FILTER IN THE MESH. Everything else in lib/mesh builds a
 * projection by adding what the grant allows. Replication is a faithful copy, so it must be "every
 * column except", and that shape ships a secret column added later by default. The guard is
 * test_replication_blocklist_covers_every_secret_column: it walks PRAGMA table_info for every table
 * here and fails if a column whose name looks like a secret is not listed below.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

/** Column names that must never leave the primary, by table. Matched exactly. */
const BLOCKLIST = Object.freeze({
  users: [
    'password_hash', 'totp_secret_enc', 'totp_enabled', 'totp_last_step', 'must_change_password',
    'email_verify_hash', 'email_verify_expires', 'password_reset_hash', 'password_reset_expires',
    'stripe_customer_id', 'stripe_subscription_id', 'subscription_status', 'subscription_ends',
    // Trial columns are cleared so the hosted trial sweep on a replica ignores copied users.
    'trial_started', 'trial_plan', 'trial_expired_at', 'trial_ending_email_sent_at',
    'trial_expired_email_sent_at',
  ],
  organizations: ['stripe_customer_id', 'stripe_subscription_id'],
  devices: [
    'device_token', 'enrol_key', 'settings_pin', 'claim_secret', 'trigger_secret',
    'trigger_clear_all_token', 'pairing_code',
  ],
  triggers: ['match_token', 'clear_token'],
});

/**
 * What a column name looks like when it holds a secret. The schema test walks every replicated
 * table with this regex and fails on a matching column that is not on the BLOCKLIST or on
 * NOT_A_SECRET, so a new secret column cannot ship by omission.
 */
const SECRET_NAME_RE = /hash|secret|token|password|totp|stripe|_pin$|^pin$|credential|api_key|auth_header|_enc$/i;
/** Columns the regex catches that are NOT secrets, each with the reason. */
const NOT_A_SECRET = Object.freeze({
  'revisions.state_hash': 'content fingerprint of the revision body, not a credential',
});

/*
 * JSON config columns (data_sources.config, widgets.config, kiosk_pages.config, alert_configs.config)
 * hold operator-entered settings; plugin secret fields inside them are encrypted with a key derived
 * from JWT_SECRET — which a replica SHARES. So the ciphertext is scrubbed out of every JSON object
 * before it leaves: any key whose value carries the secretbox prefix, or whose name looks like a
 * secret, is dropped. The replica renders the widget from cached_data; it never fetches.
 */
const ENC_VALUE_RE = /^enc:v1:/;
const SECRET_KEY_RE = /(?:^|[_-])(?:token|secret|password|passwd|api[_-]?key|apikey|auth|authorization|bearer|credential|access[_-]?key)(?:$|[_-])|^(?:token|secret|password|apikey|authorization|bearer)$/i;

function scrubJson(value) {
  if (typeof value !== 'string' || value[0] !== '{') return value;
  let obj;
  try { obj = JSON.parse(value); } catch { return value; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return value;
  let changed = false;
  const walk = (o) => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if ((typeof v === 'string' && ENC_VALUE_RE.test(v)) || SECRET_KEY_RE.test(k)) { delete o[k]; changed = true; }
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
    }
  };
  walk(obj);
  return changed ? JSON.stringify(obj) : value;
}

/** The outbound projection of one row: blocklist already applied by the SELECT; JSON scrubbed here. */
function scrubRow(row) {
  if (!row) return row;
  for (const k of Object.keys(row)) {
    if (typeof row[k] === 'string' && row[k][0] === '{') row[k] = scrubJson(row[k]);
  }
  return row;
}

/**
 * Device columns that a heartbeat / telemetry / OTA report touches. Updates to ONLY these columns
 * are not logged; the replica learns them from device-summary envelopes instead.
 */
const DEVICE_VOLATILE = Object.freeze([
  'status', 'last_heartbeat', 'ip_address', 'android_version', 'app_version', 'screen_width',
  'screen_height', 'reported_timezone', 'reported_utc', 'reported_at', 'client_version', 'platform',
  'contract_version', 'offline_reason', 'offline_reason_at', 'offline_detail', 'render_width',
  'render_height', 'ota_status', 'ota_target_version', 'ota_attempts', 'ota_updated_at',
  'ota_channel_served', 'reboot_last_date', 'accessibility_enabled', 'overlay_granted',
  'offline_alert_heartbeat', 'hardware_model', 'hardware_serial', 'hardware_os_version',
  'hardware_edid', 'capabilities', 'trigger_status', 'trigger_status_at', 'capture_mode',
  'updated_at', 'tier', 'foreign_device_owner', 'can_write_settings', 'media_volume',
  'system_brightness', 'window_brightness', 'screen_off_timeout_ms',
]);

/**
 * The replicated tables, in dependency order (the snapshot copies in this order so foreign keys
 * resolve on the replica). `scope` says how a row's workspace is found:
 *   'workspace_id'                      — the row has the column
 *   { via: col, parent: table }         — through the parent row, by the PARENT's own rule (recursive)
 *   'organization'                      — the row IS an organization; scope by the workspaces in it
 *   'user'                              — the row IS a user; scope by membership in a shared workspace
 * `pk` is a single column or an array (composite).
 */
const TABLES = Object.freeze([
  { table: 'organizations',        pk: 'id', scope: 'organization' },
  { table: 'workspaces',           pk: 'id', scope: 'self' },
  { table: 'users',                pk: 'id', scope: 'user' },
  { table: 'organization_members', pk: 'id', scope: { via: 'organization_id', parent: 'organizations' } },
  { table: 'workspace_members',    pk: 'id', scope: 'workspace_id' },
  { table: 'content_folders',      pk: 'id', scope: 'workspace_id' },
  { table: 'content',              pk: 'id', scope: 'workspace_id' },
  { table: 'custom_fonts',         pk: 'id', scope: 'workspace_id' },
  { table: 'custom_shaders',       pk: 'id', scope: 'workspace_id' },
  { table: 'data_sources',         pk: 'id', scope: 'workspace_id' },
  { table: 'widgets',              pk: 'id', scope: 'workspace_id' },
  { table: 'layouts',              pk: 'id', scope: 'workspace_id' },
  { table: 'layout_zones',         pk: 'id', scope: { via: 'layout_id', parent: 'layouts' } },
  { table: 'slide_decks',          pk: 'id', scope: 'workspace_id' },
  { table: 'playlists',            pk: 'id', scope: 'workspace_id' },
  { table: 'playlist_items',       pk: 'id', scope: { via: 'playlist_id', parent: 'playlists' } },
  { table: 'playlist_item_schedules', pk: 'id', scope: { via: 'playlist_item_id', parent: 'playlist_items' } },
  { table: 'schedules',            pk: 'id', scope: 'workspace_id' },
  { table: 'device_groups',        pk: 'id', scope: 'workspace_id' },
  { table: 'devices',              pk: 'id', scope: 'workspace_id', updateOf: 'config' },
  { table: 'device_group_members', pk: ['device_id', 'group_id'], scope: { via: 'group_id', parent: 'device_groups' } },
  { table: 'assignments',          pk: 'id', scope: { via: 'device_id', parent: 'devices' } },
  { table: 'video_walls',          pk: 'id', scope: 'workspace_id' },
  { table: 'video_wall_devices',   pk: 'id', scope: { via: 'wall_id', parent: 'video_walls' } },
  { table: 'kiosk_pages',          pk: 'id', scope: 'workspace_id' },
  { table: 'triggers',             pk: 'id', scope: 'workspace_id' },
  { table: 'alert_rules',          pk: 'id', scope: 'workspace_id' },
  { table: 'alert_configs',        pk: 'id', scope: 'workspace_id' },
  { table: 'white_labels',         pk: 'id', scope: 'workspace_id' },
  { table: 'activity_log',         pk: 'id', scope: 'workspace_id' },
  { table: 'revisions',            pk: 'id', scope: 'workspace_id' },
]);

const TABLE_BY_NAME = Object.freeze(Object.fromEntries(TABLES.map((t) => [t.table, t])));

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function columnsFor(db, table) {
  const block = new Set(BLOCKLIST[table] || []);
  return tableInfo(db, table).map((c) => c.name).filter((n) => !block.has(n));
}

function pkCols(spec) { return Array.isArray(spec.pk) ? spec.pk : [spec.pk]; }

/** Row id as stored in the change log: the pk value, or a JSON array for a composite key. */
function rowIdSql(spec, ref) {
  const cols = pkCols(spec);
  if (cols.length === 1) return `${ref}.${cols[0]}`;
  return `json_array(${cols.map((c) => `${ref}.${c}`).join(', ')})`;
}

function parseRowId(spec, rowId) {
  const cols = pkCols(spec);
  if (cols.length === 1) return { [cols[0]]: rowId };
  const vals = JSON.parse(rowId);
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

/**
 * SQL expression giving the workspace id of the row `ref` (NEW/OLD in a trigger, an alias in a
 * query). Recursive: a hop resolves through the PARENT table's own scope rule, so a grandchild of
 * an organization-scoped table works without a special case.
 */
function workspaceIdSql(spec, ref) {
  const s = spec.scope;
  if (s === 'workspace_id') return `${ref}.workspace_id`;
  if (s === 'self') return `${ref}.id`;
  if (s === 'organization') return `(SELECT id FROM workspaces WHERE organization_id = ${ref}.id LIMIT 1)`;
  if (s === 'user') return `(SELECT workspace_id FROM workspace_members WHERE user_id = ${ref}.id LIMIT 1)`;
  return wsOfParentRow(s.parent, `${ref}.${s.via}`);
}

/** Workspace id of the row of `table` whose id is `idExpr`, by that table's scope rule. */
function wsOfParentRow(table, idExpr) {
  const spec = TABLE_BY_NAME[table];
  if (!spec) return `(SELECT workspace_id FROM ${table} WHERE id = ${idExpr})`;
  const s = spec.scope;
  if (s === 'workspace_id') return `(SELECT workspace_id FROM ${table} WHERE id = ${idExpr})`;
  if (s === 'self') return idExpr;
  if (s === 'organization') return `(SELECT id FROM workspaces WHERE organization_id = ${idExpr} LIMIT 1)`;
  if (s === 'user') return `(SELECT workspace_id FROM workspace_members WHERE user_id = ${idExpr} LIMIT 1)`;
  return wsOfParentRow(s.parent, `(SELECT ${s.via} FROM ${table} WHERE id = ${idExpr})`);
}

/* ============================== triggers (primary) ============================== */

function triggerName(table, op) { return `mesh_cl_${table}_${op}`; }

function triggerSql(db, spec) {
  const t = spec.table;
  const ins = (ref, op) =>
    `INSERT INTO mesh_change_log (workspace_id, table_name, row_id, op) ` +
    `SELECT ${workspaceIdSql(spec, ref)}, '${t}', ${rowIdSql(spec, ref)}, '${op}' ` +
    `WHERE ${workspaceIdSql(spec, ref)} IS NOT NULL`;
  let updateOf = '';
  if (spec.updateOf === 'config') {
    const volatile = new Set(DEVICE_VOLATILE);
    const cols = tableInfo(db, t).map((c) => c.name).filter((n) => !volatile.has(n));
    updateOf = ` OF ${cols.join(', ')}`;
  }
  return [
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t, 'ins')} AFTER INSERT ON ${t} BEGIN ${ins('NEW', 'upsert')}; END`,
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t, 'upd')} AFTER UPDATE${updateOf} ON ${t} BEGIN ${ins('NEW', 'upsert')}; END`,
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(t, 'del')} AFTER DELETE ON ${t} BEGIN ${ins('OLD', 'delete')}; END`,
  ];
}

function installedTriggers(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mesh_cl_%'")
    .all().map((r) => r.name);
}

/** Does any active up edge carry workspace-replication? (Read live; never cached.) */
function replicationWanted(db) {
  try {
    const rows = db.prepare(
      "SELECT grant_categories FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL").all();
    return rows.some((r) => {
      try { return JSON.parse(r.grant_categories || '[]').includes('workspace-replication'); } catch (_) { return false; }
    });
  } catch (_) { return false; }
}

/**
 * Make the trigger set match the grant state. Returns what it did so the caller can log it.
 * Idempotent; safe to call on every edge change.
 */
function ensureTriggers(db, { wanted = replicationWanted(db) } = {}) {
  const have = installedTriggers(db);
  if (wanted) {
    if (have.length === TABLES.length * 3) return { action: 'kept', count: have.length };
    db.transaction(() => {
      for (const spec of TABLES) {
        if (!tableInfo(db, spec.table).length) continue; // table absent on this build: skip, never fail boot
        for (const sql of triggerSql(db, spec)) db.exec(sql);
      }
    })();
    return { action: 'created', count: installedTriggers(db).length };
  }
  if (!have.length) return { action: 'absent', count: 0 };
  db.transaction(() => { for (const n of have) db.exec(`DROP TRIGGER IF EXISTS ${n}`); })();
  return { action: 'dropped', count: have.length };
}

/* ============================== reads (answered on the read worker) ============================== */

function headRev(db) {
  const r = db.prepare('SELECT MAX(rev) AS rev FROM mesh_change_log').get();
  return (r && r.rev) || 0;
}

/**
 * Changes after `since` for the given workspaces, oldest first, bounded. Coalesced per row: only
 * the latest op for a (table,row) within the page is returned, so a row edited forty times since the
 * replica last looked is one upsert. `upto` is the highest rev examined, which the replica stores
 * as its position — never the last rev returned, or a coalesced-away rev would be re-read forever.
 */
function changesSince(db, workspaceIds, since, limit = 500) {
  if (!workspaceIds || !workspaceIds.length) return { rows: [], upto: since, head: headRev(db) };
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  const marks = workspaceIds.map(() => '?').join(',');
  // Head BEFORE the select: a rev committed between the two must not be skipped by the jump below.
  const headBefore = headRev(db);
  const raw = db.prepare(
    `SELECT rev, workspace_id, table_name, row_id, op FROM mesh_change_log
     WHERE rev > ? AND workspace_id IN (${marks}) ORDER BY rev ASC LIMIT ?`
  ).all(Number(since) || 0, ...workspaceIds, lim);
  const latest = new Map();
  let upto = Number(since) || 0;
  for (const r of raw) { latest.set(`${r.table_name}\u0000${r.row_id}`, r); upto = r.rev; }
  // A short page means every rev up to headBefore was examined; the ones not returned belong to
  // other workspaces. Park the replica there, or its position (and so the primary's acked_rev,
  // which bounds pruneLog) sticks at the last rev it was granted while the log grows past it —
  // seen on a mid-tier node whose OWN copies of its children kept its log moving.
  if (raw.length < lim && headBefore > upto) upto = headBefore;
  const rows = [...latest.values()].sort((a, b) => a.rev - b.rev).map((r) => {
    const spec = TABLE_BY_NAME[r.table_name];
    const row = (r.op === 'upsert' && spec) ? fetchRow(db, spec, r.row_id) : null;
    // A row deleted between the log write and this read is reported as a delete: the copy must
    // not hold a row the primary no longer has.
    return { rev: r.rev, workspace_id: r.workspace_id, table: r.table_name, row_id: r.row_id,
             op: row ? 'upsert' : 'delete', row };
  });
  return { rows, upto, head: headRev(db), more: raw.length === lim };
}

function fetchRow(db, spec, rowId) {
  const cols = columnsFor(db, spec.table);
  const where = pkCols(spec).map((c) => `${c} = ?`).join(' AND ');
  const key = parseRowId(spec, rowId);
  return scrubRow(db.prepare(`SELECT ${cols.join(', ')} FROM ${spec.table} WHERE ${where}`)
    .get(...pkCols(spec).map((c) => key[c])) || null);
}

/**
 * One page of one table for the initial copy, ordered by primary key, for the given workspaces.
 * `after` is the last row_id of the previous page (opaque to the caller).
 */
function snapshotPage(db, table, workspaceIds, after, limit = 500) {
  const spec = TABLE_BY_NAME[table];
  if (!spec) return { ok: false, reason: 'That table is not replicated.' };
  if (!workspaceIds || !workspaceIds.length) return { ok: true, rows: [], done: true };
  if (!tableInfo(db, table).length) return { ok: true, rows: [], done: true };
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  const cols = columnsFor(db, table);
  const pks = pkCols(spec);
  const marks = workspaceIds.map(() => '?').join(',');
  const wsExpr = workspaceIdSql(spec, 't');
  const params = [...workspaceIds];
  let afterClause = '';
  if (after != null && after !== '') {
    const key = parseRowId(spec, String(after));
    // Keyset pagination on the pk tuple: (a,b) > (?,?) as SQLite row values.
    afterClause = ` AND (${pks.map((c) => `t.${c}`).join(', ')}) > (${pks.map(() => '?').join(', ')})`;
    params.push(...pks.map((c) => key[c]));
  }
  const rows = db.prepare(
    `SELECT ${cols.map((c) => `t.${c}`).join(', ')} FROM ${table} t
     WHERE ${wsExpr} IN (${marks})${afterClause}
     ORDER BY ${pks.map((c) => `t.${c}`).join(', ')} ASC LIMIT ?`
  ).all(...params, lim).map(scrubRow);
  const last = rows.length
    ? (pks.length === 1 ? String(rows[rows.length - 1][pks[0]]) : JSON.stringify(pks.map((c) => rows[rows.length - 1][c])))
    : null;
  return { ok: true, table, rows, next: rows.length === lim ? last : null, done: rows.length < lim };
}

/** Drop log rows every active replica has acknowledged, keeping a floor so a weekend outage resumes incrementally. */
function pruneLog(db, { floorSec = 7 * 86400, now = nowSec() } = {}) {
  const edges = db.prepare(
    "SELECT acked_rev FROM mesh_edges WHERE direction = 'up' AND revoked_at IS NULL").all();
  const acked = edges.map((e) => Number(e.acked_rev) || 0);
  if (!acked.length) return 0;
  const minAcked = Math.min(...acked);
  return db.prepare('DELETE FROM mesh_change_log WHERE rev <= ? AND ts < ?').run(minAcked, now - floorSec).changes;
}

module.exports = {
  TABLES, TABLE_BY_NAME, BLOCKLIST, SECRET_NAME_RE, NOT_A_SECRET, DEVICE_VOLATILE, scrubJson,
  columnsFor, pkCols, parseRowId, workspaceIdSql,
  ensureTriggers, installedTriggers, replicationWanted, triggerSql,
  headRev, changesSince, snapshotPage, fetchRow, pruneLog,
};
