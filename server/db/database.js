const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Auto-apply Phase 1 multi-tenancy migration if not yet applied. Without this
// a self-hoster who pulls latest and restarts hits a crash in
// migrateFolderWorkspaceIds (queries workspaces table that doesn't exist).
// Pre-existing data is snapshotted to db/remote_display.pre-migration-<ts>.db
// before the migration runs - clear restore path on failure. Fresh installs
// run against empty data (creates tables, no rows to backfill).
function ensureMultitenancyMigration() {
  let applied = false;
  try {
    applied = !!db.prepare(
      "SELECT 1 FROM schema_migrations WHERE id = 'phase5_multitenancy_backfill'"
    ).get();
  } catch { /* schema_migrations may not exist yet; treat as not applied */ }
  if (applied) return;

  console.warn('[boot] Multi-tenancy schema not present - applying migration...');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dbDir, `remote_display.pre-migration-${ts}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, snapshotPath);
    console.warn(`[boot] Pre-migration snapshot: ${snapshotPath}`);
  } catch (e) {
    console.error(`[boot] Snapshot failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const { runMigration } = require('../../scripts/migrate-multitenancy');
    runMigration({ db });
    console.warn('[boot] Migration complete, continuing startup');
  } catch (e) {
    console.error(`[boot] Migration FAILED: ${e.message}`);
    console.error(`[boot] Restore with: cp ${snapshotPath} ${config.dbPath}`);
    process.exit(1);
  }
}

// Note: ensureMultitenancyMigration() is called LATER, after the inline
// migrations array has added team_id and workspace_id columns. The Phase 1
// migration script reads team_id from resource tables during its backfill
// loop, so those columns must exist first. Definition kept here near the
// top so the auto-migration logic is easy to find when reading the file.

