const { Database } = require('./sqlite-driver');
const fs = require('fs');
const path = require('path');
// NOT fs.copyFileSync: the data directory is exFAT on a player and copyFileSync's fchmod is
// refused there, which killed the snapshot below and with it the server. See lib/fsutil.js.
const { copyFileBytes } = require('../lib/fsutil');
const config = require('../config');
const { chunkedDelete, yieldTick, currentBand } = require('../lib/chunked-prune'); // #146 non-blocking sweeps

const dbDir = path.dirname(config.dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.dbPath);

// Wait through a brief writer lock instead of failing the statement outright. better-sqlite3
// defaults this to 5000ms, which is why the native path never saw "database is locked"; the
// node:sqlite fallback opens with no busy timeout (default 0), so a write contended by the WAL
// checkpointer worker or a concurrent boot-migration step failed immediately. Match better-sqlite3.
db.pragma('busy_timeout = 5000');

// Enable WAL mode and foreign keys
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Run schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

/*
 * ⚠️ The resolver views are DROPPED before any migration runs and recreated as the LAST step
 * (applyResolverViews, below). SQLite refuses to drop or rename a table a view references, and the
 * views now name eight tables — so a table-rebuilding migration (the tenant-cascade rebuild of
 * playlists today, any rebuild tomorrow) must never run with them present. The SQL they had is
 * kept so the per-boot verifier can prove the new definition changes no screen.
 */
