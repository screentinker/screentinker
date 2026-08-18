const Database = require('better-sqlite3');
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
  // Repair for schedules orphaned by a group deletion before the conversion carried workspace_id.
  // Such rows are invisible (list/calendar filter on workspace), undeletable (PUT/DELETE 403 on a
  // null workspace) and still firing (the scheduler has no workspace filter) — so an operator
  // cannot fix them from the dashboard at all. Recover the workspace from the device the schedule
  // targets; anything still unresolvable is left alone rather than guessed at.
  `UPDATE schedules SET workspace_id = (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id)
     WHERE workspace_id IS NULL AND device_id IS NOT NULL
       AND (SELECT d.workspace_id FROM devices d WHERE d.id = schedules.device_id) IS NOT NULL`,
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
  "ALTER TABLE organizations ADD COLUMN widget_sandbox_isolation_disabled INTEGER NOT NULL DEFAULT 0",
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

module.exports = { db, pruneTelemetry, pruneTelemetryRetention, pruneScreenshots, pruneStatusLog, getMaintenanceStats };