// Migrations for existing databases
const migrations = [
  'ALTER TABLE content ADD COLUMN remote_url TEXT',
  'ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id)',
  'ALTER TABLE content ADD COLUMN user_id TEXT REFERENCES users(id)',
  "ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'",
  'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
  'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
  "ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'",
  'ALTER TABLE users ADD COLUMN subscription_ends INTEGER',
  // Layout & zone support on devices and assignments
  'ALTER TABLE devices ADD COLUMN layout_id TEXT',
  'ALTER TABLE devices ADD COLUMN timezone TEXT DEFAULT \'UTC\'',
  // #74/#75: player-reported clock, for effective-timezone resolution + the
  // dashboard clock-skew indicator. reported_timezone = player OS IANA zone;
  // reported_utc = device's claimed UTC (ms); reported_at = server receipt (s).
  'ALTER TABLE devices ADD COLUMN reported_timezone TEXT',
  'ALTER TABLE devices ADD COLUMN reported_utc INTEGER',
  'ALTER TABLE devices ADD COLUMN reported_at INTEGER',
  'ALTER TABLE devices ADD COLUMN wall_id TEXT',
  'ALTER TABLE devices ADD COLUMN team_id TEXT',
  'ALTER TABLE assignments ADD COLUMN zone_id TEXT',
  'ALTER TABLE assignments ADD COLUMN widget_id TEXT',
  // Team support on content
  'ALTER TABLE content ADD COLUMN team_id TEXT',
  // Device notes
  'ALTER TABLE devices ADD COLUMN notes TEXT',
  // Email settings on users
  "ALTER TABLE users ADD COLUMN email_alerts INTEGER DEFAULT 1",
  // Content folders
  'ALTER TABLE content ADD COLUMN folder TEXT',
  // Device orientation and default content
  "ALTER TABLE devices ADD COLUMN orientation TEXT DEFAULT 'landscape'",
  'ALTER TABLE devices ADD COLUMN default_content_id TEXT',
  // Audio control per assignment
  "ALTER TABLE assignments ADD COLUMN muted INTEGER DEFAULT 0",
  // Trial tracking
  "ALTER TABLE users ADD COLUMN trial_started INTEGER",
  "ALTER TABLE users ADD COLUMN trial_plan TEXT DEFAULT 'pro'",
  // Stripe price IDs on plans
  "ALTER TABLE plans ADD COLUMN stripe_price_monthly TEXT",
  "ALTER TABLE plans ADD COLUMN stripe_price_yearly TEXT",
  // Last login tracking
  "ALTER TABLE users ADD COLUMN last_login INTEGER",
  // Phase 2: every device gets a playlist, schedules can override with a playlist
  "ALTER TABLE devices ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  "ALTER TABLE schedules ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  "ALTER TABLE playlists ADD COLUMN is_auto_generated INTEGER NOT NULL DEFAULT 0",
  // Device authentication token
  "ALTER TABLE devices ADD COLUMN device_token TEXT",
  // Phase 3: playlist publish/draft state
  "ALTER TABLE playlists ADD COLUMN status TEXT NOT NULL DEFAULT 'draft'",
  "ALTER TABLE playlists ADD COLUMN published_snapshot TEXT",
  // Phase 4: group scheduling (column add only — full migration with CHECK below)
  "ALTER TABLE schedules ADD COLUMN group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL",
  // Hierarchical content folders (per-user)
  `CREATE TABLE IF NOT EXISTS content_folders (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES content_folders(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_content_folders_user ON content_folders(user_id, parent_id)",
  "ALTER TABLE content ADD COLUMN folder_id TEXT REFERENCES content_folders(id) ON DELETE SET NULL",
  "CREATE INDEX IF NOT EXISTS idx_content_folder ON content(folder_id)",
  // Group-level playlist: when set, devices added to the group inherit it.
  "ALTER TABLE device_groups ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  // Wall-level playlist: video walls now play a playlist (not just one content).
  "ALTER TABLE video_walls ADD COLUMN playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  // Free-form canvas layout: walls store a player rect; member devices store
  // their own rect. Coordinates are in arbitrary canvas units (effectively px).
  "ALTER TABLE video_walls ADD COLUMN player_x REAL",
  "ALTER TABLE video_walls ADD COLUMN player_y REAL",
  "ALTER TABLE video_walls ADD COLUMN player_width REAL",
  "ALTER TABLE video_walls ADD COLUMN player_height REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_x REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_y REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_width REAL",
  "ALTER TABLE video_wall_devices ADD COLUMN canvas_height REAL",
  // Phase 2.2c: content_folders gets workspace_id. Phase 1 missed this table.
  "ALTER TABLE content_folders ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
  "CREATE INDEX IF NOT EXISTS idx_content_folders_workspace ON content_folders(workspace_id)",
  // Phase 2 zone_id regression fix: playlist_items needs zone_id so the
  // multi-zone-layout assignment feature works. The Phase 2 assignments->
  // playlist_items conversion (migrateAssignmentsToPlaylists) dropped this
  // column. Column ADD is idempotent via the surrounding try/catch loop.
  "ALTER TABLE playlist_items ADD COLUMN zone_id TEXT REFERENCES layout_zones(id) ON DELETE SET NULL",
  // #129: per-item mute. The legacy `assignments` table had a muted column, but the
  // active device payload is built from playlist_items -> published_snapshot, which never
  // carried it, so the dashboard mute toggle was a no-op end to end.
  "ALTER TABLE playlist_items ADD COLUMN muted INTEGER NOT NULL DEFAULT 0",
  // Slice 1: idempotency guard for the one-time signup welcome/admin emails.
  // Non-null = this user has already been handled, so we never double-send.
  // New signups are stamped with the real unix-seconds time the send block ran
  // (see services/signupEmails.js). The paired backfill below stamps every
  // pre-existing user with the sentinel value 1, so that a future "IS NULL"
  // sweep/nudge can't mistake the legacy user base for un-welcomed accounts and
  // blast all of them. Sentinel 1 (vs a real timestamp) also lets a later
  // deliberate campaign tell "backfilled, never emailed" apart from "genuinely
  // sent at <time>". The backfill is idempotent: re-runs match nothing.
  "ALTER TABLE users ADD COLUMN welcome_email_sent_at INTEGER",
  "UPDATE users SET welcome_email_sent_at = 1 WHERE welcome_email_sent_at IS NULL",
  // Slice 3: idempotency guard for the one-time T+3 activation nudge. Same
  // shape as welcome_email_sent_at: non-null = handled. New signups get a real
  // unix-seconds stamp when the daily sweep emails them (see
  // services/activationNudge.js). The paired sentinel-1 backfill marks every
  // pre-existing user as handled so the FIRST sweep can't blast the entire
  // dormant legacy base with a stale "you signed up a few days ago" nudge --
  // only genuinely-new signups (NULL) become eligible going forward.
  "ALTER TABLE users ADD COLUMN activation_nudge_sent_at INTEGER",
  "UPDATE users SET activation_nudge_sent_at = 1 WHERE activation_nudge_sent_at IS NULL",
  // Issue #14: normalize the platform-role model. The legacy /api/auth/users
  // dropdown could write 'superadmin' and 'admin' strings that not every code
  // path recognized (some checks matched only 'platform_admin', so a superadmin
  // could list orgs but not act-as into them). Collapse to the current model:
  //   superadmin -> platform_admin  (equivalent everywhere; fixes act-as)
  //   admin      -> user            (legacy middle tier; elevated power now
  //                                  comes from org/workspace membership)
  // Strictly idempotent: mutates ONLY exact legacy strings, no-ops on rows
  // already in the current model ('user'/'platform_admin'/'platform_operator').
  "UPDATE users SET role = 'platform_admin' WHERE role = 'superadmin'",
  "UPDATE users SET role = 'user' WHERE role = 'admin'",
  // Issue #10: admin-provisioned users. When an admin creates a user with a
  // known password, must_change_password=1 forces a password change on first
  // login. Default 0 so all existing users are unaffected.
  "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
  // #41 Phase 2: which image backend the workspace's image endpoint speaks.
  "ALTER TABLE ai_settings ADD COLUMN image_provider TEXT",
  // #41: optional separate key for the image endpoint (for local-LLM + cloud-image setups).
  "ALTER TABLE ai_settings ADD COLUMN image_api_key_enc TEXT",
  // #100: TOTP MFA. Columns default to "off" so every existing account is unaffected.
  "ALTER TABLE users ADD COLUMN totp_secret_enc TEXT",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0",
  "CREATE TABLE IF NOT EXISTS totp_recovery_codes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), used_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_totp_recovery_user ON totp_recovery_codes(user_id)",
  // #73: agency-token target allowlist (capability-restricted tokens).
  "CREATE TABLE IF NOT EXISTS api_token_targets (token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), PRIMARY KEY (token_id, playlist_id))",
  // #73: per-agency-token auto-publish (DEFAULT 0 = draft, the fail-safe).
  "ALTER TABLE api_tokens ADD COLUMN auto_publish INTEGER NOT NULL DEFAULT 0",
  // #73: agency-upload notification queue (batched digest).
  "CREATE TABLE IF NOT EXISTS agency_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, token_id TEXT NOT NULL, playlist_id TEXT NOT NULL, action TEXT NOT NULL, content_id TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), sent_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_agency_notifications_unsent ON agency_notifications(sent_at)",
  // #73: zone-binding was reverted (placement belongs to the device, not the playlist - see
  // the agency-tokens history). Drop the table on DBs where the short-lived migration ran.
  "DROP TABLE IF EXISTS api_token_target_zones",
  // #106: cosmetic per-workspace display ordering for the Displays view (drag-to-
  // reorder). Default 0 -> existing devices fall back to the created_at tiebreak.
  "ALTER TABLE devices ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
];
// Apply each ALTER idempotently. A "duplicate column name" / "already exists"
// error means the column is already present (expected on a migrated DB) - benign.
// ANY OTHER error is a real, partial-migration failure: log it loudly so it's
// visible at boot rather than as a silent runtime failure later (issue #37, where
// a swallowed failure left users.must_change_password absent -> total auth lockout).
let _migApplied = 0;
for (const sql of migrations) {
  // Only a successful ADD COLUMN means a genuinely-new column (it would throw
  // "duplicate column" if it already existed). UPDATE/index statements always
  // succeed, so they must NOT count toward "new migrations applied" or the boot
  // would falsely report work on every healthy start.
  const isAddColumn = /alter\s+table\s+\S+\s+add\s+column/i.test(sql);
  try {
    db.exec(sql);
    if (isAddColumn) _migApplied++;
  } catch (e) {
    if (!/duplicate column name|already exists/i.test(e.message)) {
      console.error(`[migrate] FAILED: ${sql}\n          -> ${e.message}`);
    }
  }
}
if (_migApplied > 0) console.log(`[migrate] applied ${_migApplied} new column migration(s)`);

// #74/#75 per-item schedules: the playlist_item_schedules table is created
// idempotently by schema.sql (CREATE TABLE IF NOT EXISTS, run every boot, so it
// self-applies on upgrade). Record it in schema_migrations for observability.
try { db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('phase7_playlist_item_schedules')").run(); } catch { /* schema_migrations not ready yet */ }

// Public API tokens: api_tokens table is created idempotently by schema.sql.
try { db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('phase8_api_tokens')").run(); } catch { /* schema_migrations not ready yet */ }

// Fix assignments table: make content_id nullable (SQLite requires table rebuild)
try {
  const colInfo = db.prepare("PRAGMA table_info(assignments)").all();
  const contentCol = colInfo.find(c => c.name === 'content_id');
  if (contentCol && contentCol.notnull === 1) {
    console.log('Migrating assignments table: making content_id nullable...');
    db.exec(`
      CREATE TABLE assignments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        content_id TEXT REFERENCES content(id) ON DELETE CASCADE,
        widget_id TEXT REFERENCES widgets(id) ON DELETE CASCADE,
        zone_id TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        duration_sec INTEGER NOT NULL DEFAULT 10,
        schedule_start TEXT,
        schedule_end TEXT,
        schedule_days TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        muted INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      INSERT INTO assignments_new SELECT id, device_id, content_id, widget_id, zone_id, sort_order, duration_sec, schedule_start, schedule_end, schedule_days, enabled, muted, created_at FROM assignments;
      DROP TABLE assignments;
      ALTER TABLE assignments_new RENAME TO assignments;
    `);
    console.log('Assignments table migrated successfully.');
  }
} catch (e) {
  console.error('Assignments migration error:', e.message);
}

// Phase 2 migration: convert existing assignments into per-device playlists
const MIGRATION_ID = 'phase2_playlist_migration';

async function migrateAssignmentsToPlaylists() {
  // Skip if already ran (tracked in schema_migrations table)
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(MIGRATION_ID);
  if (already) return;

  const { v4: uuidv4 } = require('uuid');
  const { execFile } = require('child_process');

  // Find devices that have at least one assignment
  const devicesWithAssignments = db.prepare(`
    SELECT DISTINCT d.id, d.name, d.user_id
    FROM devices d
    INNER JOIN assignments a ON a.device_id = d.id
    WHERE d.user_id IS NOT NULL
  `).all();

  if (devicesWithAssignments.length === 0) return;

  console.log(`Migrating ${devicesWithAssignments.length} device(s) from assignments to playlists...`);

  // Async ffprobe — matches the pattern in playlists.js probeAndUpdateDuration
  async function probeVideoDuration(content) {
    if (!content || !content.mime_type || !content.mime_type.startsWith('video/')) return null;
    if (content.duration_sec) return Math.ceil(content.duration_sec);
    if (!content.filepath) return null;
    try {
      const fullPath = path.join(config.contentDir, content.filepath);
      const stdout = await new Promise((resolve, reject) => {
        execFile('ffprobe', [
          '-v', 'quiet', '-print_format', 'json', '-show_format', fullPath
        ], { timeout: 15000 }, (err, out) => err ? reject(err) : resolve(out));
      });
      const info = JSON.parse(stdout);
      if (info.format?.duration) {
        const dur = parseFloat(info.format.duration);
        db.prepare('UPDATE content SET duration_sec = ? WHERE id = ?').run(dur, content.id);
        return Math.ceil(dur);
      }
    } catch (e) {
      console.warn(`  ffprobe failed for ${content.id}:`, e.message);
    }
    return null;
  }

  const getAssignments = db.prepare(`
    SELECT a.content_id, a.widget_id, a.sort_order, a.duration_sec,
           c.mime_type, c.filepath, c.duration_sec as content_duration
    FROM assignments a
    LEFT JOIN content c ON a.content_id = c.id
    WHERE a.device_id = ? AND a.enabled = 1
    ORDER BY a.sort_order ASC
  `);

  // Probe durations outside the transaction (async ffprobe can't run inside SQLite transaction)
  const devicePlaylists = [];
  let videosProbed = 0;
  let totalItems = 0;
  for (const device of devicesWithAssignments) {
    const playlistId = uuidv4();
    const assignments = getAssignments.all(device.id);
    const items = [];
    for (const a of assignments) {
      let duration = a.duration_sec;
      if (a.content_id && a.mime_type?.startsWith('video/')) {
        const probed = await probeVideoDuration({ id: a.content_id, mime_type: a.mime_type, filepath: a.filepath, duration_sec: a.content_duration });
        if (probed) { duration = probed; videosProbed++; }
      }
      items.push({ content_id: a.content_id, widget_id: a.widget_id, sort_order: a.sort_order, duration_sec: duration });
      totalItems++;
    }
    devicePlaylists.push({ device, playlistId, items });
  }

  // Insert everything in a single transaction
  const insertPlaylist = db.prepare(`INSERT INTO playlists (id, user_id, name, description, is_auto_generated) VALUES (?, ?, ?, ?, 1)`);
  const insertItem = db.prepare(`INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec) VALUES (?, ?, ?, ?, ?)`);
  const setDevicePlaylist = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');

  const migrate = db.transaction(() => {
    for (const { device, playlistId, items } of devicePlaylists) {
      insertPlaylist.run(playlistId, device.user_id, `${device.name} (migrated)`, 'Auto-generated from previous assignments');
      for (const item of items) {
        insertItem.run(playlistId, item.content_id || null, item.widget_id || null, item.sort_order, item.duration_sec);
      }
      setDevicePlaylist.run(playlistId, device.id);
    }
  });
  migrate();

  // Record that this migration has run
  db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(MIGRATION_ID);

  const scheduleCount = db.prepare('SELECT COUNT(*) as count FROM schedules').get().count;
  console.log(`Migration complete: ${devicesWithAssignments.length} device(s), ${totalItems} playlist item(s), ${videosProbed} video(s) probed, ${scheduleCount} schedule(s).`);
}

migrateAssignmentsToPlaylists().catch(e => console.error('Migration error:', e));

// Phase 3 migration: snapshot existing playlist items into published_snapshot
const PHASE3_MIGRATION_ID = 'phase3_publish_snapshot';

function migratePublishSnapshots() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE3_MIGRATION_ID);
  if (already) return;

  const playlists = db.prepare('SELECT id FROM playlists').all();
  if (playlists.length === 0) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE3_MIGRATION_ID);
    return;
  }

  console.log(`Phase 3 migration: snapshotting ${playlists.length} playlist(s) as published...`);

  const getItems = db.prepare(`
    SELECT pi.content_id, pi.widget_id, pi.sort_order, pi.duration_sec,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `);
  const updatePlaylist = db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ? WHERE id = ?");

  const migrate = db.transaction(() => {
    let snapshotted = 0;
    for (const playlist of playlists) {
      const items = getItems.all(playlist.id);
      updatePlaylist.run(JSON.stringify(items), playlist.id);
      snapshotted++;
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE3_MIGRATION_ID);
    console.log(`Phase 3 migration complete: ${snapshotted} playlist(s) snapshotted as published.`);
  });
  migrate();
}

migratePublishSnapshots();

// Phase 4 migration: add group_id to schedules, make device_id nullable, add CHECK constraint
const PHASE4_MIGRATION_ID = 'phase4_group_schedules';

function migrateGroupSchedules() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE4_MIGRATION_ID);
  if (already) return;

  console.log('Phase 4 migration: adding group_id to schedules, making device_id nullable...');

  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE schedules_new (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users(id),
        device_id       TEXT REFERENCES devices(id) ON DELETE CASCADE,
        group_id        TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
        zone_id         TEXT REFERENCES layout_zones(id) ON DELETE CASCADE,
        content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
        widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
        layout_id       TEXT REFERENCES layouts(id) ON DELETE SET NULL,
        playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
        title           TEXT NOT NULL DEFAULT '',
        start_time      TEXT NOT NULL,
        end_time        TEXT NOT NULL,
        timezone        TEXT NOT NULL DEFAULT 'UTC',
        recurrence      TEXT,
        recurrence_end  TEXT,
        priority        INTEGER NOT NULL DEFAULT 0,
        enabled         INTEGER NOT NULL DEFAULT 1,
        color           TEXT DEFAULT '#3B82F6',
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
      );

      INSERT INTO schedules_new (id, user_id, device_id, zone_id, content_id, widget_id, layout_id, playlist_id,
        title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at, updated_at)
      SELECT id, user_id, device_id, zone_id, content_id, widget_id, layout_id, playlist_id,
        title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at, updated_at
      FROM schedules;

      DROP TABLE schedules;
      ALTER TABLE schedules_new RENAME TO schedules;

      CREATE INDEX idx_schedules_device ON schedules(device_id, enabled);
      CREATE INDEX idx_schedules_group ON schedules(group_id, enabled);
    `);

    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE4_MIGRATION_ID);
    console.log('Phase 4 migration complete: schedules table rebuilt with group_id support.');
  });
  migrate();
}