const _previousResolverSql = require('../lib/playlist-resolver-sql').dropResolverViews(db);

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
    copyFileBytes(config.dbPath, snapshotPath);
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
  // v4 core pass — client identity capture (capture-don't-act; degrades to legacy/unknown for old
  // pre-v4 clients that send no identity block). No logic is built on these yet.
  'ALTER TABLE devices ADD COLUMN client_type TEXT',
  'ALTER TABLE devices ADD COLUMN client_version TEXT',
  // Content revision. SQLite cannot ADD COLUMN with a non-constant default, so this lands as 0 and
  // is backfilled from created_at below — a row that has never been replaced is at its birth
  // revision, which is exactly right.
  'ALTER TABLE content ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
  'UPDATE content SET updated_at = created_at WHERE updated_at = 0',
  'ALTER TABLE devices ADD COLUMN platform TEXT',
  'ALTER TABLE devices ADD COLUMN contract_version TEXT',
  // Exit-signal contract v1 — manner-of-death annotation on Offline (additive; NEVER alters offline
  // detection). offline_reason: 'crashed'|'clean_exit' (client-sent via device:exit / beacon) or
  // 'silent' (server-inferred when no signal arrived). Cleared on (re)online so it's always this
  // session's. offline_detail: optional crash message / lifecycle-hook name.
  'ALTER TABLE devices ADD COLUMN offline_reason TEXT',
  'ALTER TABLE devices ADD COLUMN offline_reason_at INTEGER',
  'ALTER TABLE devices ADD COLUMN offline_detail TEXT',
  // Embedded (HTTP-polling) displays tell us when they will next call: every render answer carries
  // X-ST-Expires-In, and the MCU deep-sleeps for exactly that long. This is "now + that", in epoch
  // seconds, so the heartbeat sweep does not call a screen offline while it is asleep on our own
  // instruction (overnight under a power schedule that is 8+ hours). NULL for socket players.
  'ALTER TABLE devices ADD COLUMN heartbeat_expected_by INTEGER',
  // Offline-cause log: annotate each historical offline transition with WHY. `reason` = category
  // (transport_close / ping_timeout / heartbeat_timeout / network / crashed / clean_exit / silent);
  // `detail` = human specifics (e.g. "Wi-Fi link lost — SSID Office, -78dBm" or "LAN up, server
  // unreachable (router/upstream)"). NULL on online rows / pre-migration.
  'ALTER TABLE device_status_log ADD COLUMN reason TEXT',
  'ALTER TABLE device_status_log ADD COLUMN detail TEXT',
  // Unified device-incident log (offline-cause + display/sleep + crash + reboot). Complements
  // device_status_log (which drives the uptime timeline): this is the human-facing "what happened
  // and why" feed. type: offline|online|display_off|display_on|crash|reboot|network. reason =
  // category token; detail = human specifics (Wi-Fi/router/SSID/RSSI/IP, crash msg, sleep source).
  `CREATE TABLE IF NOT EXISTS device_events (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id  TEXT NOT NULL,
     type       TEXT NOT NULL,
     reason     TEXT,
     detail     TEXT,
     timestamp  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
   )`,
  'CREATE INDEX IF NOT EXISTS idx_device_events_device_time ON device_events(device_id, timestamp)',
  // Email settings on users
  "ALTER TABLE users ADD COLUMN email_alerts INTEGER DEFAULT 1",
  // Content folders
  'ALTER TABLE content ADD COLUMN folder TEXT',
  // Device orientation and default content
  "ALTER TABLE devices ADD COLUMN orientation TEXT DEFAULT 'landscape'",
  // #325: the letterbox behind content that does not fill the screen. It was hardcoded black in the
  // player's stylesheet, which looks like a fault rather than a choice behind a white-background
  // image. NULL means "use the player default", so existing screens are untouched.
  "ALTER TABLE devices ADD COLUMN background_color TEXT",
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
  /*
   * Group precedence, for a device that belongs to MORE THAN ONE group.
   *
   * ⚠️ Today that case has no defined winner: `devices.playlist_id` is written eagerly by twelve
   * call sites across seven files, so whichever touched the row last decides, and the leave-handler
   * picks "any remaining group with a playlist" — whatever SQLite returns first. This column is the
   * first half of replacing that with one resolver and a stated rule, mirroring `schedules.priority`
   * so the two inheritance systems cannot drift: highest priority wins, ties break on the oldest
   * group (priority DESC, created_at ASC).
   *
   * ⚠️ INERT UNTIL THE RESOLVER LANDS. Nothing reads it yet, and adding it changes no behaviour —
   * that is deliberate, so the schema change can ship and be backfilled ahead of the logic rather
   * than alongside it. See docs/playlist-inheritance-design.md.
   *
   * Join-order would have been equally deterministic; priority is chosen for EXPLAINABILITY. "It
   * joined that group first, eighteen months ago" is invisible in the UI and unactionable; a number
   * an operator sets and can see is neither.
   */
  "ALTER TABLE device_groups ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
  // Group synchronized playback: when sync_enabled, members on the group's playlist play it
  // in lockstep (leader broadcasts index+position; followers align). Reuses the video-wall
  // sync primitive, minus the spatial transform. leader_device_id is an optional pin; if unset
  // or offline the server auto-elects the first online member on the matching playlist.
  "ALTER TABLE device_groups ADD COLUMN sync_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE device_groups ADD COLUMN leader_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL",
  // Which synchronisation protocol the group runs: 'auto' | 'screentinker' | 'brightsign'.
  // BrightSign's native SyncManager is frame-accurate but exists only between BrightSign players
  // on one L2 network, so it cannot be the default — 'auto' picks it only when the group can
  // actually run it. See server/lib/sync-backend.js; the resolver is the single source of that
  // decision and this column is only the operator's request.
  "ALTER TABLE device_groups ADD COLUMN sync_backend TEXT NOT NULL DEFAULT 'auto'",
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
  // Wall layouts: zones laid on the wall's player rect (percent of it, like any layout), so one
  // zone can sit inside one panel, span several, or cover the whole wall. NULL = the wall plays its
  // playlist across the whole player rect, exactly as before.
  "ALTER TABLE video_walls ADD COLUMN layout_id TEXT REFERENCES layouts(id) ON DELETE SET NULL",
  // Phase 2.2c: content_folders gets workspace_id. Phase 1 missed this table.
  "ALTER TABLE content_folders ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)",
  "CREATE INDEX IF NOT EXISTS idx_content_folders_workspace ON content_folders(workspace_id)",
  // Phase 2 zone_id regression fix: playlist_items needs zone_id so the
  // multi-zone-layout assignment feature works. The Phase 2 assignments->
  // playlist_items conversion (migrateAssignmentsToPlaylists) dropped this
  // column. Column ADD is idempotent via the surrounding try/catch loop.
  "ALTER TABLE playlist_items ADD COLUMN zone_id TEXT REFERENCES layout_zones(id) ON DELETE SET NULL",
  /*
   * Playlists of playlists, phase 1 (stateless). A playlist item may reference a CHILD PLAYLIST
   * instead of content or a widget; buildSnapshotItems() expands it in place at publish, so the
   * published snapshot stays a FLAT ordered array and no player learns what nesting is.
   *
   * ⚠️ ON DELETE RESTRICT, not SET NULL and not CASCADE. SET NULL would leave an item row that
   * references nothing and expands to nothing — and three empty nested playlists in a row are a
   * documented black screen on BrightSign XD and Samsung Tizen. CASCADE would delete the PARENT's
   * item as a side effect of deleting a child. Refusing the delete is the only option that cannot
   * surprise someone, and it is what makes a reverse-dependency view a requirement rather than a
   * nicety.
   *
   * ⚠️ The reference is kept on the ITEM even though the snapshot is flattened. Phase 2 (cursored
   * nesting: "play N of the child per parent rotation") needs somewhere to hang a cursor; if phase
   * 1 stored only the expansion there would be nothing to attach it to.
   *
   * See docs/playlist-nesting-design.md.
   */
  "ALTER TABLE playlist_items ADD COLUMN child_playlist_id TEXT REFERENCES playlists(id) ON DELETE RESTRICT",
  "CREATE INDEX IF NOT EXISTS idx_playlist_items_child ON playlist_items(child_playlist_id)",
  /*
   * ⚠️ The PRE-EXPANSION item list, kept beside published_snapshot.
   *
   * published_snapshot is device-facing and therefore FLAT — nesting is expanded out of it on
   * purpose, so no player has to understand it. That makes it lossy about STRUCTURE, and "discard
   * draft changes" rebuilds a playlist from it: discarding on a playlist containing a child
   * silently replaced the reference with a snapshot-time COPY of the child's items. The nesting was
   * gone, and it looked like a successful undo.
   *
   * So structure is stored separately. Discard restores from this; devices never see it.
   */
  "ALTER TABLE playlists ADD COLUMN published_structure TEXT",
  // #129: per-item mute. The legacy `assignments` table had a muted column, but the
  // active device payload is built from playlist_items -> published_snapshot, which never
  // carried it, so the dashboard mute toggle was a no-op end to end.
  "ALTER TABLE playlist_items ADD COLUMN muted INTEGER NOT NULL DEFAULT 0",
  // Per-item play window: local YYYY-MM-DDTHH:MM, inclusive, evaluated on the sign.
  // Null = no bound on that side. Not a daypart (that's playlist_item_schedules).
  "ALTER TABLE playlist_items ADD COLUMN play_from TEXT",
  "ALTER TABLE playlist_items ADD COLUMN play_until TEXT",
  "ALTER TABLE playlist_items ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE playlist_items ADD COLUMN log_play INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE playlist_items ADD COLUMN fit_mode TEXT",
  "ALTER TABLE playlist_items ADD COLUMN play_when TEXT",
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
  // #158: agency uploads land in this bound folder (and its subtree). NULL = root (pre-#158
  // tokens, or admin unbound). ON DELETE SET NULL so deleting the folder falls back to root.
  "ALTER TABLE api_tokens ADD COLUMN upload_folder_id TEXT REFERENCES content_folders(id) ON DELETE SET NULL",
  // #73: agency-upload notification queue (batched digest).
  "CREATE TABLE IF NOT EXISTS agency_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, token_id TEXT NOT NULL, playlist_id TEXT NOT NULL, action TEXT NOT NULL, content_id TEXT, created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), sent_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_agency_notifications_unsent ON agency_notifications(sent_at)",
  // #73: zone-binding was reverted (placement belongs to the device, not the playlist - see
  // the agency-tokens history). Drop the table on DBs where the short-lived migration ran.
  "DROP TABLE IF EXISTS api_token_target_zones",
  // #106: cosmetic per-workspace display ordering for the Displays view (drag-to-
  // reorder). Default 0 -> existing devices fall back to the created_at tiebreak.
  "ALTER TABLE devices ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
  // #134: distinguish the HDMI/panel OUTPUT resolution (screen_width/height, from
  // Display.Mode) from the UI RENDER SURFACE (render_width/height, from getRealMetrics).
  // TV boxes/sticks often render the UI at 1280x720 and scale it up to a 1080p/4K HDMI
  // signal, so the two differ — surfacing both explains "reports 720 but monitor sees 1080".
  "ALTER TABLE devices ADD COLUMN render_width INTEGER",
  "ALTER TABLE devices ADD COLUMN render_height INTEGER",
  // #139 Phase 2: device-reported OTA backoff status, so the dashboard can flag screens that
  // can't self-install (Fire TV: no device-owner path) and need a hands-on update. ADD COLUMN
  // with defaults is non-destructive in SQLite, and the apply loop below swallows "duplicate
  // column" — so this is idempotent and upgrades an existing populated db without data loss.
  // ota_updated_at = server receipt time (s), stamped on each register persist.
  "ALTER TABLE devices ADD COLUMN ota_status TEXT DEFAULT 'none'",
  "ALTER TABLE devices ADD COLUMN ota_target_version TEXT",
  "ALTER TABLE devices ADD COLUMN ota_attempts INTEGER DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN ota_updated_at INTEGER",
  // #142: index device_status_log for the per-device + time-window access pattern.
  // schema.sql creates this on fresh installs; this migration covers existing DBs.
  // Both the dashboard uptime query and the retention prune were full scans — the
  // dashboard-degradation cause once the table reached 1M+ rows.
  "CREATE INDEX IF NOT EXISTS idx_device_status_log_device_ts ON device_status_log(device_id, timestamp)",
  // #142: event-loop lag telemetry table (bounded: indexed + scheduled prune).
  // schema.sql creates these on fresh installs; this covers existing DBs.
  "CREATE TABLE IF NOT EXISTS event_loop_lag (id INTEGER PRIMARY KEY AUTOINCREMENT, sampled_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), mean_ms REAL NOT NULL, p50_ms REAL NOT NULL, p99_ms REAL NOT NULL, max_ms REAL NOT NULL, band TEXT NOT NULL DEFAULT 'normal')",
  "CREATE INDEX IF NOT EXISTS idx_event_loop_lag_sampled ON event_loop_lag(sampled_at)",
  // #146: index the provisioning-cleanup predicate so the chunked prune's batch
  // subquery is an index range, not a full devices scan under a provisioning flood.
  "CREATE INDEX IF NOT EXISTS idx_devices_provisioning ON devices(status, created_at)",
  // #146: minimal global key/value settings for admin-toggleable runtime flags (none
  // existed — ai_settings is per-workspace, white_labels is branding).
  "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))",
  // #146 BILLING: durable daily usage rollup (contractual system-of-record). One tiny row
  // per device per calendar day; accumulated incrementally off the heartbeat tick (NOT
  // reconstructed from status_log, which is 3-day retention). Retained ~400 days, pruned
  // chunked. day is UTC 'YYYY-MM-DD'; the index serves month-range queries.
  "CREATE TABLE IF NOT EXISTS device_usage_daily (device_id TEXT NOT NULL, day TEXT NOT NULL, online_seconds INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (device_id, day))",
  "CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON device_usage_daily(day)",
  // #143: operator device kill switch. blocked=1 refuses the device at the first
  // register gate on its next reconnect (no restart). Hand-settable by direct SQLite:
  //   UPDATE devices SET blocked = 1 WHERE id = '<device_id>';  (0 to unblock)
  "ALTER TABLE devices ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0",
  // settings_pin: 6-digit PIN for the in-app hidden settings menu, provisioned by
  // the server during pairing so each device gets a unique PIN (never a hardcoded default).
  "ALTER TABLE devices ADD COLUMN settings_pin TEXT",
  // #155/#161: per-device self-update (OTA) switch. 0 => the server never offers this
  // device an update (an MDM/operator owns its updates). Default 1 (self-update on).
  //   UPDATE devices SET ota_enabled = 0 WHERE id = '<device_id>';  (1 to re-enable)
  "ALTER TABLE devices ADD COLUMN ota_enabled INTEGER NOT NULL DEFAULT 1",
  // Opt a single display into pre-release builds. Without this, handing someone a test build is a
  // trap: a prerelease sorts BELOW its own release (1.9.25-fix234d < 1.9.25), so the next OTA check
  // correctly "upgrades" the device straight back off the build you asked them to test — silently,
  // within minutes. It cost a reporter on #234 an evening of testing code that had already been
  // replaced under them. Set this and the display keeps a same-core prerelease.
  "ALTER TABLE devices ADD COLUMN ota_beta INTEGER NOT NULL DEFAULT 0",
  // The channel we last SERVED this display. Needed to tell "an operator just switched this
  // display off beta" apart from "this display has always run a build of its own" — only the
  // first may be pulled back to stable. Without it, publishing a beta would drag every existing
  // pre-release tester backwards, which is the harm the opt-in exists to prevent.
  "ALTER TABLE devices ADD COLUMN ota_channel_served TEXT",
  // (The orphaned-schedule workspace repair and organizations.widget_sandbox_isolation_disabled
  // used to be here; both need the multi-tenancy tables, so they run after it — see below.)
  // #161: privilege tier reported by the player (0 unprivileged / 1 device-admin / 2 owner-or-
  // delegated-install) + whether a foreign device owner (MDM) manages it. Drives dashboard gating
  // of Tier-2 controls (reboot/kiosk/time) — shown only for owned panels.
  "ALTER TABLE devices ADD COLUMN tier INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN foreign_device_owner INTEGER NOT NULL DEFAULT 0",
  // #12 scheduled reboot: a device-local "HH:MM" wall-clock time (null = off). The
  // scheduler fires a reboot command once per device-local day when the clock crosses
  // this time. reboot_last_date (device-local YYYY-MM-DD) is the once-per-day guard so a
  // 60s tick landing anywhere in the catch window fires exactly once. Group-level default
  // lives on device_groups.reboot_schedule; a device's own value overrides the group's.
  "ALTER TABLE devices ADD COLUMN reboot_schedule TEXT",
  "ALTER TABLE devices ADD COLUMN reboot_last_date TEXT",
  "ALTER TABLE device_groups ADD COLUMN reboot_schedule TEXT",
  // #157 auto-deactivate expired content. expires_at = epoch-seconds after which the item
  // stops serving (null = never expires, current behaviour). is_active is the stored flag
  // the expiry sweep flips to 0 once expires_at passes — it's ALSO the sweep's once-only
  // marker (already-processed) so a republish fires exactly once per expiry, not every tick.
  // A manual archive later can reuse is_active. Publish-time filtering checks the LIVE
  // condition (is_active=0 OR expires_at<=now), so a publish between expiry and the next
  // sweep tick still drops the item.
  "ALTER TABLE content ADD COLUMN expires_at INTEGER",
  "ALTER TABLE content ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1",
  // #160 Track-A capability flags reported by the panel (no device-owner dependency). Drive the
  // dashboard's system-control gating + "what to grant" guidance. Older APKs omit them -> 0.
  "ALTER TABLE devices ADD COLUMN can_write_settings INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN accessibility_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE devices ADD COLUMN overlay_granted INTEGER NOT NULL DEFAULT 0",
  // #160: last-reported media volume / brightness / screen-off timeout so the dashboard sliders
  // reflect reality ("remember" what they're set to). All nullable (older APKs omit them).
  "ALTER TABLE devices ADD COLUMN media_volume REAL",
  "ALTER TABLE devices ADD COLUMN system_brightness REAL",
  "ALTER TABLE devices ADD COLUMN window_brightness REAL",
  "ALTER TABLE devices ADD COLUMN screen_off_timeout_ms INTEGER",
  // The hardware-derived half of a client's fingerprint, kept separately from the identity it
  // now presents. Two identical panels produce the same hardware value, so it identifies a
  // MODEL, not a unit, and can only ever be a hint for reuniting a wiped panel with its row —
  // never the thing a match is decided on. Nullable: clients that predate this send no such
  // field, and the lookup falls back to exact-match-only for them.
  "ALTER TABLE device_fingerprints ADD COLUMN hw_fingerprint TEXT",
  "CREATE INDEX IF NOT EXISTS idx_device_fingerprints_hw ON device_fingerprints(hw_fingerprint)",
  // Offline alerting is once per OUTAGE, not once per dedup window. This stores the
  // last_heartbeat value an offline alert was already sent for. Because a device that
  // reconnects advances last_heartbeat, the marker self-invalidates on recovery — a new
  // outage gets a new alert with no cleanup job and no state to reset. Being on the row
  // (not in memory) is the point: a restart used to re-alert every offline device.
  // NOTE: deliberately no backfill UPDATE in this array — statements here re-run on every
  // boot, so an `IS NULL` backfill would silently swallow the first alert of any outage
  // that began since the last restart. The one-time backfill is below, in schema_migrations.
  "ALTER TABLE devices ADD COLUMN offline_alert_heartbeat INTEGER",
  // The device's OWN address on the local network, reported by the player. devices.ip_address is
  // the PUBLIC address the server sees the connection arrive from — both are useful and they are
  // not the same thing. A customer reading the public IP as "my screen's IP" prompted this.
  "ALTER TABLE device_telemetry ADD COLUMN local_ip TEXT",
  // ...and its IPv6 one, in its own column rather than sharing the above. The player's collector
  // filtered to Inet4Address, so a v6-only panel reported no address at all and the dashboard
  // showed a dash for a screen that had a perfectly reachable address. Separate columns because a
  // dual-stack panel genuinely has both and an operator may need either — collapsing them would
  // make the field mean "whichever we happened to enumerate first".
  "ALTER TABLE device_telemetry ADD COLUMN local_ip6 TEXT",
  // What is physically PLUGGED IN, read from the display's EDID, and the mode actually being
  // driven. A signage operator's first question about a dark screen is which panel it is and
  // whether the player is outputting at all — the dashboard could say neither, and
  // screen_width/height are what the PAGE thinks it has, not what the hardware negotiated.
  //
  // Per-telemetry-row rather than on `devices` because a display can be swapped, unplugged or
  // renegotiated without the player re-registering, and because a dual-output player registers ONE
  // ROW PER OUTPUT (see output_index) — each row must carry its own screen, not the box's first.
  /*
   * Per-organization SSO.
   *
   * Instance-wide providers come from the environment and belong to whoever runs the server. These
   * belong to a CUSTOMER: an organization brings its own identity provider, and its people sign in
   * with it without the operator touching a config file.
   *
   * `slug` is globally unique and randomly generated rather than chosen, because it is a URL path
   * segment (/api/auth/oidc/<slug>/start) and two organizations both wanting "okta" must not be
   * able to collide — or to guess each other's. The admin only ever sees `name`.
   *
   * `client_secret_enc` is AES-256-GCM via lib/secretbox, the same at-rest treatment as TOTP
   * secrets and BYOK AI keys. PKCE means a secret is optional, so a public client stores NULL.
   *
   * `email_domains` is the list an admin TYPED, kept for display and for the edit form. It does not
   * drive routing — org_sso_domains does, and only its verified rows (see the table below). The two
   * are not interchangeable: reading this column to decide who may sign in would let a tenant route
   * a domain it never proved.
   */
  `CREATE TABLE IF NOT EXISTS org_sso_providers (
    id                 TEXT PRIMARY KEY,
    organization_id    TEXT NOT NULL,
    slug               TEXT NOT NULL UNIQUE,
    name               TEXT NOT NULL,
    issuer             TEXT NOT NULL,
    client_id          TEXT NOT NULL,
    client_secret_enc  TEXT,
    scopes             TEXT NOT NULL DEFAULT 'openid email profile',
    email_domains      TEXT NOT NULL DEFAULT '',
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_org_sso_org ON org_sso_providers(organization_id)",
  /*
   * Claimed sign-in domains, and the proof that the claimant controls them.
   *
   * `org_sso_providers.email_domains` used to be the whole story, and first-claim-wins on a text
   * field is not a claim — it is a land grab. A tenant could type a domain it had nothing to do
   * with and every person at that company typing their work address into the login page would be
   * routed to the squatter's identity provider. It also let one account permanently deny a domain
   * to its real owner, and strand accounts at addresses it never owned.
   *
   * So a domain is inert until DNS says otherwise. `verified_at` NULL means claimed but unproven:
   * it routes nobody, and the login callback will not accept an assertion for it. The row still
   * reserves the name, so two tenants cannot race the same domain, but reserving is all it does.
   *
   * `token` is what has to appear in DNS. It is per-domain rather than per-organization so that
   * publishing one proof cannot be replayed to claim a second domain.
   */
  `CREATE TABLE IF NOT EXISTS org_sso_domains (
    id                 TEXT PRIMARY KEY,
    organization_id    TEXT NOT NULL,
    provider_id        TEXT,
    domain             TEXT NOT NULL UNIQUE,
    token              TEXT NOT NULL,
    -- When the current token was issued. An UNVERIFIED claim is only good for 8 hours from here:
    -- past that the token is dead and the reservation lapses, so a domain nobody can prove cannot
    -- be held indefinitely by whoever typed it first. Verified rows ignore this entirely.
    token_issued_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    verified_at        INTEGER,
    last_checked_at    INTEGER,
    last_error         TEXT,
    created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    -- A verified row never expires and domain is globally UNIQUE, so a row that outlives its
    -- provider blocks that domain for EVERYONE, forever, while being invisible in the API. The
    -- delete handler clears these explicitly; this is the backstop for every other route out
    -- (an organization cascade, a manual delete, a future caller that forgets).
    FOREIGN KEY (provider_id) REFERENCES org_sso_providers(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_org_sso_domains_org ON org_sso_domains(organization_id)",
  "CREATE INDEX IF NOT EXISTS idx_org_sso_domains_provider ON org_sso_domains(provider_id)",
  /*
   * SSO-ONLY: an organization may require its people to use its identity provider, so a password
   * is no longer an alternative way in. That is the point of buying SSO — the IdP holds the MFA,
   * the conditional access and the instant deprovisioning, and a password box beside it is a way
   * around all three.
   *
   * ⚠️ Asymmetric on purpose. Turning it ON is the safe direction and an org admin does it alone.
   * Turning it OFF is how a compromised admin would re-open password login, and it is also what
   * an org will demand at its worst moment — IdP down, nobody can work — which is exactly when a
   * self-service switch gets flipped under pressure. So removal goes through the operator: the
   * request is recorded here and a platform admin has to approve it.
   */
  `CREATE TABLE IF NOT EXISTS org_sso_only_requests (
    id                 TEXT PRIMARY KEY,
    organization_id    TEXT NOT NULL,
    requested_by       TEXT,
    reason             TEXT,
    status             TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
    decided_by         TEXT,
    decided_at         INTEGER,
    decision_note      TEXT,
    created_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sso_only_req_status ON org_sso_only_requests(status, organization_id)",
  "ALTER TABLE device_telemetry ADD COLUMN attached_display TEXT",
  "ALTER TABLE device_telemetry ADD COLUMN video_mode TEXT",
  // Panel temperature in Celsius. REAL because the sensor reports fractions, and nullable because
  // only some hardware exposes one — Android and the browser players send nothing and must keep
  // reading as "no sensor" rather than "0 degrees", which is why every read site treats null as
  // absent instead of coercing.
  "ALTER TABLE device_telemetry ADD COLUMN temperature_c REAL",
  // Hardware identity as the PANEL reports it, distinct from anything the server infers. A
  // BrightSign knows its model (XT245 vs XC4055 — different capabilities, notably output count),
  // its OS build, and its serial, and none of that had anywhere to live: the devices row carried
  // only `platform`. Deliberately generic names rather than bs_* — an Android panel has a model
  // and a serial too, and naming the columns after one vendor would mean a second set later.
  "ALTER TABLE devices ADD COLUMN hardware_model TEXT",
  "ALTER TABLE devices ADD COLUMN hardware_serial TEXT",
  // The OS build, in its OWN column rather than reusing android_version. That column is load
  // bearing as a TYPE discriminator, not just a value: the device view decides between the
  // Android layout and the browser layout with android_version.startsWith('Web/'), so writing
  // "BrightSign OS 9.0.189" there would render a BrightSign with battery and WiFi cards. It would
  // also be clobbered on the next lightweight device_info refresh, which rewrites that column.
  "ALTER TABLE devices ADD COLUMN hardware_os_version TEXT",
  // Which physical output this row paints. A dual-output player runs one player per connector and
  // registers as two devices; without this they are indistinguishable in the dashboard.
  "ALTER TABLE devices ADD COLUMN output_index INTEGER",
  // The attached panel's RAW EDID, base64. Stored raw and parsed on read (lib/edid.js) rather than
  // exploded into columns: the blob is ~128-256 bytes, and every future field — gamma, the DTD mode
  // list, the CEA blocks — then costs a server deploy instead of a migration AND a fleet update.
  // That matters here more than usual: the bridge that collects it sits behind a CDN, and the host
  // script only changes via an OTA package.
  "ALTER TABLE devices ADD COLUMN hardware_edid TEXT",
  // What the player says it can do, as a JSON array (see lib/player-capabilities.js). NULL means
  // the panel has never declared — the overwhelming majority of the fleet on the day this ships —
  // and resolves to a per-platform baseline. That NULL is load bearing: an empty array is a player
  // genuinely reporting it can do nothing, and collapsing the two would either strip the UI from
  // every existing display or ignore a player that told us the truth.
  "ALTER TABLE devices ADD COLUMN capabilities TEXT",
  // Backfill a unique 6-digit PIN for already-paired devices that predate the
  // settings_pin column (their next reconnect re-sends device:paired with it, so
  // the existing fleet isn't locked out of the on-device menu). Idempotent: the
  // IS NULL guard means it only ever touches un-provisioned rows. Unpaired rows
  // (user_id IS NULL) are skipped — they get a PIN when they pair.
  "UPDATE devices SET settings_pin = CAST(abs(random()) % 900000 + 100000 AS TEXT) WHERE settings_pin IS NULL AND user_id IS NOT NULL",
  // #150: fingerprint-keyed device settings that SURVIVE device-row deletion, so a
  // delete + re-pair (MDM churn) restores orientation/name/playlist/etc for the SAME
  // physical device instead of silently resetting to defaults. NO FK to devices -> it
  // survives the delete cascade. workspace_id/device_name/last_seen/removed_at form the
  // human-readable index the operator "re-adopt" flow browses when the fingerprint changed.
  `CREATE TABLE IF NOT EXISTS device_settings (
    fingerprint         TEXT PRIMARY KEY,
    workspace_id        TEXT,
    device_name         TEXT,
    orientation         TEXT,
    timezone            TEXT,
    notes               TEXT,
    default_content_id  TEXT,
    layout_id           TEXT,
    playlist_id         TEXT,
    blocked             INTEGER,
    team_id             TEXT,
    last_seen           INTEGER,
    removed_at          INTEGER
  )`,
  // #widget zero-duration loop: repair any playlist_items with a non-positive duration
  // (esp. duration_sec=0 on a widget), which made the player schedule a 0ms auto-advance
  // -> self-loop + black screen. New writes are floored in routes/assignments.js; this
  // fixes existing rows. Idempotent — a no-op once clean.
  'UPDATE playlist_items SET duration_sec = 10 WHERE duration_sec IS NULL OR duration_sec < 1',
  // Email verification on signup. New local signups are INSERTed with an explicit value
  // (routes/auth.js). DEFAULT 0 means EXISTING local users predate verification and are asked
  // to confirm on their first login after this ships. email_verify_hash = SHA-256 of the emailed
  // token (single-use), email_verify_expires = unix ts. See lib/emailVerify.js.
  'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE users ADD COLUMN email_verify_hash TEXT',
  'ALTER TABLE users ADD COLUMN email_verify_expires INTEGER',
  // Grandfather two categories of existing rows to verified (idempotent, safe to re-run):
  //   - SSO accounts: their identity provider already verified the address.
  //   - platform admins: never risk locking an existing operator out of their own instance.
  // Every other existing local user stays 0 -> prompted on first login.
  "UPDATE users SET email_verified = 1 WHERE auth_provider != 'local'",
  "UPDATE users SET email_verified = 1 WHERE role = 'platform_admin'",
  // #217: per-item "unstable connection" flag. When set, the player caps the YouTube
  // embed at 720p (playerVars.vq='hd720') so weak/unstable WiFi on Android TV doesn't
  // buffer/stall on an auto-selected 1080p+ stream. DEFAULT 0 = no cap (today's behaviour).
  "ALTER TABLE content ADD COLUMN unstable_connection INTEGER NOT NULL DEFAULT 0",
  // #216: subtitle/caption support as a content property (applied automatically by the
  // player, no in-player controls). YouTube uses captions_enabled + captions_lang (via the
  // IFrame API); uploaded videos use subtitle_url (a .vtt filename in the content dir,
  // served at /uploads/content/<file>) + subtitle_lang for the <track> element. All default
  // off/NULL so existing content is unchanged.
  "ALTER TABLE content ADD COLUMN captions_enabled INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE content ADD COLUMN captions_lang TEXT",
  "ALTER TABLE content ADD COLUMN subtitle_url TEXT",
  "ALTER TABLE content ADD COLUMN subtitle_lang TEXT",
  // Self-service password reset. Mirrors the email-verification columns: the emailed token
  // is stored ONLY as a SHA-256 hash (single-use), with its own expiry, and one pending
  // token per user so a re-request simply overwrites the previous one. Nullable and
  // additive — existing rows are unaffected and a code-only rollback leaves dead columns.
  "ALTER TABLE users ADD COLUMN password_reset_hash TEXT",
  "ALTER TABLE users ADD COLUMN password_reset_expires INTEGER",
  // Trial expiry (nightly sweep + emails, services/trialExpiry.js). trial_expired_at is stamped
  // when a lapsed trial is flipped to Free — by the sweep or the lazy getUserPlan path — and is
  // what the player reads to say "Trial Expired" rather than "Device Limit Reached" (the
  // downgrade nulls trial_started, so that column cannot carry the message). The two *_sent_at
  // columns are the once-per-user idempotency stamps for the T-3 and expiry emails.
  "ALTER TABLE users ADD COLUMN trial_expired_at INTEGER",
  "ALTER TABLE users ADD COLUMN trial_ending_email_sent_at INTEGER",
  "ALTER TABLE users ADD COLUMN trial_expired_email_sent_at INTEGER",
  /*
   * Dunning: a PAID subscription whose payment failed. `past_due_since` is the grace clock —
   * stamped when Stripe reports the first failed invoice and cleared the moment a payment
   * succeeds, so it answers "how long have they been failing" rather than "are they failing",
   * which is what a 7-day grace needs. The two *_sent_at columns are the once-per-episode
   * idempotency stamps (cleared alongside the clock, so a customer who lapses, pays, and lapses
   * again months later is told again rather than silently).
   */
  "ALTER TABLE users ADD COLUMN past_due_since INTEGER",
  "ALTER TABLE users ADD COLUMN payment_failed_email_sent_at INTEGER",
  "ALTER TABLE users ADD COLUMN subscription_lapsed_email_sent_at INTEGER",
  // AUTH-05: make break-glass recovery revocable, single-use and auditable.
  //
  // scripts/reset-admin.js mints a JWT carrying `recovery: true`, which middleware/auth.js
  // accepts as a synthetic platform identity WITHOUT touching the database. That made it
  // impossible to revoke (short of rotating JWT_SECRET, which logs out every user), to
  // enumerate (nobody can answer "is a recovery token outstanding?"), or to audit — the
  // synthetic id is not a users row, so every activity_log insert for it fails the
  // user_id FK and is swallowed, leaving a break-glass session with NO trail at all.
  //
  // One row per minted token turns all three around: DELETE revokes, SELECT enumerates,
  // used_at makes it single-use. Additive and idempotent, so re-running is a no-op and a
  // code-only rollback simply leaves an unused table behind.
  `CREATE TABLE IF NOT EXISTS recovery_grants (
    jti         TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER,
    minted_by   TEXT,
    source_ip   TEXT,
    note        TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_recovery_grants_expires ON recovery_grants(expires_at)",
  // Portrait templates for existing installs. schema.sql only runs on a fresh database, so without
  // this an upgraded instance has landscape templates only — and portrait panels are exactly the
  // fleets that need a starting point. INSERT OR IGNORE, so re-running is free and an operator who
  // edited one of these keeps their version.
  `INSERT OR IGNORE INTO layouts (id, user_id, name, width, height, is_template, template_category) VALUES
     ('tpl-p-full',    NULL, 'Portrait Fullscreen',         1080, 1920, 1, 'basic'),
     ('tpl-p-halves',  NULL, 'Portrait Split',              1080, 1920, 1, 'split'),
     ('tpl-p-ticker',  NULL, 'Portrait with Ticker',        1080, 1920, 1, 'news'),
     ('tpl-p-banner',  NULL, 'Portrait Banner + Body',      1080, 1920, 1, 'news'),
     ('tpl-p-thirds',  NULL, 'Portrait Three Stacked',      1080, 1920, 1, 'grid'),
     ('tpl-p-pip',     NULL, 'Portrait Picture in Picture', 1080, 1920, 1, 'overlay')`,
  `INSERT OR IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
     ('z-pf-1', 'tpl-p-full',   'Main',          0, 0, 100, 100, 0, 0),
     ('z-ph-1', 'tpl-p-halves', 'Top',           0, 0, 100, 50, 0, 0),
     ('z-ph-2', 'tpl-p-halves', 'Bottom',        0, 50, 100, 50, 0, 1),
     ('z-pt-1', 'tpl-p-ticker', 'Main Content',  0, 0, 100, 88, 0, 0),
     ('z-pt-2', 'tpl-p-ticker', 'Bottom Ticker', 0, 88, 100, 12, 1, 1),
     ('z-pb-1', 'tpl-p-banner', 'Top Banner',    0, 0, 100, 15, 0, 0),
     ('z-pb-2', 'tpl-p-banner', 'Body',          0, 15, 100, 85, 0, 1),
     ('z-p3-1', 'tpl-p-thirds', 'Top',           0, 0, 100, 33.33, 0, 0),
     ('z-p3-2', 'tpl-p-thirds', 'Middle',        0, 33.33, 100, 33.34, 0, 1),
     ('z-p3-3', 'tpl-p-thirds', 'Bottom',        0, 66.67, 100, 33.33, 0, 2),
     ('z-pp-1', 'tpl-p-pip',    'Background',    0, 0, 100, 100, 0, 0),
     ('z-pp-2', 'tpl-p-pip',    'PiP Window',    58, 4, 38, 20, 1, 1)`,

  // What each player declares it can do (JSON array), so the dashboard can hide controls a
  // display cannot honour. NULL means "never declared" and falls back to a per-platform baseline
  // in server/lib/player-capabilities.js — distinct from '[]', which is a player genuinely saying
  // it can do nothing and must be respected.
  'ALTER TABLE devices ADD COLUMN capabilities TEXT',

  // Opt-in install statistics, COLLECTOR side only — inert unless TELEMETRY_COLLECTOR=1, which
  // is the hosted deployment. Keyed by instance_id and upserted rather than appended, so it is a
  // table of current state ("this install last reported N screens") rather than an event log that
  // grows without bound on a box nobody prunes. Answering "how many screens are deployed" needs
  // the latest row per install, never the history.
  `CREATE TABLE IF NOT EXISTS telemetry_reports (
     instance_id TEXT PRIMARY KEY,
     version TEXT,
     screen_count INTEGER NOT NULL DEFAULT 0,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   )`,


  /* ==========================================================================================
   * MESH — Phase 0 schema. Tables only; no behavior, no UI, no background work.
   *
   * ⚠️ THIS MIGRATION IS A NO-OP FOR EVERY EXISTING INSTALL. Creating empty tables changes nothing
   * an operator can observe: with MESH_ACCEPT_ENROLLMENT and MESH_ALLOW_UPLINK both off (the
   * defaults) nothing reads them. Note these are CREATE TABLE, which the loop below deliberately
   * does NOT count as an applied migration — only ADD COLUMN does — so a healthy boot stays silent
   * rather than announcing work it did not do.
   *
   * See docs/mesh-directive.md and docs/mesh-phase0-design.md.
   * ========================================================================================== */

  /* This node's own identity. Exactly one row, enforced by the CHECK rather than by convention.
   * ⚠️ Generated locally at first boot and never registered anywhere (I7). No path, no parent, no
   * role encoded in it (I4) — re-parenting must not invalidate history. */
  `CREATE TABLE IF NOT EXISTS mesh_node (
     singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
     node_id        TEXT    NOT NULL UNIQUE,
     created_at     INTEGER NOT NULL,
     -- #288: this box may also be one of its own screens. Recorded explicitly so rollups do not
     -- count the host as both a node and a device and report one screen too many, forever.
     self_device_id TEXT
   )`,

  /* Edges. ⚠️ A TABLE, NOT A parent_id COLUMN — a node has N edges.
   *
   * A parent pointer forecloses multi-parent, which two real cases need: an MSP hub observing a
   * client's server WHILE the client's own hub also observes it, and hub migration, which needs
   * both edges to exist at once for a while. Adding the second parent later would be a schema
   * change under live data; allowing it now costs one table.
   *
   * `direction` is my relationship to the peer (is it above or below me). `transport_direction` is
   * merely who dials — a reachability fact that must never imply anything about the grant. */
  `CREATE TABLE IF NOT EXISTS mesh_edges (
     id                   TEXT    PRIMARY KEY,
     peer_node_id         TEXT    NOT NULL,
     direction            TEXT    NOT NULL CHECK (direction IN ('up','down')),
     -- JSON array. A SET, never an enum: a new node type is a new combination, not a schema change.
     role_capabilities    TEXT    NOT NULL DEFAULT '[]',
     -- JSON array of data categories. ⚠️ '[]' means DENIED, and it is the default: a grant is an
     -- explicit list, so a category added in a later version can never widen an existing edge.
     grant_categories     TEXT    NOT NULL DEFAULT '[]',
     transport_direction  TEXT    NOT NULL CHECK (transport_direction IN ('we-dial','they-dial')),
     -- Per edge, not global: a parent may hold longer or shorter than the origin, and a client whose
     -- own retention is shorter must be able to bind the parent to it.
     retention_days       INTEGER,
     tombstone_purge_days INTEGER,
     -- On by default; opt-out is explicit and must be visible in the UI, not buried in config.
     tls_verify           INTEGER NOT NULL DEFAULT 1,
     peer_version         TEXT,
     peer_min_version     TEXT,
     -- ⚠️ The edge token is stored HASHED, like any session or API token. A parent VERIFIES a token
     -- and never needs to reproduce one, so keeping plaintext would only turn a leaked database or
     -- log line into standing access to a client's data.
     token_hash           TEXT,
     token_expires_at     INTEGER,
     -- Hub-side grouping. NULL on a child's upward edge; only a parent groups peers into clients.
     client_id            TEXT,
     created_at           INTEGER NOT NULL,
     last_sync_at         INTEGER,
     revoked_at           INTEGER,
     -- ⚠️ Duplicate-identity guard at the storage layer, so a cloned VM cannot quietly open a second
     -- edge and interleave two sites' histories into one unrecoverable row set.
     UNIQUE (peer_node_id, direction)
   )`,

  /* ⚠️ The peer's own base URL. hub-view.js#deepLink() has read `edge.peer_url` since Phase 3 and the
   * column did not exist — so every "Open on its server" link silently rendered as a dash, which is
   * precisely the affordance the directive names as what keeps a read-only hub useful. The tests
   * passed because their fixtures declared the column; only the real schema lacked it. On a `down`
   * edge it is where the child says it can be reached; on an `up` edge it is the address we dial. */
  'ALTER TABLE mesh_edges ADD COLUMN peer_url TEXT',

  /* ⚠️ The child's OWN edge token, in plaintext, and ONLY ever on an `up` edge. A parent stores a
   * hash because it only verifies; a child must actually PRESENT the token on every dial, so it has
   * no choice but to keep the secret. Kept in its own column rather than reusing token_hash so that
   * "this column is a hash" stays true everywhere else — a column that is sometimes a secret and
   * sometimes a digest is how one gets logged. */
  'ALTER TABLE mesh_edges ADD COLUMN up_token TEXT',

  /* ⚠️ What this server calls the peer on the other end of this edge — a NAME, not a UUID.
   * "another server" is what the UI said before, which is true of every row and therefore tells an
   * operator nothing; a node id tells them less. The peer declares a name when it pairs and this
   * side stores it, so the switcher can read "Acme HQ" where it used to read "another server". */
  'ALTER TABLE mesh_edges ADD COLUMN peer_name TEXT',
  /* What a CHILD has told this hub it may do to that child — see mirror-store.recordWriteOffer.
   * ⚠️ Advisory. The child enforces its own grant from its own row on every request; this exists so
   * the hub's UI can offer the right controls instead of making an operator guess. NULL means "no
   * offer, or an offer that grants nothing", and those are the same thing to a renderer. */
  'ALTER TABLE mesh_edges ADD COLUMN peer_write_offer TEXT',
  /* Whether this node's operator agreed that the parent on this edge may include what we report in
   * ITS OWN reports further up. Set on an UP edge by the child's operator; announced to the parent
   * so it knows, and mirrored onto the parent's DOWN edge as peer_shares_upward.
   * ⚠️ Defaults to 0 — absent means no. A relationship formed before relaying existed never agreed
   * to its data crossing a second hop, and inferring that consent is exactly what this design
   * refuses to do. */
  'ALTER TABLE mesh_edges ADD COLUMN share_upward INTEGER NOT NULL DEFAULT 0',
  /* Whether THIS node's operator wants content they receive to be passed on automatically to this
   * client, rather than sent by hand.
   * ⚠️ Set on a DOWN edge, by the operator who holds the relationship with that client — never by
   * whoever is above. A grandparent deciding what lands on a server that granted somebody else is
   * the thing the whole grant model exists to prevent. Defaults to 0. */
  'ALTER TABLE mesh_edges ADD COLUMN auto_forward INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE mesh_edges ADD COLUMN peer_shares_upward INTEGER NOT NULL DEFAULT 0',

  /* WHICH of this server's workspaces travel up this edge. JSON array of workspace ids, or NULL.
   *
   * ⚠️ NULL MEANS ALL, AND THAT IS ONLY CHOOSABLE BY THE INSTANCE OWNER. Anyone else must name the
   * workspaces they are sharing, and may only name ones they actually administer — otherwise a
   * member of one workspace could expose a colleague's by pairing a server they happen to have
   * login for, which is a privilege escalation dressed up as a convenience.
   *
   * ⚠️ Deliberately NOT the empty array as the default. `[]` and NULL would both read as falsy in
   * every naive check, one meaning "share nothing" and the other "share everything" — opposite
   * outcomes behind the same truthiness test is how a grant becomes accidentally total. */
  'ALTER TABLE mesh_edges ADD COLUMN shared_workspaces TEXT',

  /* ─── Mesh WRITE consent (Phase 5) ────────────────────────────────────────────────────────────
   *
   * ⚠️ THESE TWO COLUMNS ARE THE ONLY PLACE A WRITE PERMISSION MAY LIVE, AND THE WIRE MAY NEVER
   * WRITE THEM.
   *
   * `grant_categories` above is authored by the PARENT: it mints a pairing code naming what the
   * code will grant, and the child stores the parent's answer verbatim (routes/mesh-enroll.js).
   * That is defensible for reads — every read category is read-only by construction and the child
   * can see what it gave away. Applied to writes it inverts the entire model: the parent would be
   * writing its own permission into the child's database, and the child would dutifully enforce it.
   *
   * So write lives in its own columns, set ONLY by an authenticated operator on this node through
   * the child-side consent route. Enrollment strips write categories out of whatever the peer sent;
   * re-pairing does not touch these columns, so re-pairing cannot widen a write grant.
   *
   * ⚠️ NULL/absent means NO WRITE, and that is what every edge that already exists gets. An
   * installation that upgrades into this keeps behaving exactly as it did the day before: read
   * only, everywhere. Write is never acquired by migration — only by somebody on THIS node saying
   * yes, after reading what it means.
   *
   * write_grant  — JSON array of write categories (see lib/mesh/grants.js WRITE_CATEGORIES).
   * write_scope  — JSON array of workspace ids this edge may write to. ⚠️ Unlike
   *                shared_workspaces above, NULL here means NOTHING, never "all". A column that
   *                means "everything" when absent is exactly how a write grant becomes total by
   *                accident, and the two columns are deliberately opposite for that reason. */
  'ALTER TABLE mesh_edges ADD COLUMN write_grant TEXT',
  'ALTER TABLE mesh_edges ADD COLUMN write_scope TEXT',

  /* How much disk a hub may consume here, and how much of it it has used.
   *
   * ⚠️ SCOPE ANSWERS "WHOSE SCREENS", THIS ANSWERS "HOW MUCH OF MY DISK". They are different
   * questions and an operator only ever gets asked the first one, so the second has to be asked
   * explicitly or it is answered by default — and the default would be "all of it".
   *
   * The consent line for content-push says the hub may send content downward. Somebody granting
   * "you may write to my Lobby workspace" is agreeing about what appears on the Lobby screens; they
   * have not agreed to unbounded storage on a machine they pay for. On a self-hosted box that
   * matters more than it sounds: a full disk on a signage server is a cross-tenant outage, and
   * routes/media.js already refuses rather than fill one.
   *
   * ⚠️ NULL means NOTHING, exactly as write_scope does — never "unlimited". Required whenever
   * content-push is granted, refused when absent, so a byte permission cannot become total by
   * being left blank. The mesh already treats "how much may you send me" as first-class and
   * refusable in the other direction (lib/mesh/backpressure.js); this is the same question pointed
   * downward.
   *
   * Bytes, not megabytes — the UI converts. A unit that has to be remembered is a unit that gets
   * confused, and being wrong by 1000x here means a filled disk. */
  'ALTER TABLE mesh_edges ADD COLUMN write_bytes_budget INTEGER',
  'ALTER TABLE mesh_edges ADD COLUMN write_bytes_used INTEGER NOT NULL DEFAULT 0',

  /* ─── Content distribution (Phase 5) ──────────────────────────────────────────────────────────
   *
   * sha256 of the FILE'S BYTES. Nullable, and that is load-bearing: 88 of 100 content rows in a
   * typical dev library have no file on disk at all, remote/YouTube rows never will, and a row on a
   * host where the read failed must still be usable. NULL is the day-one value for every existing
   * row, so the fallback path is exercised from the first commit rather than being the rare,
   * untested one.
   *
   * ⚠️ A DIGEST IS DEDUPLICATION, NOT IDENTITY. It answers "do I already hold these exact bytes",
   * which is a transfer optimisation. It does not answer "is this the asset the hub means" — that
   * is mesh_content_provenance below. Conflating them would merge two customers' assets the first
   * time two sites happened to upload the same stock video.
   *
   * ⚠️ A new column is a duty at every writer (see docs/playlist-nesting-design.md, where 5 of 12
   * writers corrupted rows silently). The content writers are: lib/content-ingest.js (upload),
   * routes/content.js POST /remote and POST /youtube (no bytes, stays NULL), routes/content.js
   * PUT /:id/replace (NEW BYTES — must re-hash or the digest lies), routes/status.js import, and
   * the mesh committer. */
  'ALTER TABLE content ADD COLUMN byte_digest TEXT',
  'CREATE INDEX IF NOT EXISTS idx_content_digest ON content(byte_digest)',

  /* HTML bundles: which file inside the archive is the entry point.
   *
   * ⚠️ SERVER-DERIVED, NEVER CALLER-SUPPLIED. lib/html-bundle.js resolves it from the archive's own
   * central directory (a .wgt's config.xml <content src>, else index.html) and refuses the upload
   * when it cannot. A caller-settable entry point would be a path into an archive chosen by whoever
   * uploaded it, which is the shape of every zip-slip.
   *
   * ⚠️ AND EVERY WRITER OWES IT A VALUE, or the row says a bundle has no entry point and players
   * skip it: lib/content-ingest.js (upload), routes/content.js PUT /:id/replace (new bytes, must be
   * re-derived), and the mesh committer. That is the same duty byte_digest above records, and the
   * same one that was missed there. */
  'ALTER TABLE content ADD COLUMN bundle_entry TEXT',

  /* Which local row a peer's content id means.
   *
   * ⚠️ KEYED ON (origin_node_id, origin_content_id) — the mesh_mirror_workspaces shape, for the
   * reason stated there: two servers WILL eventually hand us the same id, they are generated
   * independently and nothing coordinates them, and a single-column key would silently merge two
   * customers' libraries into one row set.
   *
   * This is what makes a re-push idempotent. Without it the child mints a fresh content.id every
   * time, every playlist item is repointed, and — because content_id and filepath are both in the
   * player's structural fingerprint — every screen on the site restarts at item 1 on every push,
   * even when the bytes are identical. That is #234, estate-wide, nightly. */
  `CREATE TABLE IF NOT EXISTS mesh_content_provenance (
     origin_node_id    TEXT    NOT NULL,
     origin_content_id TEXT    NOT NULL,
     local_content_id  TEXT    NOT NULL,
     edge_id           TEXT,
     bytes             INTEGER NOT NULL DEFAULT 0,
     first_seen_at     INTEGER NOT NULL,
     -- Whether the node that SENT this content agreed it may be passed on to servers below.
     -- ⚠️ Defaults to 0: absent means no, as everywhere else in this design. Content received
     -- before relaying existed therefore stays put, which is the correct reading of a consent
     -- nobody was ever asked for. Set from the manifest rl field, by the owner, per push.
     relayable         INTEGER NOT NULL DEFAULT 0,
     last_seen_at      INTEGER NOT NULL,
     PRIMARY KEY (origin_node_id, origin_content_id)
   )`,
  /* ⚠️ AFTER the CREATE above, not with the mesh_edges alters. Placed there first, it ran before
   * the table existed, failed as a benign "no such table", and the column silently never arrived —
   * so every content commit threw "no column named relayable" on a fresh database. */
  'ALTER TABLE mesh_content_provenance ADD COLUMN relayable INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_mesh_prov_local ON mesh_content_provenance(local_content_id)',
  'CREATE INDEX IF NOT EXISTS idx_mesh_prov_edge ON mesh_content_provenance(edge_id)',

  /* Short-lived, single-asset pull tickets minted by the node that HOLDS the bytes.
   *
   * ⚠️ Stored HASHED, like every other credential here (lib/mesh/pairing.js). And bound to a
   * FILEPATH rather than a content id: a replace on the hub writes a new randomly-named file and
   * unlinks the old one, so a filepath-bound ticket 404s cleanly mid-transfer instead of splicing
   * two different assets into one file.
   *
   * The child pulls; the parent never initiates a transfer. The child dialled out because it may
   * have no inbound route at all, and every mechanism added here keeps that direction. */
  `CREATE TABLE IF NOT EXISTS mesh_pull_tickets (
     id          TEXT    PRIMARY KEY,
     token_hash  TEXT    NOT NULL,
     edge_id     TEXT    NOT NULL,
     filepath    TEXT    NOT NULL,
     size        INTEGER NOT NULL,
     digest      TEXT,
     created_at  INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL,
     used_at     INTEGER
   )`,
  'CREATE INDEX IF NOT EXISTS idx_mesh_ticket_hash ON mesh_pull_tickets(token_hash)',
  'CREATE INDEX IF NOT EXISTS idx_mesh_ticket_exp ON mesh_pull_tickets(expires_at)',

  /* Applied mesh writes, so a retry cannot apply twice.
   *
   * ⚠️ THE READ PATH NEEDS NOTHING LIKE THIS AND THAT IS EXACTLY WHY IT IS EASY TO FORGET. A
   * repeated read is harmless, so mesh correlates requests with nothing but socket.io's ack
   * callback. A repeated WRITE is not harmless, and the uplink already re-queues on ack timeout —
   * so the ordinary behaviour of a flaky link is to send the same intent again.
   *
   * op_id is minted by the parent and stable across its retries. The outcome is recorded, and a
   * replay returns THE RECORDED OUTCOME rather than re-applying: the caller sees what happened the
   * first time, which is both correct and what makes the retry safe to attempt at all.
   *
   * intent_seq is monotonic per (edge, target) and answers out-of-order delivery: a stale "set
   * playlist A" arriving behind "set playlist B" is dropped rather than winning by arriving last.
   */
  `CREATE TABLE IF NOT EXISTS mesh_write_ops (
     edge_id     TEXT    NOT NULL,
     op_id       TEXT    NOT NULL,
     target      TEXT    NOT NULL,
     intent_seq  INTEGER,
     ok          INTEGER NOT NULL,
     outcome     TEXT,
     applied_at  INTEGER NOT NULL,
     PRIMARY KEY (edge_id, op_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_mesh_write_ops_target ON mesh_write_ops(edge_id, target, intent_seq)',
  'CREATE INDEX IF NOT EXISTS idx_mesh_write_ops_age ON mesh_write_ops(applied_at)',

  /* This server's OWN friendly name, which is what it declares when pairing. Defaults to the host
   * name because that is the thing an operator already recognises; editable, because hostnames are
   * frequently neither stable nor meaningful. */
  'ALTER TABLE mesh_node ADD COLUMN node_name TEXT',

  /* Pairing codes — short-lived, single-use, burned on redemption.
   *
   * ⚠️ A ROW PER CODE WITH AN EXPLICIT burned_at, not a delete. A redeemed code that vanishes cannot
   * answer "was this used, or never generated?" when an operator says pairing failed, and the two
   * have opposite fixes. The row is the audit trail for a security-relevant event. */
  `CREATE TABLE IF NOT EXISTS mesh_pairing_codes (
     id            TEXT PRIMARY KEY,
     code          TEXT NOT NULL,
     -- What this code will grant when redeemed. ⚠️ Chosen at MINT time, by the operator who is
     -- already authenticated here — never by the party redeeming it. A code that let the redeemer
     -- pick its own grant would be a self-service permission escalation.
     role_capabilities TEXT NOT NULL DEFAULT '[]',
     grant_categories  TEXT NOT NULL DEFAULT '[]',
     client_id     TEXT,
     retention_days INTEGER,
     created_by    TEXT,
     created_at    INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     burned_at     INTEGER,
     burned_by_node TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_code ON mesh_pairing_codes (code)`,

  /* Clients — the grouping primitive ABOVE node.
   *
   * ⚠️ NOT A WORKSPACE. The six existing roles are workspace-scoped, and an MSP tech needing to see
   * Acme but not Contoso is a different axis entirely: a client may own three servers, and a
   * workspace lives inside one of them. "Everyone at the MSP sees every client" is the outcome of
   * not having this table, and it does not survive a security review. */
  `CREATE TABLE IF NOT EXISTS mesh_clients (
     id               TEXT PRIMARY KEY,
     name             TEXT NOT NULL,
     notes            TEXT,
     -- Nesting, for an MSP with regional structure: holding company -> MSP -> region -> client.
     -- ⚠️ Capped at 4 levels and cycle-checked in server/lib/mesh/client-tree.js, NOT here: SQLite
     -- cannot express either, and a self-referencing FK would happily accept a loop.
     -- ⚠️ Access INHERITS down this tree, which deliberately bends the default-deny-by-absence rule
     -- in mesh_client_access. That is safe only because it is never silent — see whoGainsAccess().
     parent_client_id TEXT,
     created_at       INTEGER NOT NULL
   )`,
  /* Idempotent, for anyone who booted this branch before nesting existed — CREATE TABLE IF NOT
   * EXISTS would silently skip them and every hierarchy read would return undefined. */
  `ALTER TABLE mesh_clients ADD COLUMN parent_client_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_clients_parent ON mesh_clients (parent_client_id)`,

  /* Who may see which client. ⚠️ DEFAULT DENY BY ABSENCE: no row means no visibility, so a new
   * client is invisible to everyone until someone is named. The alternative — visible-unless-denied
   * — silently exposes every new client to every tech the moment it is added. */
  `CREATE TABLE IF NOT EXISTS mesh_client_access (
     client_id  TEXT    NOT NULL,
     user_id    TEXT    NOT NULL,
     -- Per-client role. Two axes now, and they are kept separate on purpose: control of the
     -- RELATIONSHIP ('viewer' sees mirrored data; 'manager' also changes retention, rotates
     -- tokens, disenrolls, moves nodes between clients) and the ability to ACT on the client's
     -- estate ('publisher' — push content, command devices).
     -- ⚠️ This comment used to say a hub cannot write to a client's screens at all in 2.0. That
     -- was true when the table was written and stopped being true when write landed; I2 now reads
     -- "the child is the last word" rather than "upward only". Whatever this column says, the
     -- decision is still the CHILD's — this role only decides which of THIS hub's staff may ask.
     -- See server/lib/mesh/client-roles.js.
     role       TEXT    NOT NULL DEFAULT 'viewer',
     granted_at INTEGER NOT NULL,
     granted_by TEXT,
     PRIMARY KEY (client_id, user_id)
   )`,
  /* ⚠️ The ALTER is for anyone who booted this branch between the Phase 0 commit and this one:
   * CREATE TABLE IF NOT EXISTS is a silent no-op on a table that already exists, so the column
   * above would never reach them and every role check would read undefined. Idempotent — the loop
   * below treats "duplicate column name" as benign. Harmless to delete once 2.0 ships, since no
   * released version ever had this table without the column. */
  `ALTER TABLE mesh_client_access ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'`,

  /* Tombstones. Deleting a device on a child must not vanish it from the parent — last month''s
   * uptime report cannot be allowed to change retroactively, or every report becomes unciteable.
   * Purge horizon is per edge, so a client with a short retention policy binds the parent too. */
  `CREATE TABLE IF NOT EXISTS mesh_tombstones (
     id             TEXT    PRIMARY KEY,
     origin_node_id TEXT    NOT NULL,
     object_type    TEXT    NOT NULL,
     object_id      TEXT    NOT NULL,
     deleted_at     INTEGER NOT NULL,
     purge_after    INTEGER,
     UNIQUE (origin_node_id, object_type, object_id)
   )`,

  /* Idempotent, for anyone who booted this branch before the token columns existed. */
  `ALTER TABLE mesh_edges ADD COLUMN token_hash TEXT`,
  `ALTER TABLE mesh_edges ADD COLUMN token_expires_at INTEGER`,
  /* ------------------------------------------------------------------------------------------
   * THRESHOLD ALERTS (A2)
   *
   * ⚠️ THE EVENTS TABLE IS THE POINT, NOT THE RULES TABLE. Until now alerting was a side effect that
   * sent an email and remembered nothing, so "were my screens up last month, and what happened?"
   * was unanswerable — there was no record that an outage had ever begun or ended. An alert with an
   * opened_at AND a closed_at is a DURATION, and durations are what uptime reports are made of.
   * ------------------------------------------------------------------------------------------ */

  `CREATE TABLE IF NOT EXISTS alert_rules (
     id              TEXT PRIMARY KEY,
     workspace_id    TEXT,
     name            TEXT NOT NULL,
     metric          TEXT NOT NULL,
     threshold       REAL NOT NULL,
     -- ⚠️ Hysteresis. An alert closes at a DIFFERENT value than it opened at, or a device parked on
     -- the threshold flaps open/closed forever and the operator learns to mute it. NULL means "use
     -- a 10% margin on the correct side", which depends on the metric's direction.
     clear_threshold REAL,
     -- The condition must hold this long before opening. Kills the transient spike; on its own it
     -- does NOT kill the flap at the boundary, which is why clear_threshold exists too.
     sustain_seconds INTEGER NOT NULL DEFAULT 300,
     severity        TEXT NOT NULL DEFAULT 'warn',
     enabled         INTEGER NOT NULL DEFAULT 1,
     created_at      INTEGER NOT NULL,
     updated_at      INTEGER
   )`,

  /* The history. One row per incident, from the moment it opened to the moment it cleared. */
  `CREATE TABLE IF NOT EXISTS alert_events (
     id           TEXT PRIMARY KEY,
     rule_id      TEXT,
     device_id    TEXT,
     workspace_id TEXT,
     metric       TEXT NOT NULL,
     severity     TEXT NOT NULL DEFAULT 'warn',
     opened_at    INTEGER NOT NULL,
     -- NULL means STILL OPEN. That is deliberate and load-bearing: "what is wrong right now" is
     -- "closed_at IS NULL", which is one index away rather than a scan over a status column
     -- that someone has to remember to update.
     closed_at    INTEGER,
     opened_value REAL,
     peak_value   REAL,
     closed_value REAL,
     -- When the notification went out, separately from when the condition began. A send that failed
     -- must not look like an incident that never happened.
     notified_at  INTEGER
   )`,

  /* Evaluation state between ticks.
   *
   * ⚠️ breaching_since MUST be persisted, not held in memory. A service that restarts hourly could
   * otherwise never open a rule with a 5-minute sustain — the clock would reset every restart, and
   * the failure is completely silent: no alerts, no errors, everything apparently fine. */
  `CREATE TABLE IF NOT EXISTS alert_rule_state (
     rule_id         TEXT NOT NULL,
     device_id       TEXT NOT NULL,
     breaching_since INTEGER,
     open_event_id   TEXT,
     last_value      REAL,
     updated_at      INTEGER,
     PRIMARY KEY (rule_id, device_id)
   )`,

  /* "What is wrong right now" and "what happened to this screen" are the two queries that matter. */
  `CREATE INDEX IF NOT EXISTS idx_alert_events_open   ON alert_events (closed_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_events_device ON alert_events (device_id, opened_at)`,
  `CREATE INDEX IF NOT EXISTS idx_alert_events_ws     ON alert_events (workspace_id, opened_at)`,

  /* ------------------------------------------------------------------------------------------
   * MIRRORED STATE — what a parent keeps about the nodes below it.
   *
   * ⚠️ TWO TIMESTAMPS ON EVERY ROW, AND THEY ARE NOT REDUNDANT. `origin_ts` is when the origin node
   * observed it, from its clock; `received_at` is when we were told, from ours. Phase 3's tri-state
   * status is impossible without both: "online as of 14:32" and "we have not heard since 12:05" are
   * different sentences, and collapsing them into one column is what makes a dashboard show a green
   * dot from ninety minutes ago — a lie by omission.
   *
   * ⚠️ STALENESS IS A PROPERTY OF THE EDGE, NOT OF THE ROW. A device row an hour old is perfectly
   * current if its node reports hourly and is reachable; it is stale if the node fell off ten minutes
   * ago. So freshness is judged by joining to mesh_edges.last_sync_at, never by the row's own age.
   *
   * ⚠️ EVERY ROW CARRIES origin_node_id, NEVER A PATH (I4). Re-parenting a node changes the display
   * path and nothing else — history keeps resolving to the same node.
   * ------------------------------------------------------------------------------------------ */

  /* One row per node we have ever heard from, holding its latest self-report. */
  `CREATE TABLE IF NOT EXISTS mesh_mirror_nodes (
     origin_node_id  TEXT PRIMARY KEY,
     via_edge_id     TEXT NOT NULL,
     node_version    TEXT,
     device_count    INTEGER,
     devices_online  INTEGER,
     origin_ts       INTEGER,
     received_at     INTEGER NOT NULL,
     -- Set when the edge is revoked. The rows are KEPT (last month's report must not change
     -- retroactively) and simply marked, so a UI can grey them rather than delete them.
     stale_since     INTEGER
   )`,

  /* Latest known state per device, per origin node.
   *
   * ⚠️ HOT FIELDS ARE REAL COLUMNS; THE REST IS JSON. The projection is grant-dependent, so a fixed
   * column per field would be mostly NULL and would need a migration every time a category is added.
   * But Phase 3 requires server-side search and pagination from the start — "fine at 40 devices,
   * fatal at 10,000" — and you cannot index inside a JSON blob, so the fields people actually filter
   * and sort by are extracted. `name` is nullable precisely because a health-only grant does not
   * include it, which is what makes those devices un-searchable by name (a documented consequence,
   * not a bug). */
  `CREATE TABLE IF NOT EXISTS mesh_mirror_devices (
     origin_node_id  TEXT NOT NULL,
     device_id       TEXT NOT NULL,
     name            TEXT,
     status          TEXT,
     last_heartbeat  INTEGER,
     body            TEXT NOT NULL DEFAULT '{}',
     origin_ts       INTEGER,
     received_at     INTEGER NOT NULL,
     deleted_at      INTEGER,
     PRIMARY KEY (origin_node_id, device_id)
   )`,
  /* Which edge this row arrived on. ⚠️ AFTER the CREATE above — an ALTER placed with the other
   * mesh_edges alters runs before the table exists, fails as a benign "no such table", and the
   * column silently never arrives (that exact mistake cost an hour earlier today).
   *
   * Needed because a relayed row's ORIGIN is a node this hub has no edge to. Visibility is resolved
   * from the edge a row came in on, so without this a screen relayed from two hops down is stored
   * correctly and then filtered out of every view — present in the database, absent from the page. */
  'ALTER TABLE mesh_mirror_devices ADD COLUMN edge_id TEXT',

  /* HOW FAR AWAY A NODE IS, and by which route.
   *
   * ⚠️ Learned from the ancestry a relayed payload carries, never declared. A node cannot tell this
   * hub where it sits — it would be describing a relationship it is not a party to — but a payload
   * that arrives having genuinely travelled A<-B<-C proves the shape by having taken it.
   *
   * `hops` is the number of LINKS between here and that node: 1 is a server this one is paired
   * with, 2 is a server behind one of those. That is the number an operator actually asks for when
   * they want to know whether there is a relay in the middle. */
  `CREATE TABLE IF NOT EXISTS mesh_node_paths (
     node_id      TEXT PRIMARY KEY,
     via_edge_id  TEXT NOT NULL,
     path         TEXT NOT NULL,
     hops         INTEGER NOT NULL,
     first_seen_at INTEGER NOT NULL,
     last_seen_at  INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_mesh_node_paths_edge ON mesh_node_paths (via_edge_id)',
  /* ⚠️ WHEN THIS HUB FIRST SAW THE SCREEN, which received_at cannot answer — the row is upserted, so
   * received_at is always the LATEST report. Without a first-seen the uptime report has to assume
   * every screen existed for the whole reporting window, which scores a screen installed on the 20th
   * as broken for the first 19 days of the month. Additive; older rows fall back to received_at. */
  'ALTER TABLE mesh_mirror_devices ADD COLUMN first_seen_at INTEGER',

  /* A remote server's workspaces, mirrored so its orgs can appear as ORGS here.
   *
   * ⚠️ KEYED BY (origin_node_id, workspace_id), NOT by workspace_id alone. Two servers will
   * eventually hand us the same workspace id — they are generated independently and nothing
   * coordinates them — and a single-column key would silently merge two customers' estates into one
   * row set, which is unrecoverable after the fact. The pair is the identity.
   *
   * The name is nullable because it arrives only with an `identity` grant; a health-only edge
   * mirrors the structure without the labels, and the UI says "unnamed workspace" rather than
   * inventing one. */
  `CREATE TABLE IF NOT EXISTS mesh_mirror_workspaces (
     origin_node_id    TEXT NOT NULL,
     workspace_id      TEXT NOT NULL,
     name              TEXT,
     organization_name TEXT,
     device_count      INTEGER,
     origin_ts         INTEGER,
     received_at       INTEGER NOT NULL,
     deleted_at        INTEGER,
     PRIMARY KEY (origin_node_id, workspace_id)
   )`,

  /* ⚠️ Which workspace a mirrored screen belongs to, so screens file under the right remote org.
   * Nullable: a health-only grant does not carry it, and a child on an older build never sends it —
   * both cases degrade to one flat list per server rather than to a wrong grouping. */
  'ALTER TABLE mesh_mirror_devices ADD COLUMN workspace_id TEXT',

  /* Alert events, kept as history rather than as current state — an alert that closed last week is
   * still the evidence behind last week's report. */
  `CREATE TABLE IF NOT EXISTS mesh_mirror_alerts (
     id              TEXT PRIMARY KEY,
     origin_node_id  TEXT NOT NULL,
     alert_type      TEXT NOT NULL,
     severity        TEXT,
     subject_count   INTEGER,
     subjects        TEXT,
     opened_at       INTEGER,
     closed_at       INTEGER,
     origin_ts       INTEGER,
     received_at     INTEGER NOT NULL
   )`,

  /* Proof-of-play. ⚠️ ITS OWN TABLE BECAUSE OF SCALE AND BECAUSE OF PHASE 4. A single production
   * node holds 1.29M play rows; a hub over forty sites is in the tens of millions, so it must be
   * prunable on its own retention without touching anything else. It is also the one payload that
   * must NEVER be downsampled — averaged proof-of-play is not evidence — so it can never be folded
   * into a rolled-up telemetry table. */
  `CREATE TABLE IF NOT EXISTS mesh_mirror_play_logs (
     id              TEXT PRIMARY KEY,
     origin_node_id  TEXT NOT NULL,
     device_id       TEXT,
     content_ref     TEXT,
     played_at       INTEGER,
     duration_ms     INTEGER,
     origin_ts       INTEGER,
     received_at     INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_mirror_dev_node   ON mesh_mirror_devices (origin_node_id)`,
  /* Search and sort paths for Phase 3. Name is indexed despite being nullable — a partial-ish index
   * is still what makes "find the screen called Reception" bounded across 10,000 rows. */
  `CREATE INDEX IF NOT EXISTS idx_mirror_dev_name   ON mesh_mirror_devices (name)`,
  `CREATE INDEX IF NOT EXISTS idx_mirror_dev_status ON mesh_mirror_devices (status)`,
  `CREATE INDEX IF NOT EXISTS idx_mirror_alert_node ON mesh_mirror_alerts (origin_node_id, opened_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mirror_alert_open ON mesh_mirror_alerts (closed_at)`,
  /* Retention prunes by age, so the age is the index. */
  `CREATE INDEX IF NOT EXISTS idx_mirror_play_age   ON mesh_mirror_play_logs (origin_node_id, played_at)`,

  `CREATE INDEX IF NOT EXISTS idx_mesh_edges_token  ON mesh_edges (token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_edges_peer   ON mesh_edges (peer_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_edges_client ON mesh_edges (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mesh_tomb_origin  ON mesh_tombstones (origin_node_id, object_type)`,

  /* ==============================================================================================
   * TRIGGERS — externally-fired interrupt content, resolved on the device. docs/triggers-design.md
   *
   * ⚠️ The whole point is that this works with the WAN down, so nothing here is consulted at fire
   * time: these rows are the DEFINITION, synced to the device and answered from its local copy.
   * ============================================================================================ */
  `CREATE TABLE IF NOT EXISTS triggers (
     id               TEXT PRIMARY KEY,
     workspace_id     TEXT NOT NULL,
     name             TEXT NOT NULL,
     /* The string an external system sends. Unique per workspace so one token cannot resolve to two
      * different overlays depending on which row is read first. */
     match_token      TEXT NOT NULL,
     clear_token      TEXT,
     source_http      INTEGER NOT NULL DEFAULT 1,
     source_udp       INTEGER NOT NULL DEFAULT 0,
     /* ⚠️ target_kind + target_ref is the no-migration hook. v1 writes 'playlist' + a playlist id;
      * 'url' + target_url is the later addition and needs no schema change to land. The v1 target is
      * a PLAYLIST precisely because playlist items are library content and therefore pinnable — an
      * arbitrary URL cannot be, which would break the offline guarantee at the only moment it
      * matters. See §1 of the design. */
     target_kind      TEXT NOT NULL DEFAULT 'playlist',
     target_ref       TEXT,
     target_url       TEXT,
     position         TEXT NOT NULL DEFAULT 'center',
     width            INTEGER, height INTEGER, opacity REAL, border_radius INTEGER,
     mode             TEXT NOT NULL DEFAULT 'once',
     /* ⚠️ max_duration_sec, NOT duration_sec. The PiP contract already uses a duration field where 0 means
      * "until cleared"; here 0 means "no cap". Two adjacent fields where the same value means
      * opposite things is a trap, so the name differs because the semantics do. */
     max_duration_sec INTEGER,
     /* until_cleared only. A clear is one unacked datagram, so a lost clear strands the screen.
      * Senders re-assert on a timer, and each matching re-fire renews this. NULL = hold
      * indefinitely, which is the pre-lease behaviour, so it stays opt-in. */
     lease_sec        INTEGER,
     priority         INTEGER NOT NULL DEFAULT 0,
     enabled          INTEGER NOT NULL DEFAULT 1,
     created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     /* Declared inline, like org_sso_*, rather than retrofitted later: WS_CASCADE_TABLES exists to
      * fix tables born without the action, and a new table has no reason to join that queue.
      * foreign_keys is ON (see the pragma at the top of this file), so this actually fires. */
     FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
   )`,
  /* Definitions are org-scoped and ASSIGNED to screens or groups — per-screen definitions do not
   * survive a 40-screen deployment. */
  `CREATE TABLE IF NOT EXISTS trigger_assignments (
     trigger_id  TEXT NOT NULL,
     target_type TEXT NOT NULL CHECK (target_type IN ('device','group')),
     target_id   TEXT NOT NULL,
     created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     PRIMARY KEY (trigger_id, target_type, target_id),
     FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE
     /* ⚠️ target_id is POLYMORPHIC (a device or a group), so it cannot carry an FK. Deleting a
      * device or group therefore leaves an assignment row behind, and the resolver must treat a
      * dangling assignment as "not assigned" rather than trusting the row exists. Cleaned up
      * app-side on device/group delete; the resolver's guard is what makes a missed cleanup
      * harmless instead of a crash. */
   )`,
  /* Per-device trigger listener settings. ⚠️ Deliberately NOT on the trigger: enabling a trigger is
   * a content decision, opening a listening port on the LAN is a security one, and one must not
   * imply the other. Both default OFF, matching MESH_ACCEPT_ENROLLMENT / MESH_ALLOW_UPLINK. */
  'ALTER TABLE devices ADD COLUMN triggers_accept_http INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN triggers_accept_udp INTEGER NOT NULL DEFAULT 0',
  /* The shared secret every payload must carry. Per device so a compromise is one screen, and
   * rotatable without touching a trigger definition. */
  'ALTER TABLE devices ADD COLUMN trigger_secret TEXT',
  'ALTER TABLE devices ADD COLUMN trigger_http_port INTEGER',
  'ALTER TABLE devices ADD COLUMN trigger_udp_port INTEGER',
  'ALTER TABLE devices ADD COLUMN trigger_multicast_group TEXT',
  'ALTER TABLE devices ADD COLUMN trigger_clear_all_token TEXT',
  /* ⚠️ CURRENT STATE, not history — deliberately a column and not a device_telemetry row. What an
   * installer needs is "is multicast reaching this player RIGHT NOW", and a time series of that
   * would grow without bound to answer a question only ever asked about the latest value. */
  'ALTER TABLE devices ADD COLUMN trigger_status TEXT',
  'ALTER TABLE devices ADD COLUMN trigger_status_at INTEGER',

  /*
   * The INBOUND local REST door (Goal B part 3): a room control system on the customer's LAN asks
   * the panel to do something, or asks what it is doing.
   *
   * ⚠️ ITS OWN FLAG, even though it shares the trigger HTTP socket and port. `triggers_accept_http`
   * means "a LAN host may put an overlay on this screen"; this means "a LAN host may change what
   * this screen is doing". One flag for both would have handed remote control to every site that
   * only ever wanted an emergency overlay, and the two are enabled months apart by different people.
   *
   * ⚠️ AND ITS OWN SECRET, not trigger_secret. The trigger secret is designed to be pasted into an
   * AMX program and travels in a query string in cleartext; it authorises an overlay. This one
   * authorises reload / screen on-off / volume / brightness. Sharing them would mean every installer
   * who was ever given the trigger secret could turn the fleet off, and revoking one would revoke
   * the other.
   */
  'ALTER TABLE devices ADD COLUMN local_api_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN local_api_secret TEXT',

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_token ON triggers (workspace_id, match_token)`,
  `CREATE INDEX IF NOT EXISTS idx_triggers_ws     ON triggers (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trigger_assign  ON trigger_assignments (target_type, target_id)`,

  /* ==============================================================================================
   * DISPLAY POWER SCHEDULES — the BACKLIGHT on a weekly clock. Nothing here powers a device off.
   *
   * ⚠️ NOT the `schedules` table, and the separation is the point. That one answers "what plays
   * when", is per-zone, carries content/widget/layout/playlist ids, priorities and colours, and a
   * row in it is a programming decision. This answers "is the panel lit", has no content at all,
   * and a row in it is an electricity decision. Overloading `schedules` would mean every content
   * query grew an "and is this actually a power row" filter, which is the shape that eventually
   * gets forgotten in exactly one query.
   *
   * ⚠️ The windows are evaluated ON THE PANEL, from its local copy, by lib/power-window.js and its
   * Kotlin port against shared/power-window-vectors.json. The server never decides "off now" and
   * pushes it — a screen whose WAN is down must still sleep and wake on time, and a schedule that
   * depended on a live socket would strand a dark panel the moment the network blinked.
   * ============================================================================================ */
  `CREATE TABLE IF NOT EXISTS display_power_schedules (
     id           TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     name         TEXT NOT NULL DEFAULT '',
     /* Device XOR group, same shape and the same CHECK the content schedules table uses, so the
      * precedence rule (device beats group) reads identically in both. See device-power-schedule.js,
      * which is the ONE definition of which schedule a given screen obeys. */
     device_id    TEXT REFERENCES devices(id) ON DELETE CASCADE,
     group_id     TEXT REFERENCES device_groups(id) ON DELETE CASCADE,
     /* IANA zone the windows are WRITTEN in. Resolved at push time through lib/device-timezone so
      * creation and evaluation agree — a schedule authored in one zone and evaluated in another is
      * the bug that makes a screen sleep an hour early twice a year. NULL = the device's own. */
     timezone     TEXT,
     enabled      INTEGER NOT NULL DEFAULT 1,
     /* JSON array of { days:[0-6], start:"HH:MM", end:"HH:MM" }. Stored as a document rather than
      * a child table because it is only ever read and written WHOLE — the player gets the entire
      * list or none of it, and no query ever asks "which schedules contain a Tuesday". */
     windows      TEXT NOT NULL DEFAULT '[]',
     created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
   )`,
  /* One schedule per target. A screen with two contradictory power schedules has no defined
   * behaviour, and the resolver would have to invent a tiebreak; the database refuses instead. */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dps_device ON display_power_schedules (device_id) WHERE device_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dps_group  ON display_power_schedules (group_id)  WHERE group_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_dps_ws ON display_power_schedules (workspace_id)`,

  /* ==============================================================================================
   * RESUMABLE UPLOADS — one row per in-flight file.
   *
   * ⚠️ WHY THIS EXISTS. A single-request upload must finish inside whatever the shortest timeout
   * between the browser and this process happens to be. On prod that is Cloudflare's, measured at
   * exactly 125s across seven consecutive failures from one customer in Perth uploading to a
   * Hetzner box — his successful uploads peaked at 114.2s, i.e. he was living inside a 10-second
   * margin. Anyone far from the origin, or on ordinary domestic broadband, has the same ceiling;
   * they just have not hit it yet.
   *
   * The fix is not a bigger timeout, it is smaller requests: each chunk gets its OWN budget, so the
   * ceiling stops scaling with file size.
   *
   * ⚠️ THE OFFSET IS NOT STORED HERE. It is the size of the part file on disk, read at request
   * time. A counter in this table would be a second source of truth that can disagree with the
   * bytes — and it would disagree exactly when it matters, after a crash mid-append, which is the
   * case the whole feature exists to survive.
   * ============================================================================================ */
  `CREATE TABLE IF NOT EXISTS upload_sessions (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     user_id       TEXT NOT NULL,
     filename      TEXT NOT NULL,
     /* What the CLIENT says it will send. Never trusted as fact — the append path enforces it as a
      * ceiling and finalize refuses a part file that does not match — but needed up front so the
      * storage allowance can be checked BEFORE a gigabyte is accepted rather than after. */
     declared_size INTEGER NOT NULL,
     folder_id     TEXT,
     /* Relative to config.uploadsDir + '/incoming'. ⚠️ NOT contentDir: /uploads/content is served
      * statically, so a partial file there would be web-reachable from the dashboard's own origin
      * BEFORE upload-sniff has looked at its bytes. */
     part_name     TEXT NOT NULL,
     created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     /* Touched on every append. The sweeper measures idleness from here, so a slow upload that is
      * still making progress is never collected out from under the person making it. */
     updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_upload_sessions_ws  ON upload_sessions (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_sessions_age ON upload_sessions (updated_at)`,

  /* ==============================================================================================
   * DEVICE ENDPOINTS — saved REST calls a PANEL makes on its own network, on its own clock.
   *
   * ⚠️ The polling happens ON THE DEVICE, not here. The whole point of the http_request surface is
   * that the panel stands on the private side of the customer's firewall, next to the PLC and the
   * sensor; a server-side poller could not reach any of it. So these rows are a DEFINITION, synced
   * to the device, and the device runs them — including with the WAN down. Same shape as triggers.
   *
   * ⚠️ device_id XOR group_id, but the RESOLUTION IS A UNION, not an override. A power schedule has
   * one answer ("is this screen lit"), so device beats group. A list of endpoints is not one
   * answer: a screen should run its group's endpoints AND its own. The only override is by NAME,
   * so one panel can point "PLC state" somewhere else without leaving the group.
   * ============================================================================================ */
  `CREATE TABLE IF NOT EXISTS device_endpoints (
     id           TEXT PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     name         TEXT NOT NULL,
     device_id    TEXT REFERENCES devices(id) ON DELETE CASCADE,
     group_id     TEXT REFERENCES device_groups(id) ON DELETE CASCADE,
     method       TEXT NOT NULL DEFAULT 'GET',
     url          TEXT NOT NULL,
     /* JSON object. ⚠️ Header VALUES are encrypted at rest with lib/plugins/secrets, because an
      * endpoint header is where an API key lives and a workspace member who can read a row should
      * not thereby read the credential. They are decrypted on the way to the panel, which needs
      * the plaintext to make the call at all. */
     headers      TEXT NOT NULL DEFAULT '{}',
     body         TEXT,
     timeout_ms   INTEGER,
     /* How it fires. Exactly one of the two is meaningful:
      *   interval_sec — every N seconds, on the device's own clock
      *   run_on       — 'screen_on' | 'screen_off' | 'heartbeat'
      * Neither set = the endpoint only runs when an operator asks. */
     interval_sec INTEGER,
     run_on       TEXT,
     enabled      INTEGER NOT NULL DEFAULT 1,
     created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     CHECK ((device_id IS NOT NULL AND group_id IS NULL) OR (device_id IS NULL AND group_id IS NOT NULL))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_device_endpoints_ws     ON device_endpoints (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_device_endpoints_device ON device_endpoints (device_id)`,
  `CREATE INDEX IF NOT EXISTS idx_device_endpoints_group  ON device_endpoints (group_id)`,

  /*
   * ─── Playlist inheritance ────────────────────────────────────────────────────────────────
   *
   * devices.playlist_id had ONE reader and TWELVE writers, so there was no precedence — only
   * whoever wrote last. A hand-set per-device playlist was destroyed the next time anyone touched
   * its group or wall, and a device in two groups had no defined winner (the leave-handler picked
   * "any remaining group with a playlist", i.e. whatever SQLite returned first).
   *
   * playlist_source records what the id MEANS, which the column alone cannot: 'device' = someone
   * chose it for this screen. NULL = inherited, resolve it live. Without this distinction there is
   * no way to express "this screen overrides its group", and no way to revert.
   */
  "ALTER TABLE devices ADD COLUMN playlist_source TEXT",

  /*
   * What an ACTIVE SCHEDULE is currently imposing, kept apart from what the device is normally on.
   *
   * services/scheduler.js used to overwrite devices.playlist_id / layout_id and remember the
   * previous values in an in-memory Map. A restart during an active schedule lost the Map and
   * stranded the device on the scheduled playlist permanently, because nothing in the row said the
   * change had been temporary. Separate columns make "revert" mean "clear this", and make every
   * evaluation idempotent and self-healing across a restart.
   *
   * "Active now" depends on the device's timezone and is evaluated in JS (lib/schedule-eval), so
   * this cannot be a subquery in the view — the scheduler still decides, it just records its
   * decision somewhere that does not destroy the operator's.
   */
  "ALTER TABLE devices ADD COLUMN scheduled_playlist_id TEXT REFERENCES playlists(id) ON DELETE SET NULL",
  "ALTER TABLE devices ADD COLUMN scheduled_layout_id TEXT REFERENCES layouts(id) ON DELETE SET NULL",

  /* The name a node declares for ITSELF, mirrored on whoever receives its reports.
   *
   * ⚠️ ADDED BECAUSE THE NAME COULD TRAVEL BUT COULD NOT CHANGE. `mesh_node.node_name` and the wire
   * field both shipped, and `mesh_edges.peer_name` was written from the introduction at enrollment
   * — once, and never again. Nothing anywhere ever called setNodeName, so every server in a mesh
   * was permanently whatever its hostname happened to be on pairing day. That is the same defect
   * peer_version had, and it is fixed the same way: the name rides the periodic self-report.
   *
   * ⚠️ A LABEL, NEVER AN IDENTIFIER. It arrives from another operator's machine, it is not unique,
   * not authenticated, and is freely changeable by whoever owns that node. Route, authorize and key
   * on node_id; show this to humans and escape it on the way out. */
  'ALTER TABLE mesh_mirror_nodes ADD COLUMN node_name TEXT',

  /* The HTTP status an audited request actually returned.
   *
   * ⚠️ ADDED BECAUSE THE AUDIT TRAIL COULD NOT TELL SUCCESS FROM FAILURE. activityLogger gated on
   * `res.statusCode < 400`, so a mutation that 500'd left NO row at all — identical, from the data,
   * to one that never happened. On prod that meant 12,667 audited requests and exactly ZERO recorded
   * failures outside the explicit `auth:login_failed` event: a playlist publish that blew up looked
   * exactly like one that worked. This column plus the widened gate is what makes "did it break, and
   * for whom" answerable.
   *
   * NULL is meaningful and correct: rows written by the ~49 direct logActivity() callers are named
   * events ('auth:login_success', 'alert:device_offline'), not HTTP requests, and have no status. */
  'ALTER TABLE activity_log ADD COLUMN status_code INTEGER',

  /* Community hardware reports for the public Certified Hardware page.
   *
   * ⚠️ THIS TABLE CAN NEVER PRODUCE A CERTIFIED ENTRY. Reseller agreements define Certified Hardware
   * as the models published on that page, and support obligations attach to them, so certification
   * stays in certified-hardware.json where a human commits it. What lands here is the other half of
   * that page: "a user says this works", published with an explicit note that it carries no support
   * commitment. The status is forced server-side, not chosen by the submitter.
   *
   * decision_token_hash is the emailed one-click approve/reject link. Only the hash is stored and
   * consuming it clears the row's token, so a link works exactly once — same shape as email verify. */
  `CREATE TABLE IF NOT EXISTS hardware_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    manufacturer TEXT,
    model_numbers TEXT,
    category TEXT NOT NULL,
    os TEXT,
    player TEXT,
    max_resolution TEXT,
    player_version TEXT,
    notes TEXT,
    submitter_name TEXT,
    submitter_email TEXT,
    submitted_ip TEXT,
    submitted_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decision_token_hash TEXT,
    decision_token_expires INTEGER,
    decided_at INTEGER,
    decided_by TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_hardware_submissions_status ON hardware_submissions(status)',

  /* Which screen-capture tier a panel can actually use: projection | accessibility | view | none.
   *
   * ⚠️ ADDED BECAUSE THE LIVE VIEW DEGRADES SILENTLY. MediaProjection consent does not survive the
   * app restarting and an OTA restarts the app, so a panel drops from whole-screen capture to
   * drawing only the player's own window — the remote view shows the playlist and goes blank over
   * Settings, with no error and nothing anywhere saying why. A customer reported exactly that after
   * an update, on two panels at once, and the only way to tell was to infer it from the pictures.
   * Recording the tier makes it a state the dashboard can show and an operator can act on.
   *
   * NULL means "this panel has not told us" — every non-Android player, and any Android build older
   * than this column. Do not render NULL as a fault. */
  "ALTER TABLE devices ADD COLUMN capture_mode TEXT",

  /* Whether an operator actually CHOSE this server's name, as opposed to inheriting the hostname.
   *
   * ⚠️ A SEPARATE FLAG RATHER THAN COMPARING THE NAME TO os.hostname(). The comparison is wrong in
   * both directions: a box renamed at the OS level after pairing would start reporting a chosen
   * name as a default, and an operator who deliberately types the hostname would be told they never
   * decided. It also has to survive the hostname changing, which is the thing that prompted the
   * name to be editable in the first place. */
  'ALTER TABLE mesh_node ADD COLUMN chose_name INTEGER NOT NULL DEFAULT 0',

  /* Slide decks — the editable SOURCE a deck is authored as.
   *
   * ⚠️ NOT A CONTENT TYPE, and that is the whole design. Publishing a deck emits one slide WIDGET
   * per page plus a PLAYLIST that orders them, so scheduling, groups, inheritance, the resolver and
   * every player keep working on objects they already understand. This row is read by the editor and
   * by nothing else; delete every deck and the screens carry on unaffected.
   *
   * `playlist_id` is where it publishes TO. Deliberately not a foreign key with a cascade: SQLite's
   * foreign_keys pragma is OFF in this process (see the FK-orphan note elsewhere), so a declared
   * CASCADE here would be inert and would read as a guarantee that does not exist. publishDeck
   * re-checks the playlist still exists and still belongs to this workspace on every publish. */
  `CREATE TABLE IF NOT EXISTS slide_decks (
     id           TEXT PRIMARY KEY,
     workspace_id TEXT,
     user_id      TEXT,
     name         TEXT NOT NULL,
     doc          TEXT NOT NULL DEFAULT '{"slides":[]}',
     playlist_id  TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_slide_decks_ws ON slide_decks(workspace_id)',

  /* What this deck published LAST time, as a JSON array of widget ids.
   *
   * ⚠️ THE PRIOR STATE CANNOT COME FROM THE DOCUMENT, and a test caught why. The first version
   * worked out what to delete by diffing the incoming doc's widget_id fields against the new set —
   * but widget_id lives inside a blob the caller supplies, so naming another workspace's widget id
   * on a slide made publish DELETE that widget. It also could not see a slide removed before the
   * save, because by then the document no longer mentioned it.
   *
   * This column is written only by publish, so it is the server's own record of what it created,
   * and diffing against it is both correct and unforgeable. */
  'ALTER TABLE slide_decks ADD COLUMN published_widget_ids TEXT NOT NULL DEFAULT \'[]\'',
  // Content approval + version history (lib/release-policy.js, lib/revisions.js). Off by default
  // for every workspace, existing and new; a draft column is NULL until a draft exists.
  'ALTER TABLE widgets ADD COLUMN draft_config TEXT',
  'ALTER TABLE layouts ADD COLUMN draft_zones TEXT',
  'ALTER TABLE content ADD COLUMN draft_json TEXT',

  /* Fonts an operator uploaded, to set slides in a brand face the bundled five do not cover.
   *
   * ⚠️ `css_family` IS GENERATED, NEVER THE FONT'S OWN NAME. A font declaring itself "Inter" would
   * otherwise shadow the bundled Inter in any document that used both, and whichever @font-face
   * came second would win — a slide changing appearance because of an unrelated upload, with
   * nothing to point at. Every uploaded face gets a unique family that cannot collide.
   *
   * ⚠️ `licence_note` and `uploaded_by` exist because THIS SERVER REDISTRIBUTES the file: every
   * screen showing a slide in this face downloads it. The bundled fonts are OFL so that is settled;
   * for an upload it is the uploader's assertion, and on a hosted instance the operator needs to be
   * able to see who made it and on what basis. Recorded at upload, shown in the editor. */
  // #320: operator-uploaded GLSL transitions. Customer content, kept out of shared/Transitions/ so
  // the first-party licensing claim in docs/licensing.md stays a flat statement.
  `CREATE TABLE IF NOT EXISTS custom_shaders (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     uploaded_by   TEXT,
     shader_id     TEXT NOT NULL,
     name          TEXT NOT NULL,
     blurb         TEXT NOT NULL DEFAULT '',
     source        TEXT NOT NULL,
     params        TEXT NOT NULL DEFAULT '[]',
     licence_note  TEXT,
     created_at    INTEGER NOT NULL,
     UNIQUE (workspace_id, shader_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_custom_shaders_ws ON custom_shaders(workspace_id)',
  `CREATE TABLE IF NOT EXISTS custom_fonts (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT,
     uploaded_by   TEXT,
     name          TEXT NOT NULL,
     css_family    TEXT NOT NULL,
     filepath      TEXT NOT NULL,
     format        TEXT NOT NULL,
     file_size     INTEGER NOT NULL,
     licence_note  TEXT,
     created_at    INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_custom_fonts_ws ON custom_fonts(workspace_id)',
  /*
   * #313 — a per-display ENROLMENT KEY, so a player with no durable storage can say who it is.
   *
   * ⚠️ THE CASE THIS EXISTS FOR. A vMix browser input deletes its whole CEF profile when vMix
   * closes (vMix staff, on their forum: "The Web Browser input cache is automatically cleared when
   * closing vMix"), so localStorage, cookies and IndexedDB all go together. The web player boots
   * with nothing but its URL, and a player with no identity provisions a NEW display row — which
   * means a fresh unpaired screen after every restart, and a dashboard filling up with corpses.
   *
   * So the identity has to live in the URL. This column is the thing the URL carries.
   *
   * ⚠️ NOT devices.device_token, and not devices.pairing_code. The device token is used on every
   * message and cannot be rotated without re-pairing the screen; the pairing code is six digits,
   * which is fine displayed on a screen behind a lockout for a few minutes and far too weak as a
   * durable secret in a URL. This is a third thing on purpose: long, rotatable from the display's
   * page, and good for exactly one action — proving which display you are.
   *
   * NULL for every display that does not use one, which is nearly all of them.
   */
  'ALTER TABLE devices ADD COLUMN enrol_key TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_enrol_key ON devices(enrol_key) WHERE enrol_key IS NOT NULL',
  /*
   * View-only access (lib/view-access.js): watch a display from a browser without pairing one.
   * OFF by default. The share token is a separate secret from device_token and enrol_key: stored as
   * a sha256 for lookup and sealed (secretbox) so an admin can copy the link again. view_cidrs is a
   * JSON array of networks that may open the display's token-less view address.
   */
  'ALTER TABLE devices ADD COLUMN view_enabled INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE devices ADD COLUMN view_token_hash TEXT',
  'ALTER TABLE devices ADD COLUMN view_token_enc TEXT',
  'ALTER TABLE devices ADD COLUMN view_cidrs TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_view_token ON devices(view_token_hash) WHERE view_token_hash IS NOT NULL',
  // #299 offline proof-of-play: a player-minted id for plays replayed after an outage, so a
  // re-flush cannot double-count. Partial index — live plays leave it NULL and must not collide.
  'ALTER TABLE play_logs ADD COLUMN client_event_id TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_play_logs_client_event ON play_logs(client_event_id) WHERE client_event_id IS NOT NULL',
  /*
   * ⚠️ #307: THE 10-SECOND LOOP BLOCK. This index is the fix, and it is worth stating what it cost.
   *
   * deviceSocket closes a play by finding the device's most recent OPEN row:
   *   WHERE device_id = ? AND ended_at IS NULL AND (content_id = ? OR widget_id = ?)
   *   ORDER BY started_at DESC, id DESC LIMIT 1
   * idx_play_logs_device covers device_id, so SQLite found the device's rows — and then sorted them
   * in a TEMP B-TREE, because that index cannot satisfy the ORDER BY once `ended_at IS NULL` has
   * filtered it. On prod one device has 377,132 play_logs rows. Measured against a copy of the real
   * database: **153ms for that one query**, every time that panel advanced an item.
   *
   * A player advances on its dwell, so this ran roughly every ten seconds and blocked the event
   * loop for the whole of it — which is exactly the signature in the telemetry: spikes of 100-300ms
   * arriving in pairs about ten seconds apart, 19.5% of all seconds carrying one. It is why prod
   * read `elevated`, and it is the load Bold's server was still carrying after their I/O subsided.
   *
   * PARTIAL (`WHERE ended_at IS NULL`) so it indexes only OPEN plays — a few thousand rows rather
   * than 1.44 million — and carries the sort order, so the query becomes a seek to the first
   * matching row. Same query on the same data afterwards: **0.000ms**.
   *
   * ⚠️ THE INDEX TREATS A SYMPTOM. That device has 377k rows and another has 21,115 rows still
   * OPEN, which means plays are being started and never closed; the open set grows forever and any
   * scan over it gets slower forever. See [[project_screentinker_fk_orphans]] and the #299 backfill
   * work — the leak is a separate fix, and this index stops it costing the whole fleet meanwhile.
   */
  'CREATE INDEX IF NOT EXISTS idx_play_logs_open ON play_logs(device_id, started_at DESC, id DESC) WHERE ended_at IS NULL',
  /*
   * One row per Stripe invoice we have emailed a receipt for.
   *
   * ⚠️ THE POINT IS "ONCE", AND STRIPE MAKES THAT NON-TRIVIAL. Webhooks are retried until they get
   * a 2xx, and the same event can be delivered more than once even after one — so a send sitting
   * directly in the handler mails a paying customer a fresh receipt on every delivery. There is no
   * dedup anywhere in routes/stripe.js today; every other handler happens to survive it because
   * they are UPDATEs to a target state, which a repeat simply reapplies. An email is not.
   *
   * Keyed on the INVOICE id rather than the event id: an invoice is the payment, and that is the
   * thing a customer should hear about once. Two different events about one invoice must still
   * produce one email.
   */
  `CREATE TABLE IF NOT EXISTS billing_receipts (
     invoice_id  TEXT PRIMARY KEY,
     user_id     TEXT,
     amount      INTEGER,
     currency    TEXT,
     sent_at     INTEGER NOT NULL
   )`,

  // embedded-renderer: per-device screen profile (JSON). NULL = not an embedded client.
  // Schema: { width, height, rotation, colorDepth, dither, outputFormat }
  // See server/lib/embedded-profiles.js for the preset library and field vocabulary.
  'ALTER TABLE devices ADD COLUMN screen_profile TEXT',
  // embedded-renderer: one-time secret for claim polling security (see routes/embedded.js)
  'ALTER TABLE devices ADD COLUMN claim_secret TEXT',

  // embedded-renderer: server-side item cursor so an MCU can wake, fetch, sleep without
  // any local state. started_at is Unix seconds; the route advances item_index when
  // now - started_at >= item.duration_sec and resets started_at.
  `CREATE TABLE IF NOT EXISTS embedded_cursor (
     device_id   TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
     item_index  INTEGER NOT NULL DEFAULT 0,
     started_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
   )`,
  `CREATE TABLE IF NOT EXISTS embedded_zone_cursor (
     device_id   TEXT REFERENCES devices(id) ON DELETE CASCADE,
     zone_id     TEXT NOT NULL,
     item_index  INTEGER NOT NULL DEFAULT 0,
     started_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     PRIMARY KEY (device_id, zone_id)
   )`,

  // Universal data sources & integrations engine (iCal, REST APIs, Google Sheets, SQL)
  `CREATE TABLE IF NOT EXISTS data_sources (
     id              TEXT PRIMARY KEY,
     workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
     slug            TEXT NOT NULL,
     name            TEXT NOT NULL,
     type            TEXT NOT NULL,
     config          TEXT NOT NULL,
     cached_data     TEXT,
     last_fetched_at INTEGER DEFAULT 0,
     last_status     TEXT DEFAULT 'ok',
     last_error      TEXT,
     created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     UNIQUE(workspace_id, slug)
   )`,
  "CREATE INDEX IF NOT EXISTS idx_data_sources_workspace ON data_sources(workspace_id)",
  "CREATE INDEX IF NOT EXISTS idx_data_sources_slug ON data_sources(workspace_id, slug)",

  /*
   * Plugin enablement is instance-global (no workspace_id) because loading is process-global:
   * a require() of plugin code cannot be scoped to one tenant. Widget *instances* of a plugin
   * type remain workspace-scoped like every other widget. Default disabled — dropping a folder
   * on disk is not RCE-on-next-boot.
   */
  `CREATE TABLE IF NOT EXISTS plugin_state (
     id         TEXT PRIMARY KEY,
     enabled    INTEGER NOT NULL DEFAULT 0,
     error      TEXT,
     loaded_at  INTEGER,
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
   )`,
  'ALTER TABLE plugin_state ADD COLUMN settings TEXT',
  'ALTER TABLE plugin_state ADD COLUMN allowlist_required INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS plugin_submissions (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     plugin_id       TEXT NOT NULL,
     name            TEXT,
     version         TEXT,
     description     TEXT,
     sha256          TEXT NOT NULL,
     tree_sha256     TEXT,
     archive_name    TEXT NOT NULL,
     manifest_json   TEXT NOT NULL,
     files_json      TEXT NOT NULL,
     size_bytes      INTEGER NOT NULL,
     submitted_by    TEXT NOT NULL,
     workspace_id    TEXT,
     submitted_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     status          TEXT NOT NULL DEFAULT 'pending',
     decided_by      TEXT,
     decided_at      INTEGER,
     decision_note   TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS idx_plugin_submissions_plugin_status ON plugin_submissions(plugin_id, status)',
  `CREATE TABLE IF NOT EXISTS plugin_allowlist (
     plugin_id      TEXT PRIMARY KEY,
     sha256         TEXT NOT NULL,
     source         TEXT NOT NULL,
     submission_id  INTEGER,
     approved_by    TEXT NOT NULL,
     approved_at    INTEGER NOT NULL,
     note           TEXT
   )`,
  "ALTER TABLE content ADD COLUMN tags TEXT",
  "ALTER TABLE content ADD COLUMN meta TEXT",
  "ALTER TABLE playlists ADD COLUMN playback_order TEXT NOT NULL DEFAULT 'sequential'",
  "ALTER TABLE playlists ADD COLUMN published_playback_order TEXT",
  "ALTER TABLE playlist_items ADD COLUMN weight INTEGER NOT NULL DEFAULT 1",
  // Support access (lib/support-access). Two tables, same shape as recovery_grants:
  //   support_requests — codes THIS instance minted when an admin asked for support. A support
  //                      token is only honoured against an open, unexpired, unredeemed one, which
  //                      is what stops a vendor-signed token from being a key to every install.
  //   support_grants   — the live sessions. A `support: true` session JWT is good only while its
  //                      row exists: DELETE revokes on the next request, expires_at bounds it,
  //                      first_used_at + source_ip attribute it.
  // Additive and idempotent; a code-only rollback leaves two unused tables behind.
  `CREATE TABLE IF NOT EXISTS support_requests (
    code          TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    expires_at    INTEGER NOT NULL,
    requested_by  TEXT,
    note          TEXT,
    redeemed_at   INTEGER,
    redeemed_jti  TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_support_requests_expires ON support_requests(expires_at)",
  `CREATE TABLE IF NOT EXISTS support_grants (
    jti            TEXT PRIMARY KEY,
    request_code   TEXT NOT NULL,
    org            TEXT,
    reason         TEXT,
    issued_by      TEXT,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    first_used_at  INTEGER,
    expires_at     INTEGER NOT NULL,
    source_ip      TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_support_grants_expires ON support_grants(expires_at)",
  // Templates library (lib/templates). Installs are instance-wide, like plugins, because the
  // package bytes are shared; a workspace USES one through a widget of type 'template'.
  //   templates_installed — one row per `catalog/id`, pinned to one version + sha256.
  //   template_catalogs   — the official catalog plus any an admin added; caches the last
  //                         verified index and the highest serial seen (rollback protection).
  //   template_seen       — per-user "New" badges in the library.
  `CREATE TABLE IF NOT EXISTS templates_installed (
    id             TEXT PRIMARY KEY,
    catalog        TEXT NOT NULL,
    template_id    TEXT NOT NULL,
    version        TEXT NOT NULL,
    sha256         TEXT NOT NULL,
    kind           TEXT NOT NULL,
    name           TEXT NOT NULL,
    manifest_json  TEXT NOT NULL,
    trust          TEXT NOT NULL,
    signer         TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    status_reason  TEXT,
    installed_by   TEXT,
    installed_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`,
  'ALTER TABLE templates_installed ADD COLUMN signer_key_id TEXT',
  `CREATE TABLE IF NOT EXISTS template_catalogs (
    id             TEXT PRIMARY KEY,
    label          TEXT NOT NULL,
    url            TEXT,
    public_key     TEXT NOT NULL,
    builtin        INTEGER NOT NULL DEFAULT 0,
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_serial    INTEGER NOT NULL DEFAULT 0,
    index_json     TEXT,
    index_expires  TEXT,
    last_checked   INTEGER,
    last_ok        INTEGER,
    last_error     TEXT,
    created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`,
  // Sales / limited-time discounts (lib/promotions.js). Each row is backed by a Stripe coupon.
  `CREATE TABLE IF NOT EXISTS promotions (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    headline           TEXT NOT NULL,
    percent_off        INTEGER NOT NULL,
    cycles             TEXT NOT NULL DEFAULT 'both',
    duration           TEXT NOT NULL DEFAULT 'once',
    duration_in_months INTEGER,
    plan_ids           TEXT NOT NULL DEFAULT '[]',
    starts_at          INTEGER NOT NULL,
    ends_at            INTEGER,
    ended_at           INTEGER,
    stripe_coupon_id   TEXT,
    created_by         TEXT,
    created_at         INTEGER NOT NULL
  )`,
  // Stale-account cleanup (lib/account-cleanup.js): the deletion notice, and an index so "last
  // activity" (MAX(activity_log.created_at) per user) is not a table scan on a big log.
  'ALTER TABLE users ADD COLUMN cleanup_warned_at INTEGER',
  'ALTER TABLE users ADD COLUMN cleanup_delete_after INTEGER',
  /*
   * A plan a platform admin granted by hand (POST /api/subscription/assign). While set, nothing
   * automatic changes plan_id — not the Stripe webhooks, the nightly reconcile or the dunning
   * lapse — because a comp is an agreement Stripe knows nothing about. Cleared by the customer's
   * own completed checkout, or by an admin assigning Free.
   */
  'ALTER TABLE users ADD COLUMN plan_comped INTEGER NOT NULL DEFAULT 0',
  // Comps made before the flag existed: a paid plan with no Stripe subscription and no trial can only
  // have come from an admin. Re-running is stable (a checkout adds a subscription; assigning Free
  // drops the plan), so it needs no one-shot marker.
  "UPDATE users SET plan_comped = 1 WHERE plan_comped = 0 AND plan_id != 'free' AND stripe_subscription_id IS NULL AND trial_started IS NULL",
  'CREATE INDEX IF NOT EXISTS idx_activity_log_user_time ON activity_log(user_id, created_at)',
  `CREATE TABLE IF NOT EXISTS template_seen (
    user_id      TEXT NOT NULL,
    template_key TEXT NOT NULL,
    version      TEXT NOT NULL,
    PRIMARY KEY (user_id, template_key)
  )`,
  // Scale-out C1 (docs/scale-out-design.md §11). All additive; a stock install gets three NULL
  // columns and two empty tables and nothing reads them.
  //   workspaces.origin_node_id — NULL means "mine". Set on a copied workspace to the node UUID of
  //                               the primary that owns it; it is the ONE column that decides
  //                               whether a write is local or must go to the primary.
  //   workspaces.replica_rev/replica_as_of — how far the copy has been applied, and when.
  //   mesh_edges.acked_rev      — on the primary: the change-log position a replica has confirmed.
  //   mesh_change_log           — on the primary, filled by triggers that exist ONLY while an up
  //                               edge carries workspace-replication (lib/mesh/replication.js);
  //                               never populated by application code.
  //   (the three workspaces columns are added below the multitenancy phase, where the table exists)
  "ALTER TABLE mesh_edges ADD COLUMN acked_rev INTEGER",
  `CREATE TABLE IF NOT EXISTS mesh_change_log (
    rev          INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    table_name   TEXT NOT NULL,
    row_id       TEXT NOT NULL,
    op           TEXT NOT NULL CHECK (op IN ('upsert','delete')),
    ts           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`,
  "CREATE INDEX IF NOT EXISTS idx_mesh_change_log_ws ON mesh_change_log(workspace_id, rev)",
  /*
   * Scale-out C2 (docs/scale-out-design.md §6).
   *   devices.attached_node_id — the replica this screen is connected THROUGH, written by the
   *     primary when it applies a player-event from that replica; NULL for a screen connected here.
   *     deliverCommand reads it to send a command-relay up the edge instead of to a local socket.
   *   mesh_player_events   — REPLICA side: the durable, ordered outbox of player events for the
   *     primary. Proof-of-play rows are never thinned; heartbeat-shaped kinds coalesce by key.
   *   mesh_player_verdicts — REPLICA side: "the primary said yes to this device + token hash".
   *     Lets a screen with a prior verified session reconnect while the primary is unreachable.
   *     Holds a HASH of the token, never the token (design: the token never leaves the primary).
   */
  'ALTER TABLE devices ADD COLUMN attached_node_id TEXT',
  `CREATE TABLE IF NOT EXISTS mesh_player_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id      TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    op_id        TEXT NOT NULL UNIQUE,
    coalesce_key TEXT,
    payload      TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mesh_player_events_edge ON mesh_player_events(edge_id, id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_mesh_player_events_coalesce ON mesh_player_events(coalesce_key) WHERE coalesce_key IS NOT NULL',
  /*
   * Scale-out C3: REPLICA side — which copied content rows have their bytes on this disk. One row
   * per content id; the file sits under uploads/content/<filename> exactly as the copied row names
   * it, so the ordinary readers serve it as a local hit. Empty on every node that declared no
   * caches-content edge. Evicted LRU by last_read_at; swept when the row or the edge goes.
   */
  `CREATE TABLE IF NOT EXISTS mesh_content_cache (
    content_id     TEXT PRIMARY KEY,
    edge_id        TEXT NOT NULL,
    filename       TEXT NOT NULL,
    thumb_filename TEXT,
    bytes          INTEGER NOT NULL DEFAULT 0,
    fetched_at     INTEGER NOT NULL,
    last_read_at   INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_mesh_content_cache_edge ON mesh_content_cache(edge_id, last_read_at)',
  'CREATE INDEX IF NOT EXISTS idx_mesh_content_cache_file ON mesh_content_cache(filename)',
  `CREATE TABLE IF NOT EXISTS mesh_player_verdicts (
    device_id    TEXT PRIMARY KEY,
    edge_id      TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    verified_at  INTEGER NOT NULL
  )`,

  /*
   * ⚠️ WHERE A PLAY HAPPENED IS A FACT ABOUT THE PAST — snapshot it, do not resolve it later.
   *
   * play_logs had no workspace_id; tenancy was reached by joining devices, i.e. by asking where
   * the device is NOW. A reseller moving a display from client A's workspace to client B's would
   * therefore rewrite history: A's past plays start appearing in B's reports and disappear from
   * A's, with nothing recording that it happened. Devices are reassigned between client
   * workspaces routinely, and the rollup below makes it permanent — once raw is pruned the
   * misattribution can no longer be recomputed away.
   *
   * Written at INSERT from the device's workspace at that moment, and never updated afterwards.
   */
  'ALTER TABLE play_logs ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL',

  /*
   * Proof-of-play rollup. play_logs is 76% of a production database (1154 MB of 1.47 GB measured
   * 2026-09-29) and growing 6.8x — 15.8k rows/day at 31-90 days old, 66.6k at 8-30, 107k in the
   * last week. Raw rows cannot be kept for the years a proof-of-play record is wanted for, and
   * cutting retention alone throws the record away. So: keep raw briefly, aggregate before pruning.
   *
   * ⚠️ THE BUCKET IS AN HOUR, IN UTC, AND BOTH HALVES OF THAT MATTER.
   *
   * UTC because the rollup must be idempotent (recompute + upsert, safe to rerun) and a
   * device-local bucket is not: devices.reported_timezone is mutable and NULL for 46% of the
   * fleet, so recomputing an old day could place its rows in a DIFFERENT bucket than the one
   * already written — duplicating some rows and orphaning others. DST would also make some local
   * days 23 or 25 hours, quietly distorting per-day SUM(duration_sec).
   *
   * HOURLY rather than daily because an hour can still be re-bucketed into any timezone at query
   * time, and a day cannot. Once raw is pruned a daily bucket has permanently chosen a timezone
   * for data nobody can recompute. Hourly costs ~13x more rows than daily (2,384/day vs 183/day
   * measured on production) and is still ~108 MB per YEAR against 3.37 GB of raw.
   *
   * ⚠️ workspace_id IS PART OF THE KEY, AND IT IS READ FROM play_logs, NOT FROM devices.
   *
   * The first draft carried it as a payload column resolved by joining devices at rollup time.
   * That is cross-tenant leakage: a reseller moving a display from client A's workspace to client
   * B's would, on the next recompute, re-attribute A's historical plays to B — they appear in B's
   * reports and vanish from A's, silently, with no way to tell it happened. Devices move between
   * client workspaces as a matter of course, so this is routine rather than hypothetical.
   *
   * So play_logs carries its own workspace_id, snapshotted from the device at INSERT time and
   * never updated. Where a play happened is a fact about the past; it does not change because the
   * hardware was reassigned afterwards.
   *
   * NOT NULL with a '' sentinel rather than a nullable column: SQLite permits NULLs in a non-
   * INTEGER PRIMARY KEY, and two NULLs do not compare equal, so a nullable workspace in the key
   * would let the same (device, content, hour) insert unboundedly many duplicate rows instead of
   * upserting — defeating the idempotency this table exists to guarantee.
   */
  `CREATE TABLE IF NOT EXISTS play_log_hourly (
    device_id      TEXT NOT NULL,
    content_id     TEXT NOT NULL DEFAULT '',
    hour_utc       INTEGER NOT NULL,
    workspace_id   TEXT NOT NULL DEFAULT '',
    content_name   TEXT,
    play_count     INTEGER NOT NULL DEFAULT 0,
    duration_sec   INTEGER NOT NULL DEFAULT 0,
    first_play     INTEGER,
    last_play      INTEGER,
    PRIMARY KEY (workspace_id, device_id, content_id, hour_utc)
  )`,
  // Reports scan a time range and then group; the range is the selective part, exactly as
  // idx_play_logs_time is for raw.
  'CREATE INDEX IF NOT EXISTS idx_play_log_hourly_time ON play_log_hourly(hour_utc)',

  /*
   * How far the rollup has been computed. Raw rows are NEVER pruned past this watermark, which is
   * what makes "aggregate before you delete" an invariant rather than an ordering convention.
   *
   * An hour with no plays produces no rollup row, so presence-of-rows cannot serve as the marker —
   * a quiet hour would be unprunable for ever. The watermark records the hour itself.
   */
  `CREATE TABLE IF NOT EXISTS play_log_rollup_state (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    rolled_through_hour INTEGER NOT NULL DEFAULT 0,
    updated_at          INTEGER NOT NULL DEFAULT 0
  )`,
  'INSERT OR IGNORE INTO play_log_rollup_state (id, rolled_through_hour, updated_at) VALUES (1, 0, 0)',

  /*
   * ⚠️ DROP idx_play_logs_content — 263 MB serving nothing.
   *
   * Verified on production 2026-09-29 rather than assumed: EXPLAIN QUERY PLAN on every report
   * (by-content, by-device, by-hour, by-day, the CSV export) and on the prune sweep chooses
   * idx_play_logs_time. The by-content report GROUPs BY content_id but FILTERS on started_at, so
   * it never leads on this index. A grep across routes, lib and play-backfill finds no query that
   * filters play_logs on content_id at all; the backfill joins TO content on content's own key.
   *
   * ⚠️ Rebuilding it is not cheap if this is ever reversed: the 2.0.1 note above records an index
   * build on this table sitting in uninterruptible disk sleep for more than five minutes on a
   * spinning disk, and the table is 3x larger now. With the rollup in place the per-content report
   * has an aggregate to read instead, so it should not need to come back.
   */
  'DROP INDEX IF EXISTS idx_play_logs_content',
  /*
   * #473 v2: one row per visitor session on an interactive web page (Reports > Interactive
   * sessions). client_id is the player's own record id, UNIQUE per device, so a batch the player
   * resends after a lost ack is ignored rather than counted twice. workspace_id is snapshotted at
   * insert, like play_logs, so moving a screen later does not move its history. Pruned on
   * config.playLogRetentionDays (services/heartbeat).
   */
  `CREATE TABLE IF NOT EXISTS kiosk_sessions (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id    TEXT NOT NULL,
     workspace_id TEXT,
     widget_id    TEXT,
     client_id    TEXT NOT NULL,
     started_at   INTEGER NOT NULL,
     duration_sec INTEGER NOT NULL,
     end_reason   TEXT,
     pages        INTEGER,
     received_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     UNIQUE (device_id, client_id)
   )`,
  'CREATE INDEX IF NOT EXISTS idx_kiosk_sessions_ws_time ON kiosk_sessions(workspace_id, started_at)',
  'CREATE INDEX IF NOT EXISTS idx_kiosk_sessions_time ON kiosk_sessions(started_at)',
  /*
   * Hosted AI image credits (lib/ai-credits.js, docs/ai-credits.md). ORG-scoped: organizations are
   * the billing container. Entirely separate from device_usage_daily / lib/billing.js, which it
   * only ever READS to size the included allotment.
   *
   * ai_credit_ledger is APPEND-ONLY: balance = SUM(delta_credits) per bucket. `bucket` keeps
   * included credits (expire at the end of `period`, a UTC YYYY-MM) apart from purchased ones
   * (never expire). The unique index makes a month's included top-up and a Stripe fulfilment
   * idempotent by `ref`; debits/refunds carry the reservation id and may repeat it (one row per
   * bucket touched). No prompt text is stored here — prompts can carry customer content.
   */
  `CREATE TABLE IF NOT EXISTS ai_credit_ledger (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     org_id TEXT NOT NULL,
     delta_credits INTEGER NOT NULL,
     reason TEXT NOT NULL CHECK (reason IN ('grant_included','purchase','admin_adjust','image_debit','image_refund')),
     bucket TEXT NOT NULL CHECK (bucket IN ('included','purchased')),
     period TEXT,
     provider TEXT, model TEXT, resolution TEXT, quality TEXT,
     provider_cost_usd_micros INTEGER, charge_usd_micros INTEGER,
     ref TEXT, user_id TEXT, workspace_id TEXT,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
  'CREATE INDEX IF NOT EXISTS idx_ai_credit_ledger_org ON ai_credit_ledger(org_id, bucket, period)',
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_credit_ledger_once ON ai_credit_ledger(org_id, reason, ref) WHERE reason IN ('grant_included','purchase') AND ref IS NOT NULL",
  // Append-only in fact, not just in intent: a ledger row is never edited. (DELETE stays possible
  // so an organization's deletion can still remove its own rows.)
  `CREATE TRIGGER IF NOT EXISTS trg_ai_credit_ledger_no_update BEFORE UPDATE ON ai_credit_ledger
     BEGIN SELECT RAISE(ABORT, 'ai_credit_ledger is append-only'); END`,
  /*
   * One row per hosted generation ATTEMPT, written in the same transaction as its debit, BEFORE the
   * provider is called. So a crash can never leave a charge without an attempt record: a row stuck
   * in 'pending' is a crashed attempt and the sweep refunds it. UNIQUE(org_id, idempotency_key) is
   * what makes a retried request charge once.
   */
  `CREATE TABLE IF NOT EXISTS ai_credit_reservations (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL, workspace_id TEXT, user_id TEXT,
     idempotency_key TEXT NOT NULL,
     provider TEXT NOT NULL, model TEXT NOT NULL, resolution TEXT NOT NULL, quality TEXT NOT NULL,
     credits INTEGER NOT NULL, from_included INTEGER NOT NULL, from_purchased INTEGER NOT NULL,
     included_period TEXT,
     provider_cost_usd_micros INTEGER NOT NULL, charge_usd_micros INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('pending','committed','released')),
     content_id TEXT, error TEXT, error_status INTEGER,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')), updated_at INTEGER,
     UNIQUE (org_id, idempotency_key))`,
  "CREATE INDEX IF NOT EXISTS idx_ai_credit_reservations_pending ON ai_credit_reservations(status, created_at)",
  /*
   * Storage backends (lib/storage, docs/storage.md). ALL ADDITIVE: an old database boots with these
   * tables empty and every content row keeps meaning "a file in contentDir", because absence of a
   * content_locations row IS that meaning. Nothing is backfilled at boot — a million-row library
   * must not gain a million location rows to say what it already said.
   *
   * storage_profiles: where bytes can live. org_id NULL is the instance default row (at most one —
   * and env still wins over it, see lib/storage/index.js). credentials_enc is a secretbox blob;
   * credentials_hint is the last 4 of the key id, the only part ever shown back.
   * manage_scope is what ScreenTinker may WRITE or DELETE there: 'st' = only under the st/ prefix
   * (a write profile), 'none' = nothing (a bucket attached for reference), 'all' = the operator
   * confirmed a destructive import. Enforced in the backend wrapper, not just the UI.
   */
  `CREATE TABLE IF NOT EXISTS storage_profiles (
     id TEXT PRIMARY KEY,
     org_id TEXT,
     name TEXT NOT NULL,
     provider TEXT NOT NULL CHECK (provider IN ('local','s3','azure')),
     bucket TEXT,
     endpoint TEXT, public_endpoint TEXT, public_base_url TEXT,
     region TEXT, prefix TEXT,
     force_path_style INTEGER,
     credentials_enc TEXT, credentials_hint TEXT,
     mode TEXT NOT NULL DEFAULT 'rw' CHECK (mode IN ('rw','ro')),
     manage_scope TEXT NOT NULL DEFAULT 'st' CHECK (manage_scope IN ('none','st','all')),
     read_priority INTEGER NOT NULL DEFAULT 100,
     presign INTEGER NOT NULL DEFAULT 1,
     allow_private INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_profiles_name ON storage_profiles(COALESCE(org_id, ''), name)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_profiles_instance ON storage_profiles(COALESCE(org_id, '')) WHERE org_id IS NULL",
  /*
   * Every copy of a content row's bytes. role: primary (preferred read, and where it was written),
   * replica (a verified extra copy), draining (do not write here; still READ here). kind separates
   * the asset from its thumbnail, subtitle and retained revision copies, which travel with it.
   * owned = 1 when ScreenTinker wrote the object; a reference import is 0 and is never deleted.
   * storage_profile_id NULL = local contentDir, and then object_key is the basename.
   * ref is set on kind = 'history' only: the revisions.file_ref / thumb_ref that names this copy.
   */
  `CREATE TABLE IF NOT EXISTS content_locations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     content_id TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'asset' CHECK (kind IN ('asset','thumb','subtitle','history')),
     storage_profile_id TEXT,
     object_key TEXT,
     role TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary','replica','draining')),
     state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('pending','ready','error')),
     owned INTEGER NOT NULL DEFAULT 1,
     byte_digest TEXT, size INTEGER,
     verified_at INTEGER, last_error TEXT, last_error_at INTEGER,
     ref TEXT,
     created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_content_locations_unique ON content_locations(content_id, COALESCE(storage_profile_id, ''), COALESCE(object_key, ''))",
  'CREATE INDEX IF NOT EXISTS idx_content_locations_object ON content_locations(storage_profile_id, object_key)',
  'CREATE INDEX IF NOT EXISTS idx_content_locations_digest ON content_locations(storage_profile_id, byte_digest)',
  // A denormalized pointer at the current primary, for old queries. content_locations is the truth.
  'ALTER TABLE content ADD COLUMN storage_profile_id TEXT',
  'ALTER TABLE content ADD COLUMN object_key TEXT',
  // The /uploads/content/<name> miss path looks a row up by its basename; without these that is a scan per request.
  'CREATE INDEX IF NOT EXISTS idx_content_filepath ON content(filepath)',
  'CREATE INDEX IF NOT EXISTS idx_content_thumbnail_path ON content(thumbnail_path)',
  // May screens fetch presigned bucket URLs directly? NULL = default (yes, when a public endpoint
  // exists). The workspace and organization columns are added after the multitenancy phase below.
  'ALTER TABLE devices ADD COLUMN storage_direct_fetch INTEGER',
  /*
   * A live migration's progress, in SQLite so a restart resumes from `cursor` instead of starting
   * over — and so a restart can never flip a primary or delete a source by itself: only commit and
   * drain do that, and both are operator actions. One active (copying / ready_to_commit) per org.
   */
  `CREATE TABLE IF NOT EXISTS storage_migrations (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL,
     target_profile_id TEXT,
     previous_profile_id TEXT,
     state TEXT NOT NULL CHECK (state IN ('copying','ready_to_commit','committed','draining','done','aborted')),
     cursor TEXT,
     total INTEGER NOT NULL DEFAULT 0,
     copied INTEGER NOT NULL DEFAULT 0,
     verified INTEGER NOT NULL DEFAULT 0,
     failed INTEGER NOT NULL DEFAULT 0,
     skipped INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
     committed_at INTEGER)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_migrations_active ON storage_migrations(org_id) WHERE state IN ('copying','ready_to_commit')",
];
// Apply each ALTER idempotently. A "duplicate column name" / "already exists"
// error means the column is already present (expected on a migrated DB) - benign.
// ANY OTHER error is a real, partial-migration failure: log it loudly so it's
// visible at boot rather than as a silent runtime failure later (issue #37, where
// a swallowed failure left users.must_change_password absent -> total auth lockout).
/*
 * 2.0.1 — SAY SOMETHING BEFORE BUILDING AN INDEX ON play_logs.
 *
 * ⚠️ THE 2.0.0 FIELD REPORT. On a 73-device install on a Synology DS225+ (spinning SATA), the
 * idx_play_logs_open build below sat in uninterruptible disk sleep for **more than five minutes**
 * and printed NOTHING. From outside — no log line, no CPU, an unkillable process — the upgrade was
 * indistinguishable from a hang, and the natural operator response to a hang is to kill it, which
 * is the one thing that must not happen in the middle of a migration.
 *
 * The index is not the problem: it is the #307 fix and it takes as long as the disk takes. The
 * silence was the problem. A row estimate and a warning up front make the wait legible, and the
 * duration afterwards makes "slow disk" visible alongside the loop-lag band and shed lines.
 *
 * ⚠️ WHY THERE IS NO PROGRESS DURING THE BUILD. `db.exec` is one synchronous call into SQLite; the
 * event loop is inside it for the whole build, so no timer, interval or async log can fire until it
 * returns. There is no honest "45% done" to print from here — the choice is a line before and a
 * line after, or nothing. Do not add a timer here expecting it to run.
 */
const PLAYS_RE = /\bplay_logs\b/i;
let _playsMigrationTouched = false;

function _indexExists(name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
  } catch { return false; }
}

/*
 * An ESTIMATE, and deliberately so: MAX(rowid) is an index seek to the last row, while COUNT(*) is
 * a full scan of the table we are about to make the operator wait on. Over-counts by whatever has
 * been deleted, which is the right direction for a "this may take a while" warning.
 */
function _estimateRows(table) {
  try {
    const r = db.prepare(`SELECT MAX(rowid) AS n FROM ${table}`).get();
    return (r && r.n) || 0;
  } catch { return 0; }
}

/** Anything past this on one statement is the disk, not the query — surface it at warn. */
const SLOW_STATEMENT_MS = 2000;
/** Above this many rows an index build is worth warning about before it starts, not just logging. */
const LOUD_INDEX_ROWS = 50000;

let _migApplied = 0;
for (const sql of migrations) {
  // Only a successful ADD COLUMN means a genuinely-new column (it would throw
  // "duplicate column" if it already existed). UPDATE/index statements always
  // succeed, so they must NOT count toward "new migrations applied" or the boot
  // would falsely report work on every healthy start.
  const isAddColumn = /alter\s+table\s+\S+\s+add\s+column/i.test(sql);
  const touchesPlays = PLAYS_RE.test(sql);

  // An index that already exists is a no-op statement, so only announce a build that will happen.
  const indexName = touchesPlays
    ? (sql.match(/create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+(\w+)/i) || [])[1]
    : undefined;
  const buildingIndex = !!indexName && !_indexExists(indexName);
  if (buildingIndex) {
    // Always say the build is starting; only SHOUT when the table is big enough for the wait to be
    // mistaken for a hang. A fresh install builds these over zero rows and should not be alarmed.
    const est = _estimateRows('play_logs');
    const head = `[migrate] building ${indexName} over ~${est} play_logs row(s)`;
    if (est >= LOUD_INDEX_ROWS) {
      console.warn(
        `${head}. This is ONE synchronous statement: on spinning disks it can take minutes, during ` +
        `which the process serves nothing and looks wedged. It is not. Do not kill it.`
      );
    } else {
      console.log(head);
    }
  }

  const t0 = Date.now();
  let ok = false;
  try {
    db.exec(sql);
    ok = true;
    if (isAddColumn) _migApplied++;
  } catch (e) {
    if (!/duplicate column name|already exists/i.test(e.message)) {
      console.error(`[migrate] FAILED: ${sql}\n          -> ${e.message}`);
    }
  }
  const ms = Date.now() - t0;

  if (buildingIndex && ok) {
    const line = `[migrate] built ${indexName} in ${ms}ms`;
    if (ms > SLOW_STATEMENT_MS) console.warn(`${line} — slow storage (>${SLOW_STATEMENT_MS}ms for one statement)`);
    else console.log(line);
  }
  /*
   * Did THIS boot do work on the plays table? The answer arms the 2.0.1 player defer
   * (lib/boot-defer.js) — a cold index plus, on the installs this matters for, a large open-play
   * backlog behind it. A healthy restart sets nothing here and pays for none of it.
   */
  if (ok && touchesPlays && (buildingIndex || isAddColumn)) _playsMigrationTouched = true;
}
if (_migApplied > 0) console.log(`[migrate] applied ${_migApplied} new column migration(s)`);

/*
 * Say something when per-org SSO domains predate the proof requirement.
 *
 * Domains used to be a comma list an admin typed, and that list routed logins. They now route only
 * once DNS proves them, so on an instance upgraded from an earlier build of this feature every one
 * of those domains silently stops working — the provider still says "enabled", the typed list is
 * still on screen, and every federated user in that organization is locked out with no self-service
 * way back.
 *
 * They are deliberately NOT auto-claimed. A claim now notifies the operator, reserves the name
 * against other tenants and starts an 8-hour clock; manufacturing all of that on an admin's behalf,
 * for domains nobody ever proved, is not a migration's decision to make. So: name them, loudly,
 * once per boot, and let an admin re-add the ones they still want.
 */
try {
  const stranded = db.prepare(`
    SELECT p.slug, p.name, p.organization_id, p.email_domains
      FROM org_sso_providers p
     WHERE p.email_domains != ''
       AND NOT EXISTS (SELECT 1 FROM org_sso_domains d WHERE d.provider_id = p.id)
  `).all();
  if (stranded.length) {
    console.warn(`[migrate] ⚠️  ${stranded.length} SSO provider(s) have typed domains that were never verified.`);
    console.warn('[migrate]    Domains now route only after a DNS TXT record proves them, so these route NOBODY:');
    for (const r of stranded) {
      console.warn(`[migrate]      ${r.name} (${r.slug}, org ${r.organization_id}): ${r.email_domains}`);
    }
    console.warn('[migrate]    Re-add each domain in Settings to get its record, then Verify. See README, "Proving a domain".');
  }
} catch (e) {
  // The table may not exist yet on a first boot; that is not a problem worth a stack trace.
  if (!/no such table/i.test(e.message)) console.error('[migrate] SSO domain check failed:', e.message);
}

// #74/#75 per-item schedules: the playlist_item_schedules table is created
// idempotently by schema.sql (CREATE TABLE IF NOT EXISTS, run every boot, so it
// self-applies on upgrade). Record it in schema_migrations for observability.
try { db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('phase7_playlist_item_schedules')").run(); } catch { /* schema_migrations not ready yet */ }

// Public API tokens: api_tokens table is created idempotently by schema.sql.
try { db.prepare("INSERT OR IGNORE INTO schema_migrations (id) VALUES ('phase8_api_tokens')").run(); } catch { /* schema_migrations not ready yet */ }

// One-time: treat every CURRENTLY-offline device as already-alerted for its outage, so
// upgrading to per-outage alerting doesn't itself send a round of "your display is
// offline" mail for outages the owner was already told about. Must run exactly once —
// hence schema_migrations rather than the migrations array, which re-runs every boot.
try {
  const ID = 'offline_alert_per_outage_backfill';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID)) {
    const n = db.prepare(`UPDATE devices SET offline_alert_heartbeat = last_heartbeat
                          WHERE status = 'offline' AND last_heartbeat IS NOT NULL`).run().changes;
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(ID);
    if (n > 0) console.log(`[migrate] offline-alert backfill: ${n} device(s) marked as already-alerted`);
  }
} catch { /* schema_migrations or column not ready yet; next boot retries */ }

// Content-only schedules invent a throwaway one-item "Scheduled: ..." playlist, but the insert
// historically omitted is_auto_generated, so the Playlists page "Show auto-generated" toggle
// (which filters on that flag) could never hide them. New rows are flagged at insert time
// (createAutoGeneratedPlaylist in lib/auto-playlist.js); this one-shot backfills pre-existing rows.
// Structural selector (the schedule's own playlist_id), never the display name, since names are
// user-editable in both directions. Must run exactly once -> schema_migrations, not the array.
try {
  const ID = 'backfill_scheduled_playlists_auto_generated_v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(ID)) {
    const n = require('../lib/auto-playlist').backfillScheduledPlaylists(db);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(ID);
    if (n > 0) console.log(`[migrate] flagged ${n} Scheduled playlist(s) as auto-generated`);
  }
} catch { /* schema_migrations or table not ready yet; next boot retries */ }

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

/*
 * Wall schedules: schedules.wall_id, and the CHECK widened from "a device XOR a group" to "exactly
 * one of a device, a group, a wall". SQLite cannot alter a CHECK, so the table is rebuilt — from
 * its OWN current CREATE text, so every column added since phase 4 (workspace_id, …) survives
 * untouched, and its indexes and triggers are put back (the mesh replication triggers are also
 * re-created at boot by ensureTriggers). A table whose CHECK is not the one we know is left alone
 * and logged: wall schedules are refused there rather than risk a boot on a guessed rewrite.
 */
function migrateWallSchedules(conn = db) {
  const db = conn;   // a parameter so a test can run it against an old-shaped database
  const cols = db.prepare('PRAGMA table_info(schedules)').all();
  if (!cols.length) return;
  // ⚠️ The index lives HERE, not in schema.sql: schema.sql runs on every boot before this, and on an
  // existing database an index on a column that does not exist yet would fail the whole boot.
  if (cols.some((c) => c.name === 'wall_id')) { db.exec('CREATE INDEX IF NOT EXISTS idx_schedules_wall ON schedules(wall_id, enabled)'); return; }
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schedules'").get();
  const OLD_CHECK = /CHECK\s*\(\s*\(device_id IS NOT NULL AND group_id IS NULL\)\s*OR\s*\(device_id IS NULL AND group_id IS NOT NULL\)\s*\)/;
  if (!row || !OLD_CHECK.test(row.sql) || !/^CREATE TABLE\s+"?schedules"?\s*\(/.test(row.sql)) {
    console.error('[migrate] wall schedules: the schedules table is not the shape expected — left as is, wall schedules unavailable');
    return;
  }
  const createSql = row.sql
    .replace(/^CREATE TABLE\s+"?schedules"?/, 'CREATE TABLE schedules_wall_new')
    .replace(OLD_CHECK, "wall_id TEXT REFERENCES video_walls(id) ON DELETE CASCADE,\n    CHECK ((device_id IS NOT NULL) + (group_id IS NOT NULL) + (wall_id IS NOT NULL) = 1)");
  const keep = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'schedules' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all().map((r) => r.sql);
  const names = cols.map((c) => `"${c.name}"`).join(', ');
  db.transaction(() => {
    db.exec(createSql);
    db.exec(`INSERT INTO schedules_wall_new (${names}) SELECT ${names} FROM schedules`);
    db.exec('DROP TABLE schedules');
    db.exec('ALTER TABLE schedules_wall_new RENAME TO schedules');
    for (const sql of keep) db.exec(sql);
    db.exec('CREATE INDEX IF NOT EXISTS idx_schedules_wall ON schedules(wall_id, enabled)');
  })();
  console.log(`[migrate] wall schedules: schedules table rebuilt with wall_id (${cols.length} columns kept)`);
}
migrateWallSchedules();

/*
 * Audience buckets: `segment` and `observed_ms` (docs/audience-counting.md, lib/audience.js).
 * A player restarting its counter inside a minute sends a second, partial bucket for that minute
 * under a new segment number, so the uniqueness key gains `segment` — and SQLite cannot alter a
 * table's UNIQUE constraint, so the table is rebuilt from its OWN current CREATE text with only
 * that clause changed (the same way as migrateWallSchedules above), its indexes put back. A row
 * from before the change is segment 0 and was observed for its whole bucket. Called where the
 * table is created, below; a parameter so a test can run it on an old-shaped database.
 */
function migrateAudienceSegments(conn = db) {
  const db = conn;
  const cols = db.prepare('PRAGMA table_info(audience_buckets)').all().map((c) => c.name);
  if (!cols.length) return;
  if (!cols.includes('segment')) db.exec('ALTER TABLE audience_buckets ADD COLUMN segment INTEGER NOT NULL DEFAULT 0');
  // ⚠️ ONE transaction: the column's DEFAULT is 60000, so a crash between the ALTER and the
  // back-fill would leave 30-second buckets claiming a full minute for good — the next boot sees
  // the column and never back-fills. SQLite DDL is transactional, so both land or neither does.
  if (!cols.includes('observed_ms')) {
    db.transaction(() => {
      db.exec('ALTER TABLE audience_buckets ADD COLUMN observed_ms INTEGER NOT NULL DEFAULT 60000');
      db.exec('UPDATE audience_buckets SET observed_ms = bucket_sec * 1000');
    })();
  }
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audience_buckets'").get();
  const OLD_UNIQUE = /UNIQUE\s*\(\s*device_id\s*,\s*bucket_start\s*,\s*item_kind\s*,\s*item_id\s*\)/;
  if (!row || !OLD_UNIQUE.test(row.sql)) return;   // already keyed on segment (or a fresh install)
  if (!/^CREATE TABLE\s+"?audience_buckets"?\s*\(/.test(row.sql)) {
    console.error('[migrate] audience segments: audience_buckets is not the shape expected — left as is');
    return;
  }
  const createSql = row.sql
    .replace(/^CREATE TABLE\s+"?audience_buckets"?/, 'CREATE TABLE audience_buckets_seg_new')
    .replace(OLD_UNIQUE, 'UNIQUE (device_id, bucket_start, item_kind, item_id, segment)');
  const keep = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'audience_buckets' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all().map((r) => r.sql);
  const names = db.prepare('PRAGMA table_info(audience_buckets)').all().map((c) => `"${c.name}"`).join(', ');
  db.transaction(() => {
    db.exec(createSql);
    db.exec(`INSERT INTO audience_buckets_seg_new (${names}) SELECT ${names} FROM audience_buckets`);
    db.exec('DROP TABLE audience_buckets');
    db.exec('ALTER TABLE audience_buckets_seg_new RENAME TO audience_buckets');
    for (const sql of keep) db.exec(sql);
  })();
  console.log('[migrate] audience segments: audience_buckets rebuilt, unique on (device, minute, item, segment)');
}

/*
 * `organizations.sso_only` — added HERE, not in the migrations array above.
 *
 * That array runs BEFORE ensureMultitenancyMigration(), which is what creates the organizations
 * table, so on a fresh install the ALTER hit a table that did not exist yet: `[migrate] FAILED …
 * no such table: organizations`, one console.error among ~85 migration lines. The instance then
 * ran its entire first boot with the SSO settings screen 500ing and — far worse —
 * ssoOnlyForEmail() catching `no such column` and returning "not SSO-only", which is password
 * login proceeding for an organization that had switched it off. It self-healed on the second
 * boot, which is exactly what makes it easy to miss.
 */
try {
  const orgCols = db.prepare('PRAGMA table_info(organizations)').all().map((c) => c.name);
  if (orgCols.length && !orgCols.includes('sso_only')) {
    db.exec('ALTER TABLE organizations ADD COLUMN sso_only INTEGER NOT NULL DEFAULT 0');
    console.log('[migrate] added organizations.sso_only');
  }
} catch (e) {
  console.error('[migrate] could not add organizations.sso_only:', e.message);
}

/*
 * Two more that once sat in the migrations array and hit the same wall on a fresh install: they
 * need what the multi-tenancy phase creates (organizations; devices.workspace_id), so each printed
 * a `[migrate] FAILED` line on first boot. Both are guarded on what they touch rather than on
 * error text, so neither a fresh nor an upgraded install logs anything when there is nothing to do.
 *
 * organizations.widget_sandbox_isolation_disabled: a fresh install already has it (the
 * multi-tenancy script's CREATE TABLE carries it); an organizations table from before it gains it.
 */
try {
  const orgCols = db.prepare('PRAGMA table_info(organizations)').all().map((c) => c.name);
  if (orgCols.length && !orgCols.includes('widget_sandbox_isolation_disabled')) {
    db.exec('ALTER TABLE organizations ADD COLUMN widget_sandbox_isolation_disabled INTEGER NOT NULL DEFAULT 0');
    console.log('[migrate] added organizations.widget_sandbox_isolation_disabled');
  }
} catch (e) {
  console.error('[migrate] could not add organizations.widget_sandbox_isolation_disabled:', e.message);
}

/*
 * Repair for schedules orphaned by a group deletion before the conversion carried workspace_id.
 * Such rows are invisible (list/calendar filter on workspace), undeletable (PUT/DELETE 403 on a
 * null workspace) and still firing (the scheduler has no workspace filter) — so an operator
 * cannot fix them from the dashboard at all. Recover the workspace from the device the schedule
 * targets; anything still unresolvable is left alone rather than guessed at. Runs every boot; a
 * healthy database matches no rows.
 */
try {
  const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
  if (hasCol('schedules', 'workspace_id') && hasCol('devices', 'workspace_id')) {
    db.exec(`UPDATE schedules SET workspace_id = (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id)
       WHERE workspace_id IS NULL AND device_id IS NOT NULL
         AND (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id) IS NOT NULL`);
  }
} catch (e) {
  console.error('[migrate] orphaned-schedule workspace repair failed:', e.message);
}

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
    copyFileBytes(config.dbPath, snapshotPath);
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
    copyFileBytes(config.dbPath, snapshotPath);
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

// #146 hardening — device_status_log retention sweep, rewritten to NEVER block the
// loop. The old version ran a WHOLE-TABLE `ROW_NUMBER() OVER (PARTITION BY device_id)`
// sort — 40-48s synchronous on the 1.1M-row incident table, freezing boot into a
// restart loop (the #146 amplifier). Now:
//   - PER DEVICE, walking distinct device_ids via a loose index-scan seek
//     (`WHERE device_id > ? ORDER BY device_id LIMIT 1` — an O(log n) index seek each),
//     so no statement scans or sorts the whole table;
//   - each device's backlog trims in bounded batches (rowid IN (SELECT ... LIMIT ?))
//     with a setImmediate yield between batches AND between devices (chunked-prune.js);
//   - async + re-entrancy-guarded so overlapping interval fires don't stack;
//   - band-gated on the INTERVAL (skip while loaded), un-gated at STARTUP so a bloated
//     table self-heals on next deploy without a restart.
// Rides idx_device_status_log_device_ts(device_id, timestamp).
let _statusPruneRunning = false;
let _lastPrune = { deleted: 0, ms: 0, at: 0 };        // #146 P3.8: soak observability
let _sweepsTotal = 0;                                 // #146: prune sweeps completed (confirm it's firing, not stalled)
function getMaintenanceStats() { return { ..._lastPrune, running: _statusPruneRunning, sweepsTotal: _sweepsTotal }; }
async function pruneStatusLog(opts = {}) {
  if (_statusPruneRunning) return 0;                  // re-entrancy: work runs once
  if (opts.bandGate && config.maintenanceBandGateEnabled && currentBand() !== 'normal') return 0;
  _statusPruneRunning = true;
  const _t0 = Date.now();
  try {
    const batch = config.statusLogPruneBatch;
    const cap = config.statusLogMaxRowsPerDevice;
    const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.statusLogRetentionDays * 86400);
    const nextDevice = db.prepare('SELECT device_id FROM device_status_log WHERE device_id > ? ORDER BY device_id LIMIT 1');
    const delOld = db.prepare('DELETE FROM device_status_log WHERE rowid IN (SELECT rowid FROM device_status_log WHERE device_id = ? AND timestamp < ? LIMIT ?)');
    const delCap = cap > 0 ? db.prepare('DELETE FROM device_status_log WHERE rowid IN (SELECT rowid FROM device_status_log WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?)') : null;

    let total = 0, lastDev = '';
    for (;;) {
      const row = nextDevice.get(lastDev);            // O(log n) index seek to next distinct device_id
      if (!row) break;
      lastDev = row.device_id;
      // 1) retention — drop rows older than the window, in batches
      total += (await chunkedDelete((lim) => delOld.run(lastDev, cutoff, lim).changes, { batch })).deleted;
      // 2) cap — drop rows beyond the newest `cap` (OFFSET cap skips the kept rows), in batches
      if (delCap) total += (await chunkedDelete((lim) => delCap.run(lastDev, lim, cap).changes, { batch })).deleted;
      await yieldTick();                              // breathe between devices
    }
    if (total > 0) console.log(`[status-log] pruned ${total} row(s) (per-device, newest ${cap}/device + ${config.statusLogRetentionDays}d retention, batches of ${batch})`);
    _lastPrune = { deleted: total, ms: Date.now() - _t0, at: Math.floor(Date.now() / 1000) };
    _sweepsTotal += 1;
    return total;
  } catch (_) { return 0; } finally { _statusPruneRunning = false; }
}

// Prune old telemetry (keep last 24h worth at 15s intervals = ~5760, cap at 6000).
// #146: BOUNDED single statement — delete at most statusLogPruneBatch rows beyond the
// newest 6000 (OFFSET 6000). Runs per-heartbeat (deviceSocket.js), so it keeps up
// incrementally; a post-downtime backlog trims over several heartbeats, never one giant
// DELETE. Rides idx_telemetry_device(device_id, reported_at DESC). Stays synchronous —
// it's a single index-bounded statement, well under the ~50ms invariant.
const _delTelemetry = db.prepare(
  'DELETE FROM device_telemetry WHERE rowid IN (SELECT rowid FROM device_telemetry WHERE device_id = ? ORDER BY reported_at DESC LIMIT ? OFFSET 6000)'
);
function pruneTelemetry(deviceId) {
  _delTelemetry.run(deviceId, config.statusLogPruneBatch);
}

// #240: the per-heartbeat cap above is the only thing that ever trimmed device_telemetry,
// and it only trims the device whose heartbeat is being handled — so a device that STOPS
// reporting (decommissioned, swapped, seasonally dark) leaves its rows behind forever and
// the table only ever grows. This is the matching age sweep, mirroring pruneStatusLog:
// per-device so it rides idx_telemetry_device(device_id, reported_at DESC) instead of
// scanning, chunked so a backlog trims across many bounded DELETEs, and yielding between
// devices so it can never own the loop.
//
// The retention default is deliberately LOOSER than the per-device cap (6000 rows ~= 25h
// for a device reporting every 15s) and matches the uptime report's default 30-day window,
// so this sweep cannot change a report that the row cap wasn't already truncating.
const _nextTelemetryDevice = db.prepare('SELECT device_id FROM device_telemetry WHERE device_id > ? ORDER BY device_id LIMIT 1');
const _delTelemetryOld = db.prepare('DELETE FROM device_telemetry WHERE rowid IN (SELECT rowid FROM device_telemetry WHERE device_id = ? AND reported_at < ? LIMIT ?)');
let _telemetryPruneRunning = false;
async function pruneTelemetryRetention(opts = {}) {
  if (_telemetryPruneRunning) return 0;
  if (opts.bandGate && config.maintenanceBandGateEnabled && currentBand() !== 'normal') return 0;
  _telemetryPruneRunning = true;
  try {
    const batch = config.statusLogPruneBatch;
    const cutoff = Math.floor(Date.now() / 1000) - Math.round(config.telemetryRetentionDays * 86400);
    let total = 0, lastDev = '';
    for (;;) {
      const row = _nextTelemetryDevice.get(lastDev);   // O(log n) seek to the next distinct device_id
      if (!row) break;
      lastDev = row.device_id;
      total += (await chunkedDelete((lim) => _delTelemetryOld.run(lastDev, cutoff, lim).changes, { batch })).deleted;
      await yieldTick();                                // breathe between devices
    }
    if (total > 0) console.log(`[telemetry] pruned ${total} row(s) older than ${config.telemetryRetentionDays}d (per-device, batches of ${batch})`);
    return total;
  } catch (_) { return 0; } finally { _telemetryPruneRunning = false; }
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

/*
 * The schema added by the later feature PRs, one NAMED step per feature. Each step is independent:
 * a statement that throws is logged under its own feature's name and skips only the rest of that
 * feature, never every table and column after it. (These all used to share one try whose catch
 * said "template-zone dedupe failed", so one bad statement silently dropped a dozen features and
 * blamed the wrong one.) Every step is idempotent and runs on every boot.
 */
function migrationStep(name, fn) {
  try { fn(); } catch (e) { console.error(`[migrate] ${name} failed:`, e.message); }
}

migrationStep('workspace and organization settings', () => {
  // workspaces is created by the multitenancy phase, after the migrations array above has run,
  // so its column is added here where the table exists. Idempotent: a duplicate column throws.
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0').run(); console.log('[migrate] workspaces.require_approval added (default off)'); } catch (_) { /* present */ }
  // Live video (go2rtc). Off by default at every level so enabling the sidecar never silently
  // starts streaming: server master gate (config.liveVideoEnabled) AND the workspace flag AND the
  // device flag must all be on. The publish secret is per device and rotatable, never the go2rtc
  // admin password. See docs/live-video.md and lib/go2rtc.js.
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN live_video_enabled INTEGER NOT NULL DEFAULT 0').run(); console.log('[migrate] workspaces.live_video_enabled added (default off)'); } catch (_) { /* present */ }
  // Scale-out C1 (docs/scale-out-design.md §3.3): NULL means "mine". Set on a copied workspace to
  // the node UUID of the primary that owns it — the ONE column that decides whether a write is
  // local or must go to the primary. replica_rev/replica_as_of record how far the copy is applied.
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN origin_node_id TEXT').run(); console.log('[migrate] workspaces.origin_node_id added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN replica_rev INTEGER').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN replica_as_of INTEGER').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE devices ADD COLUMN live_video_enabled INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* present */ }
  // #talk: per-org enablement for the voice intercom / PA feature (off by default).
  try { db.prepare('ALTER TABLE organizations ADD COLUMN talk_enabled INTEGER NOT NULL DEFAULT 0').run(); console.log('[migrate] organizations.talk_enabled added (default off)'); } catch (_) { /* present */ }
  // #talk/#go2rtc: optional per-org ICE (STUN/TURN) override as a JSON array [{urls,username?,credential?}].
  // NULL -> use the global go2rtc ice_servers. Lets an org bring its own TURN.
  try { db.prepare('ALTER TABLE organizations ADD COLUMN ice_servers TEXT').run(); console.log('[migrate] organizations.ice_servers added'); } catch (_) { /* present */ }
  // Storage backends (lib/storage): where NEW uploads in this org go (NULL = instance default;
  // changing it never re-homes existing rows), and whether a workspace's screens may fetch
  // presigned bucket URLs directly (NULL = yes, when a reachable endpoint exists).
  try { db.prepare('ALTER TABLE organizations ADD COLUMN storage_profile_id TEXT').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN storage_direct_fetch INTEGER').run(); } catch (_) { /* present */ }
  // Per-workspace storage: the workspace's own override for new uploads (NULL = follows its
  // organization), a profile owned by one workspace (visible to it alone), whether the org lets
  // workspace admins choose (default off: where a tenant's bytes live is the organization's call),
  // and the scope of a migration (NULL = org-wide, skipping workspaces that have an override).
  try { db.prepare('ALTER TABLE workspaces ADD COLUMN storage_profile_id TEXT').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE storage_profiles ADD COLUMN workspace_id TEXT').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE organizations ADD COLUMN storage_workspace_choice INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE storage_migrations ADD COLUMN workspace_id TEXT').run(); } catch (_) { /* present */ }
});

migrationStep('smart playlists', () => {
  // Smart playlists (lib/smart-playlist.js): JSON rule set; NULL = an ordinary hand-built playlist.
  try { db.prepare('ALTER TABLE playlists ADD COLUMN smart_rules TEXT').run(); console.log('[migrate] playlists.smart_rules added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE playlists ADD COLUMN published_smart_rules TEXT').run(); } catch (_) { /* present */ }
  // "Play every N seconds" (lib/repeat-every.js): NULL = plays once per loop, as before.
  try { db.prepare('ALTER TABLE playlist_items ADD COLUMN repeat_every_sec INTEGER').run(); console.log('[migrate] playlist_items.repeat_every_sec added'); } catch (_) { /* present */ }
});

migrationStep('SAML', () => {
  // SAML 2.0 org providers (lib/saml.js). A SAML row keeps the IdP's entityID in `issuer` and an empty
  // client_id (both NOT NULL in the original table), so no rebuild is needed.
  try { db.prepare("ALTER TABLE org_sso_providers ADD COLUMN kind TEXT NOT NULL DEFAULT 'oidc'").run(); console.log('[migrate] org_sso_providers.kind added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE org_sso_providers ADD COLUMN saml_sso_url TEXT').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE org_sso_providers ADD COLUMN saml_cert TEXT').run(); } catch (_) { /* present */ }
  // Outstanding SAML AuthnRequest ids (lib/saml.js): the ACS accepts only a response to one of these,
  // once. In the database, not memory, so a scaled-out node can complete a login another began.
  db.exec('CREATE TABLE IF NOT EXISTS saml_requests (id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL)');
  // Assertion ids already consumed (lib/saml.js): a unique insert makes a replayed response fail even when two copies race.
  db.exec('CREATE TABLE IF NOT EXISTS saml_used_assertions (id TEXT PRIMARY KEY, used_at INTEGER NOT NULL)');
});

migrationStep('Microsoft 365 and cloud folders', () => {
  /*
   * Microsoft 365 (lib/m365.js): an organization's own Entra app, for reading SharePoint/OneDrive.
   * The client secret is secretbox-encrypted and never returned by the API.
   */
  db.exec(`CREATE TABLE IF NOT EXISTS org_m365_apps (
    organization_id   TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    tenant_id         TEXT NOT NULL,
    client_id         TEXT NOT NULL,
    client_secret_enc TEXT,
    last_test_at      INTEGER,
    last_test_ok      INTEGER,
    last_error        TEXT,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  // SharePoint/OneDrive folder syncs (lib/cloud-folders.js): one folder into one workspace's library.
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_folders (
    id                   TEXT PRIMARY KEY,
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    organization_id      TEXT NOT NULL,
    user_id              TEXT,
    provider             TEXT NOT NULL DEFAULT 'm365',
    name                 TEXT NOT NULL,
    share_url            TEXT NOT NULL,
    drive_id             TEXT NOT NULL,
    item_id              TEXT NOT NULL,
    web_url              TEXT,
    playlist_id          TEXT,
    auto_playlist        INTEGER NOT NULL DEFAULT 1,
    interval_min         INTEGER NOT NULL DEFAULT 15,
    default_duration_sec INTEGER NOT NULL DEFAULT 10,
    enabled              INTEGER NOT NULL DEFAULT 1,
    last_sync_at         INTEGER,
    last_status          TEXT,
    last_error           TEXT,
    last_summary         TEXT,
    sync_lease_until     INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cloud_folders_ws ON cloud_folders(workspace_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_folder_items (
    folder_id  TEXT NOT NULL REFERENCES cloud_folders(id) ON DELETE CASCADE,
    remote_id  TEXT NOT NULL,
    content_id TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    tag        TEXT NOT NULL DEFAULT '',
    size       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (folder_id, remote_id)
  )`);
  // Content a sync created whose file has since left the folder, until it is out of the playlist and retired.
  db.exec(`CREATE TABLE IF NOT EXISTS cloud_folder_removed (
    folder_id  TEXT NOT NULL,
    content_id TEXT NOT NULL,
    PRIMARY KEY (folder_id, content_id)
  )`);
});

migrationStep('OTA rollouts', () => {
  // Health-checked player rollouts (lib/ota-rollout.js): waves, automatic halt, rollback package.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ota_rollouts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      family           TEXT NOT NULL,
      version          TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'rolling',
      wave             INTEGER NOT NULL DEFAULT 0,
      started_at       INTEGER NOT NULL,
      wave_started_at  INTEGER NOT NULL,
      completed_at     INTEGER,
      halted_at        INTEGER,
      halted_reason    TEXT,
      halted_by        TEXT,
      prev_version     TEXT,
      archive_path     TEXT,
      archive_filename TEXT,
      archive_sha256   TEXT,
      archive_size     INTEGER,
      UNIQUE (family, version)
    );
  `);
});

migrationStep('QR links', () => {
  // Tracked QR links (lib/qr-links.js): a short /q/<code> redirect that counts scans. A scan keeps a
  // time and a coarse platform only — no IP, no user agent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS qr_links (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id      TEXT,
      code         TEXT NOT NULL UNIQUE,
      name         TEXT NOT NULL,
      target_url   TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_qr_links_ws ON qr_links(workspace_id);
    CREATE TABLE IF NOT EXISTS qr_scans (
      link_id  TEXT NOT NULL REFERENCES qr_links(id) ON DELETE CASCADE,
      at       INTEGER NOT NULL,
      platform TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_qr_scans_link_at ON qr_scans(link_id, at);
  `);
});

migrationStep('local conditions', () => {
  // Where a screen is (lib/local-conditions.js): its local weather and area conditions.
  try { db.prepare('ALTER TABLE devices ADD COLUMN latitude REAL').run(); console.log('[migrate] devices.latitude added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE devices ADD COLUMN longitude REAL').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE devices ADD COLUMN location_label TEXT').run(); } catch (_) { /* present */ }
  db.exec('CREATE TABLE IF NOT EXISTS weather_cells (cell TEXT PRIMARY KEY, data TEXT NOT NULL, at INTEGER NOT NULL)');
});

migrationStep('alert channels', () => {
  // Alert channels (lib/alert-channels.js): Slack / Teams / PagerDuty / webhook / email per workspace.
  // Workspace-owned and FK-cascaded; alert_deliveries is the once-per-outage ledger.
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_channels (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id         TEXT,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      events          TEXT NOT NULL DEFAULT '["device_offline","device_online"]',
      offline_minutes INTEGER NOT NULL DEFAULT 5,
      enabled         INTEGER NOT NULL DEFAULT 1,
      last_sent_at    INTEGER,
      last_error      TEXT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alert_channels_ws ON alert_channels(workspace_id);
    CREATE TABLE IF NOT EXISTS alert_channel_scopes (
      channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL,
      scope_id   TEXT NOT NULL,
      PRIMARY KEY (channel_id, scope_kind, scope_id)
    );
    CREATE TABLE IF NOT EXISTS alert_deliveries (
      channel_id      TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
      device_id       TEXT NOT NULL,
      outage          INTEGER NOT NULL,
      offline_sent_at INTEGER,
      online_sent_at  INTEGER,
      attempts        INTEGER NOT NULL DEFAULT 0,
      online_attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, device_id, outage)
    );
  `);
});

migrationStep('Canva', () => {
  // Canva (lib/canva.js). An organization may bring its own Canva integration (else the instance's
  // CANVA_CLIENT_ID applies); each person connects their own Canva account to it. Secrets and
  // tokens are secretbox-encrypted. A link ties a library item to the Canva design page(s) it was
  // exported from, so it can be refreshed when the design changes. foreign_keys is OFF in
  // production, so content deletion clears links explicitly (routes/content.js purgeContentRow).
  db.exec(`
    CREATE TABLE IF NOT EXISTS canva_integrations (
      organization_id   TEXT PRIMARY KEY,
      client_id         TEXT NOT NULL,
      client_secret_enc TEXT,
      updated_by        TEXT,
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS canva_connections (
      user_id         TEXT NOT NULL,
      integration_key TEXT NOT NULL,
      canva_user_id   TEXT,
      display_name    TEXT,
      access_enc      TEXT NOT NULL,
      refresh_enc     TEXT,
      expires_at      INTEGER NOT NULL DEFAULT 0,
      scopes          TEXT,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, integration_key)
    );
    CREATE TABLE IF NOT EXISTS canva_links (
      content_id        TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      integration_key   TEXT NOT NULL,
      design_id         TEXT NOT NULL,
      design_title      TEXT,
      pages             TEXT NOT NULL,
      format            TEXT NOT NULL,
      design_updated_at INTEGER,
      last_synced_at    INTEGER,
      last_checked_at   INTEGER,
      last_error        TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_canva_links_ws ON canva_links(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_canva_links_design ON canva_links(design_id);
    CREATE TABLE IF NOT EXISTS canva_jobs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      error        TEXT,
      result       TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
});

migrationStep('BI connections', () => {
  // BI connections (lib/bi/connections.js): an organization's Grafana / Power BI / Tableau
  // credentials for the bi-dashboard widget. The secret is secretbox-encrypted and never returned.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bi_connections (
      id              TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by      TEXT,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      secret_enc      TEXT,
      allow_private   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bi_connections_org ON bi_connections(organization_id);
  `);
});

migrationStep('social walls', () => {
  // Social walls (lib/social/*): an organization's API credentials (Instagram, Facebook, YouTube, X),
  // a workspace's feeds (sources + moderation), the posts fetched for them, and their cached images.
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_connections (
      id               TEXT PRIMARY KEY,
      organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by       TEXT,
      kind             TEXT NOT NULL,
      name             TEXT NOT NULL,
      config           TEXT NOT NULL DEFAULT '{}',
      secret_enc       TEXT,
      token_expires_at INTEGER,
      token_refreshed_at INTEGER,
      last_error       TEXT,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_connections_org ON social_connections(organization_id);
    CREATE TABLE IF NOT EXISTS social_feeds (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      created_by    TEXT,
      name          TEXT NOT NULL,
      sources       TEXT NOT NULL DEFAULT '[]',
      moderation    TEXT NOT NULL DEFAULT 'auto',
      blocklist     TEXT NOT NULL DEFAULT '[]',
      require_media INTEGER NOT NULL DEFAULT 0,
      max_age_days  INTEGER NOT NULL DEFAULT 0,
      max_posts     INTEGER NOT NULL DEFAULT 20,
      refresh_min   INTEGER NOT NULL DEFAULT 10,
      enabled       INTEGER NOT NULL DEFAULT 1,
      next_fetch_at INTEGER NOT NULL DEFAULT 0,
      fail_count    INTEGER NOT NULL DEFAULT 0,
      last_fetch_at INTEGER,
      last_error    TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_feeds_ws ON social_feeds(workspace_id);
    CREATE TABLE IF NOT EXISTS social_posts (
      feed_id       TEXT NOT NULL,
      network       TEXT NOT NULL,
      post_id       TEXT NOT NULL,
      source_key    TEXT NOT NULL,
      status        TEXT NOT NULL,
      hidden_reason TEXT,
      author_name   TEXT,
      author_handle TEXT,
      author_avatar TEXT,
      text          TEXT,
      media         TEXT,
      is_video      INTEGER NOT NULL DEFAULT 0,
      permalink     TEXT,
      posted_at     INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      PRIMARY KEY (feed_id, network, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_posts_feed ON social_posts(feed_id, status, posted_at);
    CREATE TABLE IF NOT EXISTS social_media (
      hash         TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      mime         TEXT NOT NULL,
      bytes        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL
    );
  `);
  // A hash of what a post shows (lib/social/feeds.js contentHash): an edit at the source sends an
  // approved post back to review on an 'approve' feed. NULL on older rows = not known yet.
  try { db.prepare('ALTER TABLE social_posts ADD COLUMN content_hash TEXT').run(); } catch (_) { /* present */ }
});

migrationStep('audience counting', () => {
  /*
   * Audience counting (lib/audience.js, docs/audience-counting.md). Off unless the org allows it AND
   * a screen or one of its groups has it enabled. audience_buckets holds INTEGERS ONLY — counts per
   * screen per minute per item on screen — and no column could hold an image, a face or an identifier.
   */
  try { db.prepare('ALTER TABLE devices ADD COLUMN audience_enabled INTEGER NOT NULL DEFAULT 0').run(); console.log('[migrate] devices.audience_enabled added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE device_groups ADD COLUMN audience_enabled INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* present */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS audience_org_settings (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      allowed         INTEGER NOT NULL DEFAULT 0,
      show_indicator  INTEGER NOT NULL DEFAULT 1,
      fps             INTEGER NOT NULL DEFAULT 2,
      min_dwell_ms    INTEGER NOT NULL DEFAULT 1000,
      retention_days  INTEGER NOT NULL DEFAULT 90,
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS audience_buckets (
      device_id        TEXT NOT NULL,
      workspace_id     TEXT,
      bucket_start     INTEGER NOT NULL,
      bucket_sec       INTEGER NOT NULL,
      item_kind        TEXT NOT NULL,
      item_id          TEXT NOT NULL DEFAULT '',
      playlist_id      TEXT,
      present_max      INTEGER NOT NULL,
      present_avg_x100 INTEGER NOT NULL,
      arrivals         INTEGER NOT NULL,
      impressions      INTEGER NOT NULL,
      d0 INTEGER NOT NULL, d1 INTEGER NOT NULL, d2 INTEGER NOT NULL,
      d3 INTEGER NOT NULL, d4 INTEGER NOT NULL, d5 INTEGER NOT NULL,
      received_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      segment          INTEGER NOT NULL DEFAULT 0,
      observed_ms      INTEGER NOT NULL DEFAULT 60000,
      UNIQUE (device_id, bucket_start, item_kind, item_id, segment)
    );
    CREATE INDEX IF NOT EXISTS idx_audience_ws_time ON audience_buckets(workspace_id, bucket_start);
    CREATE INDEX IF NOT EXISTS idx_audience_time ON audience_buckets(bucket_start);
    -- Which client bucket ids are already stored, so a resend is idempotent even where two ids
    -- MERGE into one row (lib/audience.js ingest). A 48-bit hash of the id, never the id itself:
    -- integers only, like the buckets.
    CREATE TABLE IF NOT EXISTS audience_ingested (
      device_id    TEXT NOT NULL,
      bucket_start INTEGER NOT NULL,
      id_hash      INTEGER NOT NULL,
      PRIMARY KEY (device_id, bucket_start, id_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_audience_ingested_time ON audience_ingested(bucket_start);
  `);
  migrateAudienceSegments(db);
});

migrationStep('device tags and dynamic groups', () => {
  // Device tags (JSON array, lib/content-tags normalizer) and dynamic group rules
  // (lib/device-group-rules.js): NULL rules = a hand-built group, as before.
  try { db.prepare('ALTER TABLE devices ADD COLUMN tags TEXT').run(); console.log('[migrate] devices.tags added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE device_groups ADD COLUMN rules TEXT').run(); console.log('[migrate] device_groups.rules added'); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE device_settings ADD COLUMN tags TEXT').run(); } catch (_) { /* present */ }
});

migrationStep('device power source', () => {
  try { db.prepare("ALTER TABLE devices ADD COLUMN power_source TEXT DEFAULT 'battery'").run(); } catch (_) { /* present */ }
  try { db.prepare("ALTER TABLE device_telemetry ADD COLUMN power_source TEXT DEFAULT 'battery'").run(); } catch (_) { /* present */ }
});

migrationStep('CAP feeds', () => {
  // CAP emergency feeds (lib/cap/feeds.js). Workspace-owned and FK-cascaded, so deleting a
  // workspace takes its feeds, scopes and seen alerts with it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cap_feeds (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id        TEXT,
      name           TEXT NOT NULL,
      url            TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      poll_sec       INTEGER NOT NULL DEFAULT 120,
      min_severity   TEXT NOT NULL DEFAULT 'Severe',
      events         TEXT,
      area_match     TEXT,
      language       TEXT NOT NULL DEFAULT 'en',
      playlist_id    TEXT REFERENCES playlists(id) ON DELETE SET NULL,
      widget_id      TEXT,
      last_polled_at INTEGER,
      last_ok_at     INTEGER,
      last_error     TEXT,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cap_feeds_ws ON cap_feeds(workspace_id);
    CREATE TABLE IF NOT EXISTS cap_feed_scopes (
      feed_id    TEXT NOT NULL REFERENCES cap_feeds(id) ON DELETE CASCADE,
      scope_kind TEXT NOT NULL,
      scope_id   TEXT NOT NULL,
      PRIMARY KEY (feed_id, scope_kind, scope_id)
    );
    CREATE TABLE IF NOT EXISTS cap_alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id     TEXT NOT NULL REFERENCES cap_feeds(id) ON DELETE CASCADE,
      akey        TEXT NOT NULL,
      data        TEXT NOT NULL,
      in_feed     INTEGER NOT NULL DEFAULT 1,
      ended       INTEGER NOT NULL DEFAULT 0,
      first_seen  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL,
      UNIQUE (feed_id, akey)
    );
  `);
});

migrationStep('meeting rooms', () => {
  /*
   * Meeting-room displays (lib/rooms). A CONNECTION is an organization's own Microsoft 365 app or
   * Google service account (secret encrypted with lib/secretbox, never returned); a ROOM belongs to
   * a workspace and reads one calendar through a connection or an ICS URL. room_bookings remembers
   * the meetings a panel created (they may be ended from the panel), room_checkins the meetings
   * checked in to or released. Org settings for both are on organizations.
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_connections (
      id               TEXT PRIMARY KEY,
      organization_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      kind             TEXT NOT NULL,
      name             TEXT NOT NULL,
      tenant_id        TEXT,
      client_id        TEXT,
      secret_enc       TEXT,
      subject          TEXT,
      read_only        INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_room_connections_org ON room_connections(organization_id);
    CREATE TABLE IF NOT EXISTS rooms (
      id             TEXT PRIMARY KEY,
      workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name           TEXT NOT NULL,
      source         TEXT NOT NULL,
      connection_id  TEXT,
      calendar_id    TEXT,
      ics_url_enc    TEXT,
      timezone       TEXT NOT NULL DEFAULT 'UTC',
      details        TEXT NOT NULL DEFAULT 'private_hidden',
      allow_booking  INTEGER NOT NULL DEFAULT 1,
      cache_json     TEXT,
      cache_at       INTEGER,
      last_error     TEXT,
      error_count    INTEGER NOT NULL DEFAULT 0,
      next_poll_at   INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_ws ON rooms(workspace_id);
    CREATE TABLE IF NOT EXISTS room_bookings (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      event_id    TEXT NOT NULL,
      device_id   TEXT,
      start_ms    INTEGER NOT NULL,
      end_ms      INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      ended_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_room_bookings_room ON room_bookings(room_id, event_id);
    CREATE TABLE IF NOT EXISTS room_checkins (
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      event_id   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      device_id  TEXT,
      at         INTEGER NOT NULL,
      PRIMARY KEY (room_id, event_id)
    );
    /* Which screen last showed a room with working buttons (POST /api/room-panel/:widget/seen). The
     * no-show release only acts while one did, a moment ago (lib/rooms/service.js sweepReleases). */
    CREATE TABLE IF NOT EXISTS room_panel_presence (
      room_id    TEXT NOT NULL,
      widget_id  TEXT NOT NULL,
      device_id  TEXT NOT NULL,
      seen_at    INTEGER NOT NULL,
      PRIMARY KEY (room_id, widget_id, device_id)
    );
  `);
  // End any meeting from a panel (not only ones booked there), and release-if-nobody-checks-in.
  try { db.prepare('ALTER TABLE organizations ADD COLUMN room_end_any INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* present */ }
  try { db.prepare('ALTER TABLE organizations ADD COLUMN room_release_min INTEGER NOT NULL DEFAULT 0').run(); } catch (_) { /* present */ }
});

migrationStep('automation', () => {
  /*
   * Automation (lib/automation): inbound hooks (a secret URL that raises an emergency alert, fires a
   * trigger, writes a table data source or switches screens to a playlist for a while), Zapier-style
   * REST-hook subscriptions, and the event log both read.
   *   - automation_hooks.secret_hash is sha256 of the URL secret; the secret itself is shown once.
   *   - hmac_secret_enc is optional request signing (lib/secretbox), never returned.
   *   - feed_id: the hidden push-mode CAP feed an emergency / mass-notification hook raises alerts on
   *     (cap_feeds.source = 'hook'), so the card, scopes, expiry and override are CAP's own.
   */
  try { db.prepare("ALTER TABLE cap_feeds ADD COLUMN source TEXT NOT NULL DEFAULT 'poll'").run(); } catch (_) { /* present */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_hooks (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      kind            TEXT NOT NULL,
      config          TEXT NOT NULL DEFAULT '{}',
      secret_hash     TEXT NOT NULL,
      hmac_secret_enc TEXT,
      feed_id         TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_by      TEXT,
      last_called_at  INTEGER,
      call_count      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_automation_hooks_ws ON automation_hooks(workspace_id);
    CREATE TABLE IF NOT EXISTS automation_hook_calls (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      hook_id    TEXT NOT NULL,
      at         INTEGER NOT NULL,
      status     INTEGER NOT NULL,
      outcome    TEXT,
      test       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_automation_hook_calls ON automation_hook_calls(hook_id, at);
    CREATE TABLE IF NOT EXISTS automation_overrides (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      hook_id      TEXT,
      scope_kind   TEXT NOT NULL,
      scope_id     TEXT NOT NULL,
      playlist_id  TEXT NOT NULL,
      starts_at    INTEGER NOT NULL,
      ends_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_overrides_ws ON automation_overrides(workspace_id, ends_at);
    CREATE TABLE IF NOT EXISTS automation_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      type         TEXT NOT NULL,
      data         TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_events_ws ON automation_events(workspace_id, type, id);
    CREATE TABLE IF NOT EXISTS automation_subscriptions (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      token_id     TEXT,
      user_id      TEXT,
      event        TEXT NOT NULL,
      target_url   TEXT NOT NULL,
      secret_enc   TEXT,
      last_ok_at   INTEGER,
      last_error   TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_automation_subs_ws ON automation_subscriptions(workspace_id, event);
    CREATE TABLE IF NOT EXISTS automation_deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT NOT NULL,
      event_id        INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_at         INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      UNIQUE (subscription_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_automation_deliveries_due ON automation_deliveries(status, next_at);
    CREATE TABLE IF NOT EXISTS automation_device_state (
      device_id TEXT PRIMARY KEY,
      status    TEXT NOT NULL
    );
  `);
});

/*
 * Version history baseline. Every existing content row, playlist, layout, slide deck and
 * widget gets revision #1 from its CURRENT state, stamped with the row's own updated_at and no
 * author: the upgrade did not save anything, so it invents neither a person nor a moment.
 * Later saves build on this so "what changed since" has an answer from day one. One-shot, so a
 * baseline is never re-taken over real history.
 */
migrationStep('version history baseline', () => {
  const BASELINE_ID = 'revisions_baseline_v1';
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(BASELINE_ID)) {
    try {
      const n = require('../lib/revisions').baselineAll(db);
      if (n > 0) console.log(`[migrate] version history: ${n} baseline revision(s) recorded`);
    } catch (e) {
      console.warn('[migrate] version history baseline skipped:', e && e.message);
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(BASELINE_ID);
  }
});

// De-duplicate built-in template zones. A prior layout-editor save regenerated
// every zone id on save; schema.sql's INSERT OR IGNORE then re-seeded the
// canonical zone on the next boot, so template layouts accumulated positional
// duplicates (e.g. a 2-zone split template grew to 4+). For each position in a
// template, keep ONE zone, preferring the canonical seeded id (the built-in
// template zones use 'z-...' ids; bug copies are uuids) so schema.sql's re-seed
// stays an idempotent no-op; tiebreak by earliest rowid. One-time; the atomic
// id-preserving save prevents recurrence.
migrationStep('template-zone dedupe', () => {
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
});

/*
 * Corporate (head office) playlists: every table and column of the feature, applied here because
 * organizations only exists once the multi-tenancy phase above has run. Idempotent; see
 * lib/corporate/schema-sql.js.
 */
try {
  require('../lib/corporate/schema-sql').applyCorporateSchema(db);
} catch (e) { console.error('[migrate] corporate schema failed:', e.message); }

// #37: fail fast (loud) if migrations left the DB missing schema the code needs.
const { verifyAndRepairSchema } = require('../lib/schema-check');
verifyAndRepairSchema(db);

/*
 * ─── The playlist-inheritance resolver, and its backfill ─────────────────────────────────────
 *
 * ⚠️ These run LAST, after every table-rebuilding migration above.
 *
 * They started life in the migrations array and broke the tenant delete-cascade migration on every
 * install: that migration rebuilds tables the SQLite way (create new, copy, drop old), and SQLite
 * refuses to drop a table a view still references — "error in view device_inherited_playlist: no
 * such table: main.devices".
 *
 * The view SQL itself lives in lib/playlist-resolver-sql.js so a test fixture that hand-builds a
 * schema applies the SAME definition rather than a copy of it.
 */
const { applyResolverViews } = require('../lib/playlist-resolver-sql');
/*
 * verify: when the definition changed since the last boot, prove no device changes what it plays
 * (only devices a head office mandate now covers may differ) before keeping it; otherwise keep the
 * previous views and switch corporate playlists off (lib/corporate/runtime.js). Never exits.
 */
applyResolverViews(db, { verify: true, previousSql: _previousResolverSql });
/*
 * The corporate backstop: per-connection TEMP triggers that make a write to head office's content
 * by anyone who may not author it fail closed, whichever writer forgot the JS guard. TEMP, so it
 * exists only on this process's connection and never in the file. See lib/corporate/backstop.js.
 */
try {
  require('../lib/corporate/backstop').applyCorporateGuards(db);
} catch (e) { console.error('[corporate] backstop not installed:', e.message); }

/*
 * Playlist inheritance: classify every existing devices.playlist_id as chosen or copied.
 *
 * ⚠️ This decides what every screen plays, so it gets the full heavy-migration treatment: a
 * pre-migration snapshot, and process.exit rather than a half-applied estate. It also VERIFIES
 * itself before committing — the invariant is "no device changes what it plays", which is checkable
 * in SQL, so leaving it to a test file would be a choice not to check it against real data.
 */
const { backfillPlaylistSource, verifyNoDeviceChanged } = require('../lib/playlist-source-backfill');
const PLAYLIST_SOURCE_BACKFILL_ID = 'playlist_source_backfill';
(function backfillPlaylistSourceAtBoot() {
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PLAYLIST_SOURCE_BACKFILL_ID)) return;
  } catch { /* schema_migrations may not exist yet */ }

  const deviceCount = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  if (deviceCount > 0) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotPath = path.join(dbDir, `remote_display.pre-playlist-source-${ts}.db`);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
      copyFileBytes(config.dbPath, snapshotPath);
      console.warn(`[playlist-source backfill] Pre-migration snapshot: ${snapshotPath}`);
    } catch (e) {
      console.error(`[playlist-source backfill] Snapshot failed: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    const stats = backfillPlaylistSource(db);
    const changed = verifyNoDeviceChanged(db);
    if (changed.length) {
      console.error(`[playlist-source backfill] ABORT: ${changed.length} device(s) would change what `
        + 'they play. No device may change content during a migration. Rolled back.');
      for (const c of changed.slice(0, 10)) {
        console.error(`  device ${c.device_id}: was ${c.was} -> now ${c.now} (${c.source})`);
      }
      db.prepare('UPDATE devices SET playlist_source = NULL').run();
      process.exit(1);
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PLAYLIST_SOURCE_BACKFILL_ID);
    if (deviceCount > 0) {
      console.log(`[playlist-source backfill] ${stats.device} override(s), ${stats.none} explicit-none, `
        + `${stats.inherit} inheriting; every device resolves to the playlist it already had`);
    }
  } catch (e) {
    console.error(`[playlist-source backfill] FAILED: ${e.message}`);
    process.exit(1);
  }
})();

/*
 * One-time backfill of play_logs.workspace_id from each device's CURRENT workspace.
 *
 * ⚠️ PRE-MIGRATION ATTRIBUTION IS BEST-EFFORT, AND THAT IS NOT FIXABLE. Rows written before the
 * column existed carry no record of where the device was at the time, so the only thing available
 * is where it is NOW. A device already moved between workspaces has its whole history attributed
 * to its current owner. Going forward the value is snapshotted at insert and is exact; this pass
 * simply gives the existing rows their most likely tenant instead of none.
 *
 * ⚠️ NO PRE-MIGRATION SNAPSHOT, unlike the playlist-source backfill above, and deliberately. That
 * one rewrote how devices resolve a playlist — state with no other source of truth. This fills a
 * column that was NULL one statement ago and is undone by `UPDATE play_logs SET workspace_id =
 * NULL`. Snapshotting is not free here: it copies the whole database, and on production that is
 * 1.5 GB per run. Eleven such snapshots had accumulated to 3.3 GB before being pruned by hand on
 * 2026-09-29.
 *
 * Chunked by ROWID RANGE rather than `WHERE workspace_id IS NULL LIMIT n`: there is no index on
 * workspace_id, so the latter rescans from the start of the table on every batch and turns a
 * linear pass into a quadratic one. A rowid range walks the table once.
 *
 * It says what it is doing before it starts. The 2.0.1 note above records an index build on this
 * same table sitting in uninterruptible disk sleep for over five minutes printing NOTHING, which
 * is indistinguishable from a hang — and the operator's response to a hang is to kill it, which is
 * the one thing that must not happen during a migration.
 */
const PLAY_LOGS_WORKSPACE_BACKFILL_ID = 'play_logs_workspace_backfill';
(function backfillPlayLogWorkspaceAtBoot() {
  try {
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(PLAY_LOGS_WORKSPACE_BACKFILL_ID)) return;
  } catch { return; }   /* schema_migrations absent: a fresh database has nothing to backfill */

  let total = 0;
  try { total = db.prepare('SELECT COUNT(*) AS n FROM play_logs').get().n; } catch { return; }
  if (total === 0) {
    try { db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PLAY_LOGS_WORKSPACE_BACKFILL_ID); } catch { /* next boot */ }
    return;
  }

  console.warn(`[play_logs workspace backfill] ${total.toLocaleString()} row(s) to attribute. `
    + 'This walks the table once and can take a few minutes on a large install — it is NOT hung.');

  const BATCH = 20000;
  const pick = db.prepare('SELECT rowid AS r FROM play_logs WHERE rowid > ? ORDER BY rowid LIMIT 1 OFFSET ?');
  const last = db.prepare('SELECT MAX(rowid) AS r FROM play_logs').get().r || 0;
  const fill = db.prepare(`UPDATE play_logs
       SET workspace_id = (SELECT d.workspace_id FROM devices d WHERE d.id = play_logs.device_id)
     WHERE rowid > ? AND rowid <= ? AND workspace_id IS NULL`);

  const started = Date.now();
  let cursor = 0, done = 0, attributed = 0;
  try {
    while (cursor < last) {
      const nextRow = pick.get(cursor, BATCH - 1);
      const upper = nextRow ? nextRow.r : last;
      attributed += db.transaction(() => fill.run(cursor, upper).changes)();
      done += BATCH;
      cursor = upper;
      if (done % (BATCH * 10) === 0) {
        console.warn(`[play_logs workspace backfill] ~${Math.min(done, total).toLocaleString()}/${total.toLocaleString()} rows scanned`);
      }
    }
    db.prepare('INSERT OR IGNORE INTO schema_migrations (id) VALUES (?)').run(PLAY_LOGS_WORKSPACE_BACKFILL_ID);
    console.warn(`[play_logs workspace backfill] done: ${attributed.toLocaleString()} row(s) attributed `
      + `in ${((Date.now() - started) / 1000).toFixed(1)}s. Rows whose device is gone stay NULL.`);
  } catch (e) {
    // NOT fatal, unlike the playlist-source backfill: an unattributed row degrades a report's
    // tenant filter, it does not break playback. Leaving the marker unset retries next boot.
    console.error(`[play_logs workspace backfill] FAILED (will retry next boot): ${e.message}`);
  }
})();

// `playsMigrationTouched`: did THIS boot build a play_logs index or add a play_logs column?
// Read once by services/heartbeat to arm the 2.0.1 player defer (lib/boot-defer.js). The loop
// that sets it runs at require time, well above this line, so the value is already final here.
module.exports = { db, pruneTelemetry, pruneTelemetryRetention, pruneScreenshots, pruneStatusLog, getMaintenanceStats,
                   playsMigrationTouched: _playsMigrationTouched, _migrateWallSchedules: migrateWallSchedules,
                   _migrateAudienceSegments: migrateAudienceSegments };
