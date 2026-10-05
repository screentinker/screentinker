'use strict';

/*
 * Corporate (head office) playlists — ALL of the feature's DDL, in ONE place.
 *
 * Applied by db/database.js after the multi-tenancy tables exist (organizations is created by the
 * multitenancy phase, after the inline migrations array), and by any test fixture that hand-builds
 * a schema — imported, never pasted, for the same reason the resolver views live in
 * lib/playlist-resolver-sql.js: a fixture that copies DDL drifts into proving things about a
 * database that does not exist.
 *
 * Every statement is idempotent: CREATE ... IF NOT EXISTS, or an ADD COLUMN that the caller's
 * tolerant loop treats as benign when it reports "duplicate column name".
 *
 * ⚠️ The whole feature's schema ships in Stage A (slots, fills, compositions, emergency scopes and
 * activations included), so later stages add no DDL and no second migration window.
 *
 * ⚠️ There is deliberately NO foreign key from organizations to workspaces (hq_workspace_id): the
 * two would reference each other, and the tenant-cascade rebuild (lib/tenant-cascade-migration.js)
 * would fire it. hq_workspace_id is checked by the application instead.
 *
 * ⚠️ playlist_items.slot_id is NO ACTION, not RESTRICT. Deleting a corporate playlist cascades both
 * its playlist_items and its corporate_slots in one statement; RESTRICT is checked immediately and
 * in undefined cascade order, NO ACTION at statement end, when both are gone.
 */