migrateGroupSchedules();

// Phase 1 multi-tenancy migration (auto-applies if not yet run). Must come
// AFTER the inline migrations above so that team_id / workspace_id columns
// exist on resource tables - the Phase 1 backfill loop reads team_id and
// updates workspace_id.
ensureMultitenancyMigration();

// Phase 2.2c migration: backfill content_folders.workspace_id from owner's
// default workspace. The ALTER lives in the migrations array above; this
// one-shot populates the column for any rows that pre-date it.
const PHASE6_MIGRATION_ID = 'phase6_content_folders_workspace';

function migrateFolderWorkspaceIds() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE6_MIGRATION_ID);
  if (already) return;

  // Belt-and-suspenders: if multi-tenancy tables aren't present (auto-runner
  // somehow skipped), skip cleanly instead of crashing on the JOIN below.
  const hasWorkspaces = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspaces'"
  ).get();
  if (!hasWorkspaces) {
    console.warn('migrateFolderWorkspaceIds: workspaces table missing, skipping');
    return;
  }

  // Check the column exists before trying to backfill. (Defensive: on a fresh
  // install the schema.sql defines content_folders without the column, the
  // ALTER above adds it, and we proceed; but if anything went sideways we
  // skip rather than throw.)
  const cols = db.prepare("PRAGMA table_info(content_folders)").all();
  if (!cols.some(c => c.name === 'workspace_id')) {
    console.warn('Phase 2.2c migration: content_folders.workspace_id column missing, skipping backfill');
    return;
  }

  const stmt = db.prepare(`
    UPDATE content_folders SET workspace_id = (
      SELECT w.id FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
      WHERE wm.user_id = content_folders.user_id
      ORDER BY wm.joined_at ASC LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL
  `);

  const tx = db.transaction(() => {
    const result = stmt.run();
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE6_MIGRATION_ID);
    return result.changes;
  });
  const changes = tx();
  if (changes > 0) console.log(`Phase 2.2c migration: backfilled workspace_id on ${changes} content_folders row(s).`);
}

