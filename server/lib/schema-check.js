'use strict';

// #37: verify the DB has the schema the running code REQUIRES, after all
// migrations have run. On a partial/stale DB (e.g. a Docker rebuild that missed a
// migration) it repairs missing repairable columns idempotently and logs clearly;
// if anything required is STILL missing it calls onMissing (default: loud log +
// process.exit(1)) so the server fails fast at boot instead of limping along and
// breaking at the first authed request. The #37 lockout was a silently-absent
// users.must_change_password, which the auth middleware gates every request on.

// Tables the request path depends on (schema.sql creates them with CREATE TABLE
// IF NOT EXISTS on every boot; listed so their absence is still caught loudly).
const REQUIRED_TABLES = [
  'users', 'organizations', 'organization_members', 'workspaces', 'workspace_members',
  'devices', 'content', 'playlists', 'activity_log', 'schema_migrations',
];

// [table, column, repairSQL] — columns the code SELECTs / gates on. repairSQL is
// the idempotent ALTER that adds it if missing (null = base column, assert only).
const REQUIRED_COLUMNS = [
  ['users', 'must_change_password', "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0"],
  ['users', 'role', null],
  ['users', 'plan_id', "ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'"],
  /*
   * ⚠️ Every column the playlist resolver views name (lib/playlist-resolver-sql.js). The views are
   * recreated at the END of boot and SQLite rejects a CREATE VIEW naming a missing column — so a
   * partial schema would otherwise fail there, after this check said the database was healthy.
   * Only the tables listed in REQUIRED_TABLES are checked; the rest are created by schema.sql.
   */
  ['devices', 'workspace_id', 'ALTER TABLE devices ADD COLUMN workspace_id TEXT'],
  ['devices', 'playlist_id', 'ALTER TABLE devices ADD COLUMN playlist_id TEXT'],
  ['devices', 'playlist_source', 'ALTER TABLE devices ADD COLUMN playlist_source TEXT'],
  ['devices', 'wall_id', 'ALTER TABLE devices ADD COLUMN wall_id TEXT'],
  ['devices', 'layout_id', 'ALTER TABLE devices ADD COLUMN layout_id TEXT'],
  ['devices', 'scheduled_playlist_id', 'ALTER TABLE devices ADD COLUMN scheduled_playlist_id TEXT'],
  ['devices', 'scheduled_layout_id', 'ALTER TABLE devices ADD COLUMN scheduled_layout_id TEXT'],
  ['workspaces', 'organization_id', 'ALTER TABLE workspaces ADD COLUMN organization_id TEXT'],
  ['playlists', 'workspace_id', 'ALTER TABLE playlists ADD COLUMN workspace_id TEXT'],
  // Corporate (head office) playlists — lib/corporate/schema-sql.js is the one definition.
  ...require('./corporate/schema-sql').REQUIRED_CORPORATE_COLUMNS,
];

function defaultOnMissing(missing) {
  const bar = '='.repeat(72);
  console.error(`\n${bar}`);
  console.error('[schema-check] FATAL: database is missing required schema:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Migrations did not make the schema code-complete. The server is');
  console.error('refusing to start to avoid silent runtime failures (e.g. issue #37,');
  console.error('where a missing users.must_change_password failed every login).');
  console.error('Fix: restore the newest db/remote_display.pre-*.db snapshot, or add');
  console.error('the missing column/table manually, then restart.');
  console.error(`${bar}\n`);
  process.exit(1);
}

// Returns the list of still-missing items (empty when healthy). Calls
// opts.onMissing(missing) when non-empty (default exits the process).
function verifyAndRepairSchema(db, opts = {}) {
  const onMissing = opts.onMissing || defaultOnMissing;
  const tableSet = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const columns = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));

  const missing = [];
  for (const t of REQUIRED_TABLES) if (!tableSet.has(t)) missing.push(`table "${t}"`);

  for (const [t, c, repair] of REQUIRED_COLUMNS) {
    if (!tableSet.has(t)) continue; // table-missing already recorded
    if (columns(t).has(c)) continue;
    if (repair) {
      try {
        console.warn(`[schema-check] required column ${t}.${c} is missing — applying repair...`);
        db.exec(repair);
        console.warn(`[schema-check] repaired ${t}.${c}`);
      } catch (e) {
        console.error(`[schema-check] repair of ${t}.${c} FAILED: ${e.message}`);
      }
    }
    if (!columns(t).has(c)) missing.push(`column "${t}.${c}"`);
  }

  if (missing.length) onMissing(missing);
  return missing;
}

module.exports = { verifyAndRepairSchema, REQUIRED_TABLES, REQUIRED_COLUMNS };