const TABLES = [
  `CREATE TABLE IF NOT EXISTS corporate_slots (
     id                    TEXT PRIMARY KEY,
     organization_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     playlist_id           TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
     name                  TEXT NOT NULL,
     help_text             TEXT,
     max_items             INTEGER,
     max_total_sec         INTEGER,
     allow_video           INTEGER NOT NULL DEFAULT 1,
     allow_widgets         INTEGER NOT NULL DEFAULT 1,
     fallback_content_id   TEXT REFERENCES content(id) ON DELETE SET NULL,
     fallback_widget_id    TEXT REFERENCES widgets(id) ON DELETE SET NULL,
     fallback_duration_sec INTEGER,
     retired_at            INTEGER,
     created_by            TEXT,
     created_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at            INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     CHECK (fallback_content_id IS NULL OR fallback_widget_id IS NULL)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_corporate_slots_playlist ON corporate_slots(playlist_id)',

  `CREATE TABLE IF NOT EXISTS corporate_slot_fills (
     id               TEXT PRIMARY KEY,
     slot_id          TEXT NOT NULL REFERENCES corporate_slots(id) ON DELETE CASCADE,
     workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     scope_kind       TEXT NOT NULL CHECK (scope_kind IN ('workspace','group','device','wall')),
     scope_id         TEXT NOT NULL,
     fill_playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
     fill_state       TEXT NOT NULL DEFAULT 'ok' CHECK (fill_state IN ('ok','over_limit')),
     created_by       TEXT,
     created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     UNIQUE (slot_id, scope_kind, scope_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_corporate_fills_ws ON corporate_slot_fills(workspace_id)',
  'CREATE INDEX IF NOT EXISTS idx_corporate_fills_list ON corporate_slot_fills(fill_playlist_id)',

  /* One mandate per target. playlist_id is NO ACTION on purpose: a playlist that plays somewhere
   * because head office said so cannot be deleted out from under the screens (the route answers a
   * 409 naming where it plays before the DELETE runs). dark = "head office turned these off". */
  `CREATE TABLE IF NOT EXISTS corporate_mandates (
     id              TEXT PRIMARY KEY,
     organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     playlist_id     TEXT REFERENCES playlists(id),
     dark            INTEGER NOT NULL DEFAULT 0,
     target_kind     TEXT NOT NULL CHECK (target_kind IN ('org','workspace','group','device','wall')),
     target_id       TEXT NOT NULL,
     layout_id       TEXT REFERENCES layouts(id) ON DELETE SET NULL,
     enabled         INTEGER NOT NULL DEFAULT 1,
     note            TEXT,
     created_by      TEXT,
     created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     UNIQUE (target_kind, target_id),
     CHECK ((dark = 1 AND playlist_id IS NULL) OR (dark = 0 AND playlist_id IS NOT NULL))
   )`,
  'CREATE INDEX IF NOT EXISTS idx_corporate_mandates_pl ON corporate_mandates(playlist_id)',
  'CREATE INDEX IF NOT EXISTS idx_corporate_mandates_org ON corporate_mandates(organization_id, enabled)',

  /* Derived cache (Stage B). Never replicated, never exported; safe to DELETE FROM at any time. */
  `CREATE TABLE IF NOT EXISTS corporate_compositions (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
     signature       TEXT NOT NULL,
     inputs_rev      TEXT NOT NULL,
     snapshot        TEXT NOT NULL,
     playback_order  TEXT NOT NULL DEFAULT 'sequential',
     composed_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     UNIQUE (playlist_id, signature)
   )`,

  /* Emergency trigger scope (Stage C). trigger_assignments.target_type has a CHECK of
   * ('device','group'); widening it needs a table rebuild, so emergency scope gets its own table. */
  `CREATE TABLE IF NOT EXISTS emergency_trigger_scopes (
     trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
     scope_kind TEXT NOT NULL CHECK (scope_kind IN ('org','workspace','group','device')),
     scope_id   TEXT NOT NULL,
     PRIMARY KEY (trigger_id, scope_kind, scope_id)
   )`,
  `CREATE TABLE IF NOT EXISTS emergency_activations (
     id           TEXT PRIMARY KEY,
     trigger_id   TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
     started_by   TEXT NOT NULL,
     started_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     expires_at   INTEGER NOT NULL,
     ended_at     INTEGER,
     ended_by     TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_emergency_activations_live ON emergency_activations(ended_at, expires_at)',
];

const COLUMNS = [
  // organizations — the per-org switches. Everything defaults to "the feature is not in use".
  ['organizations', 'corporate_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['organizations', 'hq_workspace_id', 'TEXT'],
  ['organizations', 'corporate_authors', "TEXT NOT NULL DEFAULT 'org_admins'"],
  ['organizations', 'emergency_triggers_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['organizations', 'store_triggers_under_mandate', "TEXT NOT NULL DEFAULT 'allow'"],
  ['organizations', 'store_trigger_cap_sec', 'INTEGER NOT NULL DEFAULT 300'],
  // playlists
  ['playlists', 'corporate', 'INTEGER NOT NULL DEFAULT 0'],
  ['playlists', 'published_composable', 'TEXT'],
  ['playlists', 'published_rev', 'INTEGER NOT NULL DEFAULT 0'],
  // playlist_items — the slot placement (Stage B writes it; Stage A refuses it outside corporate).
  ['playlist_items', 'slot_id', 'TEXT REFERENCES corporate_slots(id)'],
  // triggers
  ['triggers', 'kind', "TEXT NOT NULL DEFAULT 'normal'"],
  /* display_power_schedules — whether an org admin (head office) set this schedule. A store's
   * power schedule must not blank a mandated screen; head office's may (lib/device-power-schedule). */
  ['display_power_schedules', 'set_by_org_admin', 'INTEGER NOT NULL DEFAULT 0'],
];

const INDEXES = [
  /* Lets the backstop (lib/corporate/backstop.js) answer "does this install have ANY corporate
   * playlist?" with one index probe, so a playlist_items write on an install that never uses the
   * feature pays nothing more. */
  'CREATE INDEX IF NOT EXISTS idx_playlists_corporate ON playlists(id) WHERE corporate = 1',
  'CREATE INDEX IF NOT EXISTS idx_playlist_items_slot ON playlist_items(slot_id) WHERE slot_id IS NOT NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS uq_playlist_items_slot ON playlist_items(slot_id) WHERE slot_id IS NOT NULL',
];

/** Every statement, in the order it must run: tables, then columns that reference them, then indexes. */
const CORPORATE_MIGRATIONS = [
  ...TABLES,
  ...COLUMNS.map(([t, c, def]) => `ALTER TABLE ${t} ADD COLUMN ${c} ${def}`),
  ...INDEXES,
];

/**
 * Apply every statement, tolerating "duplicate column" / "already exists" exactly like the boot
 * loop in db/database.js. Anything else is logged loudly (issue #37: a swallowed migration
 * failure is a silent runtime failure later) and reported to the caller.
 *
 * `skipMissingTables`: a hand-built fixture may lack a table a column belongs to (triggers,
 * display_power_schedules); its ALTER is skipped rather than failing the fixture.
 *
 * @returns {string[]} the statements that failed for a reason other than "already applied"
 */
function applyCorporateSchema(db, { skipMissingTables = false, log = console } = {}) {
  const failed = [];
  const have = () => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  let tables = have();
  for (const sql of CORPORATE_MIGRATIONS) {
    const alter = /^ALTER TABLE (\w+) ADD COLUMN/i.exec(sql);
    if (alter && skipMissingTables && !tables.has(alter[1])) continue;
    const create = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql);
    try {
      db.exec(sql);
      if (create) tables = have();
    } catch (e) {
      if (/duplicate column name|already exists/i.test(e.message)) continue;
      if (skipMissingTables && /no such table/i.test(e.message)) continue;
      failed.push(sql);
      if (log) log.error(`[corporate] migration FAILED: ${sql.split('\n')[0]}\n          -> ${e.message}`);
    }
  }
  return failed;
}

/** [table, column, repairSQL] for lib/schema-check.js — the columns the corporate code reads. */
const REQUIRED_CORPORATE_COLUMNS = COLUMNS
  .filter(([t]) => t === 'organizations' || t === 'playlists')
  .map(([t, c, def]) => [t, c, `ALTER TABLE ${t} ADD COLUMN ${c} ${def}`]);

module.exports = { CORPORATE_MIGRATIONS, applyCorporateSchema, REQUIRED_CORPORATE_COLUMNS, COLUMNS };