migrateFolderWorkspaceIds();

const PHASE_2_2_ACTIVITY_STOP_ID = 'phase_2_2_activity_log_stop_bleeding';

// One-time backfill of activity_log rows that were written between the
// Phase 1 schema migration and the writer-leak fix in this commit. Strategy:
//   * Rows with device_id: derive workspace_id from devices.workspace_id
//     (the activity is about a specific device, so this is unambiguous).
//   * Rows with no device_id but a user_id: derive from the user's oldest
//     workspace_members row (pre-flight confirmed 0 affected users have
//     more than one workspace, so the choice is unambiguous).
// Rows with user_id IS NULL (auth:login_failed and similar pre-tenancy
// system events) are left alone - they have no tenant context.
function backfillActivityLogWorkspace() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE_2_2_ACTIVITY_STOP_ID);
  if (already) return;

  // Belt-and-suspenders: if multi-tenancy tables aren't present (auto-runner
  // somehow skipped), skip cleanly instead of crashing on workspace_members.
  const hasMembers = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members'"
  ).get();
  if (!hasMembers) {
    console.warn('backfillActivityLogWorkspace: workspace_members table missing, skipping');
    return;
  }

  const viaDevice = db.prepare(`
    UPDATE activity_log SET workspace_id = (
      SELECT workspace_id FROM devices WHERE devices.id = activity_log.device_id
    )
    WHERE workspace_id IS NULL AND device_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM devices WHERE devices.id = activity_log.device_id AND devices.workspace_id IS NOT NULL)
  `);

  const viaMembers = db.prepare(`
    UPDATE activity_log SET workspace_id = (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = activity_log.user_id
      ORDER BY wm.joined_at ASC LIMIT 1
    )
    WHERE workspace_id IS NULL AND user_id IS NOT NULL AND device_id IS NULL
      AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.user_id = activity_log.user_id)
  `);

  const tx = db.transaction(() => {
    const d = viaDevice.run().changes;
    const m = viaMembers.run().changes;
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE_2_2_ACTIVITY_STOP_ID);
    return { d, m };
  });
  const { d, m } = tx();
  if (d + m > 0) console.log(`activity_log backfill: ${d} via device.workspace_id, ${m} via workspace_members lookup`);
}

backfillActivityLogWorkspace();

// Phase 2 zone_id backfill. Companion to the ADD COLUMN above. Attempts to
// recover zone_id values for playlist_items rows by joining back to the
// (legacy) assignments table on device+content/widget. On installs where
// assignments is empty or never had zone_id populated this is a no-op; the
// migration row is stamped regardless so it doesn't re-run.
//
// Also regenerates published_snapshot JSON for every published playlist so
// the snapshot the player consumes carries zone_id going forward (the
// player resolves a.zone_id === zone.id in renderZones). Even with zero
// rows backfilled, this republish closes the snapshot-staleness gap.
//
// Pre-migration snapshot is a one-off for this migration only - the general
// "every migration backs up first" framework is tracked as a separate
// concern, not built here.
const PHASE2_ZONE_ID_BACKFILL_ID = 'phase2_zone_id_backfill';
function backfillPlaylistItemsZoneId() {
  const already = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PHASE2_ZONE_ID_BACKFILL_ID);
  if (already) return;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dbDir, `remote_display.pre-zone-id-backfill-${ts}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, snapshotPath);
    console.warn(`[zone-id backfill] Pre-migration snapshot: ${snapshotPath}`);
  } catch (e) {
    console.error(`[zone-id backfill] Snapshot failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const tx = db.transaction(() => {
      // Backfill: best-effort match playlist_items back to assignments via
      // device.playlist_id and content/widget identity. LIMIT 1 covers the
      // unlikely "same content assigned twice in different zones on one
      // device" edge case. Items with no matching legacy assignment, or
      // matches that themselves had zone_id NULL, are left as NULL.
      const backfilled = db.prepare(`
        UPDATE playlist_items
        SET zone_id = (
          SELECT a.zone_id FROM assignments a
          JOIN devices d ON d.id = a.device_id
          WHERE d.playlist_id = playlist_items.playlist_id
            AND a.zone_id IS NOT NULL
            AND (
              (a.content_id IS NOT NULL AND a.content_id = playlist_items.content_id)
              OR
              (a.widget_id IS NOT NULL AND a.widget_id = playlist_items.widget_id)
            )
          LIMIT 1
        )
        WHERE zone_id IS NULL
          AND EXISTS (
            SELECT 1 FROM assignments a
            JOIN devices d ON d.id = a.device_id
            WHERE d.playlist_id = playlist_items.playlist_id
              AND a.zone_id IS NOT NULL
              AND (
                (a.content_id IS NOT NULL AND a.content_id = playlist_items.content_id)
                OR
                (a.widget_id IS NOT NULL AND a.widget_id = playlist_items.widget_id)
              )
          )
      `).run().changes;

      // Republish: regenerate published_snapshot for every published playlist
      // so the snapshot JSON carries zone_id. Mirrors buildSnapshotItems in
      // routes/playlists.js - kept inline here to avoid pulling routes/* in
      // at migration time (circular require).
      const publishedPlaylists = db.prepare("SELECT id FROM playlists WHERE status = 'published'").all();
      const buildSnapshot = db.prepare(`
        SELECT pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
               COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
               c.duration_sec as content_duration, c.remote_url,
               w.name as widget_name, w.widget_type, w.config as widget_config
        FROM playlist_items pi
        LEFT JOIN content c ON pi.content_id = c.id
        LEFT JOIN widgets w ON pi.widget_id = w.id
        WHERE pi.playlist_id = ?
        ORDER BY pi.sort_order ASC
      `);
      const updateSnap = db.prepare("UPDATE playlists SET published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?");
      let republished = 0;
      for (const pl of publishedPlaylists) {
        const items = buildSnapshot.all(pl.id);
        updateSnap.run(JSON.stringify(items), pl.id);
        republished++;
      }

      db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PHASE2_ZONE_ID_BACKFILL_ID);
      return { backfilled, republished };
    });
    const { backfilled, republished } = tx();
    console.log(`[zone-id backfill] ${backfilled} playlist_items recovered zone_id, ${republished} published_snapshots regenerated`);
  } catch (e) {
    console.error(`[zone-id backfill] Migration FAILED: ${e.message}`);
    console.error(`[zone-id backfill] Restore with: cp ${snapshotPath} ${config.dbPath}`);
    process.exit(1);
  }
}

backfillPlaylistItemsZoneId();

// Tenant delete-cascade (issue #18 follow-up). Core logic + table list live in
// lib/tenant-cascade-migration.js (so they're unit-testable against an in-memory
// DB). Here we own the boot concerns: a pre-migration snapshot for rollback and
// process.exit on failure, matching the other heavy migrations above.
const { applyTenantDeleteCascade } = require('../lib/tenant-cascade-migration');
(function migrateTenantDeleteCascadeAtBoot() {
  // Cheap guard so we don't snapshot on every boot once applied.
  try {
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'phase2_3_tenant_delete_cascade'").get()) return;
  } catch { /* schema_migrations may not exist yet */ }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotPath = path.join(dbDir, `remote_display.pre-tenant-cascade-${ts}.db`);
  let snapped = false;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(config.dbPath, snapshotPath);
    snapped = true;
  } catch (e) {
    console.error(`[tenant-cascade] Snapshot failed: ${e.message}`);
    process.exit(1);
  }

  try {
    const result = applyTenantDeleteCascade(db);
    if (result.status === 'applied') {
      console.warn(`[tenant-cascade] workspace/org deletion now cascades (${result.tables.length} tables rebuilt). Snapshot: ${snapshotPath}`);
    } else if (snapped) {
      // Nothing to do (already applied / no tenancy tables) - drop the snapshot.
      try { fs.unlinkSync(snapshotPath); } catch { /* ignore */ }
    }
  } catch (e) {
    console.error(`[tenant-cascade] Migration FAILED: ${e.message}`);
    console.error(`[tenant-cascade] Restore with: cp ${snapshotPath} ${config.dbPath}`);
    process.exit(1);
  }
})();

// Prune old telemetry (keep last 24h worth at 15s intervals = ~5760, cap at 6000)
function pruneTelemetry(deviceId) {
  db.prepare(`
    DELETE FROM device_telemetry
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM device_telemetry
      WHERE device_id = ?
      ORDER BY reported_at DESC LIMIT 6000
    )
  `).run(deviceId, deviceId);
}

// Prune old screenshots (keep only latest per device)
function pruneScreenshots(deviceId) {
  const old = db.prepare(`
    SELECT filepath FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1
    )
  `).all(deviceId, deviceId);

  for (const row of old) {
    const fullPath = path.join(config.screenshotsDir, row.filepath);
    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  }

  db.prepare(`
    DELETE FROM screenshots
    WHERE device_id = ? AND id NOT IN (
      SELECT id FROM screenshots WHERE device_id = ? ORDER BY captured_at DESC LIMIT 1
    )
  `).run(deviceId, deviceId);
}

// De-duplicate built-in template zones. A prior layout-editor save regenerated
// every zone id on save; schema.sql's INSERT OR IGNORE then re-seeded the
// canonical zone on the next boot, so template layouts accumulated positional
// duplicates (e.g. a 2-zone split template grew to 4+). For each position in a
// template, keep ONE zone, preferring the canonical seeded id (the built-in
// template zones use 'z-...' ids; bug copies are uuids) so schema.sql's re-seed
// stays an idempotent no-op; tiebreak by earliest rowid. One-time; the atomic
// id-preserving save prevents recurrence.
try {
  const DEDUPE_ID = 'dedupe_template_zones_v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(DEDUPE_ID)) {
    const removed = db.prepare(`
      DELETE FROM layout_zones WHERE id IN (
        SELECT z.id FROM layout_zones z
        JOIN layouts l ON l.id = z.layout_id
        WHERE l.is_template = 1 AND EXISTS (
          SELECT 1 FROM layout_zones z2
          WHERE z2.layout_id = z.layout_id AND z2.id != z.id
            AND z2.x_percent = z.x_percent AND z2.y_percent = z.y_percent
            AND z2.width_percent = z.width_percent AND z2.height_percent = z.height_percent
            AND (
              -- z2 is canonical and z is not -> keep z2, drop z
              (z2.id LIKE 'z-%' AND z.id NOT LIKE 'z-%')
              -- same canonical-ness -> keep the earliest, drop the rest
              OR ((CASE WHEN z2.id LIKE 'z-%' THEN 1 ELSE 0 END) = (CASE WHEN z.id LIKE 'z-%' THEN 1 ELSE 0 END) AND z2.rowid < z.rowid)
            )
        )
      )
    `).run().changes;
    if (removed > 0) console.log(`[migrate] removed ${removed} duplicate template zone(s)`);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(DEDUPE_ID);
  }
} catch (e) { console.error('[migrate] template-zone dedupe failed:', e.message); }

// #37: fail fast (loud) if migrations left the DB missing schema the code needs.
const { verifyAndRepairSchema } = require('../lib/schema-check');
verifyAndRepairSchema(db);

module.exports = { db, pruneTelemetry, pruneScreenshots };
