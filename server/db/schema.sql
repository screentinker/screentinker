CREATE TABLE IF NOT EXISTS plans (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    max_devices     INTEGER NOT NULL DEFAULT 2,
    max_storage_mb  INTEGER NOT NULL DEFAULT 500,
    remote_control  INTEGER NOT NULL DEFAULT 0,
    remote_url      INTEGER NOT NULL DEFAULT 0,
    priority_support INTEGER NOT NULL DEFAULT 0,
    price_monthly   REAL NOT NULL DEFAULT 0,
    price_yearly    REAL NOT NULL DEFAULT 0,
    stripe_monthly_id TEXT,
    stripe_yearly_id  TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    active          INTEGER NOT NULL DEFAULT 1
);

-- Default plans
INSERT OR IGNORE INTO plans (id, name, display_name, max_devices, max_storage_mb, remote_control, remote_url, priority_support, price_monthly, price_yearly, sort_order)
VALUES
  ('free',       'free',       'Free',       2,    500,   0, 0, 0, 0,     0,     0),
  ('starter',    'starter',    'Starter',    8,    2048,  1, 0, 0, 9.99,  99,    1),
  ('pro',        'pro',        'Pro',        25,   10240, 1, 1, 0, 24.99, 249,   2),
  ('enterprise', 'enterprise', 'Enterprise', -1,   -1,    1, 1, 1, 49.99, 499,   3);

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    password_hash   TEXT,
    auth_provider   TEXT NOT NULL DEFAULT 'local',
    provider_id     TEXT,
    avatar_url      TEXT,
    role            TEXT NOT NULL DEFAULT 'user',
    plan_id         TEXT DEFAULT 'free' REFERENCES plans(id),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT DEFAULT 'active',
    subscription_ends  INTEGER,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS devices (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    name            TEXT NOT NULL DEFAULT 'Unnamed Display',
    pairing_code    TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'offline',
    last_heartbeat  INTEGER,
    ip_address      TEXT,
    android_version TEXT,
    app_version     TEXT,
    screen_width    INTEGER,
    screen_height   INTEGER,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_telemetry (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    battery_level   INTEGER,
    battery_charging INTEGER NOT NULL DEFAULT 0,
    storage_free_mb INTEGER,
    storage_total_mb INTEGER,
    ram_free_mb     INTEGER,
    ram_total_mb    INTEGER,
    cpu_usage       REAL,
    wifi_ssid       TEXT,
    wifi_rssi       INTEGER,
    uptime_seconds  INTEGER,
    reported_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_device ON device_telemetry(device_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS content (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    filename        TEXT NOT NULL,
    filepath        TEXT NOT NULL DEFAULT '',
    mime_type       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    duration_sec    REAL,
    thumbnail_path  TEXT,
    width           INTEGER,
    height          INTEGER,
    remote_url      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS assignments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    zone_id         TEXT,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    schedule_start  TEXT,
    schedule_end    TEXT,
    schedule_days   TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS screenshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    filepath        TEXT NOT NULL,
    captured_at     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_screenshots_device ON screenshots(device_id, captured_at DESC);

-- ===================== LAYOUTS & ZONES =====================

CREATE TABLE IF NOT EXISTS layouts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    width           INTEGER NOT NULL DEFAULT 1920,
    height          INTEGER NOT NULL DEFAULT 1080,
    is_template     INTEGER NOT NULL DEFAULT 0,
    template_category TEXT,
    thumbnail_data  TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS layout_zones (
    id              TEXT PRIMARY KEY,
    layout_id       TEXT NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT 'Zone',
    x_percent       REAL NOT NULL DEFAULT 0,
    y_percent       REAL NOT NULL DEFAULT 0,
    width_percent   REAL NOT NULL DEFAULT 100,
    height_percent  REAL NOT NULL DEFAULT 100,
    z_index         INTEGER NOT NULL DEFAULT 0,
    zone_type       TEXT NOT NULL DEFAULT 'content',
    fit_mode        TEXT NOT NULL DEFAULT 'contain',
    background_color TEXT DEFAULT '#000000',
    sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_zones_layout ON layout_zones(layout_id);

-- Seed templates
INSERT OR IGNORE INTO layouts (id, user_id, name, is_template, template_category) VALUES
  ('tpl-fullscreen',  NULL, 'Fullscreen',           1, 'basic'),
  ('tpl-split-h',     NULL, 'Split Horizontal',     1, 'split'),
  ('tpl-split-v',     NULL, 'Split Vertical',       1, 'split'),
  ('tpl-l-bar',       NULL, 'L-Bar with Ticker',    1, 'news'),
  ('tpl-pip',         NULL, 'Picture in Picture',   1, 'overlay'),
  ('tpl-thirds',      NULL, 'Three Column',         1, 'grid'),
  ('tpl-quad',        NULL, 'Four Quadrants',       1, 'grid');

INSERT OR IGNORE INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, sort_order) VALUES
  ('z-fs-1',    'tpl-fullscreen', 'Main',           0, 0, 100, 100, 0, 0),
  ('z-sh-1',    'tpl-split-h',   'Left',            0, 0, 50, 100, 0, 0),
  ('z-sh-2',    'tpl-split-h',   'Right',           50, 0, 50, 100, 0, 1),
  ('z-sv-1',    'tpl-split-v',   'Top',             0, 0, 100, 50, 0, 0),
  ('z-sv-2',    'tpl-split-v',   'Bottom',          0, 50, 100, 50, 0, 1),
  ('z-lb-1',    'tpl-l-bar',     'Main Content',    0, 0, 75, 85, 0, 0),
  ('z-lb-2',    'tpl-l-bar',     'Side Panel',      75, 0, 25, 100, 0, 1),
  ('z-lb-3',    'tpl-l-bar',     'Bottom Ticker',   0, 85, 75, 15, 1, 2),
  ('z-pip-1',   'tpl-pip',       'Background',      0, 0, 100, 100, 0, 0),
  ('z-pip-2',   'tpl-pip',       'PiP Window',      65, 5, 30, 30, 1, 1),
  ('z-th-1',    'tpl-thirds',    'Left',            0, 0, 33.33, 100, 0, 0),
  ('z-th-2',    'tpl-thirds',    'Center',          33.33, 0, 33.34, 100, 0, 1),
  ('z-th-3',    'tpl-thirds',    'Right',           66.67, 0, 33.33, 100, 0, 2),
  ('z-q-1',     'tpl-quad',      'Top Left',        0, 0, 50, 50, 0, 0),
  ('z-q-2',     'tpl-quad',      'Top Right',       50, 0, 50, 50, 0, 1),
  ('z-q-3',     'tpl-quad',      'Bottom Left',     0, 50, 50, 50, 0, 2),
  ('z-q-4',     'tpl-quad',      'Bottom Right',    50, 50, 50, 50, 0, 3);

-- ===================== WIDGETS =====================

CREATE TABLE IF NOT EXISTS widgets (
    id              TEXT PRIMARY KEY,
    user_id         TEXT REFERENCES users(id),
    team_id         TEXT,
    widget_type     TEXT NOT NULL,
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== SCHEDULES =====================

CREATE TABLE IF NOT EXISTS schedules (
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

CREATE INDEX IF NOT EXISTS idx_schedules_device ON schedules(device_id, enabled);
-- Note: idx_schedules_group is created by the phase4 migration which rebuilds the table

-- ===================== VIDEO WALLS =====================

CREATE TABLE IF NOT EXISTS video_walls (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    team_id         TEXT,
    name            TEXT NOT NULL,
    grid_cols       INTEGER NOT NULL DEFAULT 2,
    grid_rows       INTEGER NOT NULL DEFAULT 2,
    bezel_h_mm      REAL NOT NULL DEFAULT 0,
    bezel_v_mm      REAL NOT NULL DEFAULT 0,
    screen_w_mm     REAL NOT NULL DEFAULT 400,
    screen_h_mm     REAL NOT NULL DEFAULT 225,
    sync_mode       TEXT NOT NULL DEFAULT 'leader',
    leader_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    -- Free-form player rect on the wall canvas (NULL = use bounding box of screens)
    player_x        REAL,
    player_y        REAL,
    player_width    REAL,
    player_height   REAL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS video_wall_devices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wall_id         TEXT NOT NULL REFERENCES video_walls(id) ON DELETE CASCADE,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    grid_col        INTEGER NOT NULL,
    grid_row        INTEGER NOT NULL,
    rotation        INTEGER NOT NULL DEFAULT 0,
    -- Free-form canvas rect (NULL = derive from grid_col/row + bezel as a fallback)
    canvas_x        REAL,
    canvas_y        REAL,
    canvas_width    REAL,
    canvas_height   REAL,
    UNIQUE(wall_id, device_id),
    UNIQUE(wall_id, grid_col, grid_row)
);

-- ===================== TEAMS =====================

CREATE TABLE IF NOT EXISTS teams (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS team_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT REFERENCES users(id),
    joined_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
    id              TEXT PRIMARY KEY,
    team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    email           TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'viewer',
    invited_by      TEXT NOT NULL REFERENCES users(id),
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PROOF-OF-PLAY =====================

CREATE TABLE IF NOT EXISTS play_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE SET NULL,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE SET NULL,
    zone_id         TEXT,
    content_name    TEXT NOT NULL DEFAULT '',
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    duration_sec    INTEGER,
    completed       INTEGER NOT NULL DEFAULT 0,
    trigger_type    TEXT DEFAULT 'playlist',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_play_logs_device ON play_logs(device_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_content ON play_logs(content_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_play_logs_time ON play_logs(started_at, ended_at);

-- ===================== DEVICE GROUPS =====================

CREATE TABLE IF NOT EXISTS device_groups (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    color           TEXT DEFAULT '#3B82F6',
    playlist_id     TEXT REFERENCES playlists(id) ON DELETE SET NULL,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_group_members (
    device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    group_id        TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, group_id)
);

-- ===================== PLAYLISTS =====================

CREATE TABLE IF NOT EXISTS playlists (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    description     TEXT DEFAULT '',
    is_auto_generated INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'draft',
    published_snapshot TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS playlist_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id     TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    content_id      TEXT REFERENCES content(id) ON DELETE CASCADE,
    widget_id       TEXT REFERENCES widgets(id) ON DELETE CASCADE,
    zone_id         TEXT REFERENCES layout_zones(id) ON DELETE SET NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    duration_sec    INTEGER NOT NULL DEFAULT 10,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Per-playlist-item schedule blocks (#74 dayparting + #75 expiry). 1-to-many:
-- an item with ZERO rows here is always on; otherwise it shows when device-local
-- "now" matches at least one block. Wall-clock rules (local HH:MM + local dates),
-- evaluated on the device via the shared evaluator (server/lib/schedule-eval.js).
-- Pure child of playlist_items: cascade-deleted, and tenant isolation flows
-- through the parent item/playlist, so no workspace_id is needed here.
CREATE TABLE IF NOT EXISTS playlist_item_schedules (
    id               TEXT PRIMARY KEY,
    playlist_item_id INTEGER NOT NULL REFERENCES playlist_items(id) ON DELETE CASCADE,
    active_days      TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',  -- comma-separated 0(Sun)-6(Sat)
    start_time       TEXT NOT NULL DEFAULT '00:00',          -- local HH:MM
    end_time         TEXT NOT NULL DEFAULT '24:00',          -- local HH:MM ("24:00" = end of day)
    start_date       TEXT,                                   -- local YYYY-MM-DD, nullable = no lower bound
    end_date         TEXT,                                   -- local YYYY-MM-DD, nullable = no upper bound
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_playlist_item_schedules_item ON playlist_item_schedules(playlist_item_id);

-- ===================== ACTIVITY LOG =====================

CREATE TABLE IF NOT EXISTS activity_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT REFERENCES users(id),
    device_id       TEXT,
    action          TEXT NOT NULL,
    details         TEXT,
    ip_address      TEXT,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_log_time ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user ON activity_log(user_id, created_at DESC);

-- ===================== EMAIL ALERTS =====================

-- ===================== WHITE LABEL =====================

CREATE TABLE IF NOT EXISTS white_labels (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    brand_name      TEXT NOT NULL DEFAULT 'ScreenTinker',
    logo_url        TEXT,
    favicon_url     TEXT,
    primary_color   TEXT DEFAULT '#3B82F6',
    secondary_color TEXT DEFAULT '#1E293B',
    bg_color        TEXT DEFAULT '#111827',
    custom_domain   TEXT,
    custom_css      TEXT,
    hide_branding   INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== AI (BYOK) SETTINGS =====================
-- #41: per-workspace AI design generation. Bring-your-own OpenAI-COMPATIBLE
-- endpoint (OpenAI cloud, or self-hosted: Ollama / LM Studio / llama.cpp, and
-- AUTOMATIC1111 etc. for images), so the operator bears no AI cost. api_key_enc
-- is AES-256-GCM encrypted (lib/secretbox.js); it is never returned to clients.
CREATE TABLE IF NOT EXISTS ai_settings (
    workspace_id    TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    base_url        TEXT,
    api_key_enc     TEXT,
    model           TEXT,
    image_base_url  TEXT,
    image_model     TEXT,
    image_provider  TEXT,
    image_api_key_enc TEXT,
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== KIOSK PAGES =====================

CREATE TABLE IF NOT EXISTS kiosk_pages (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== DEVICE STATUS LOG =====================

CREATE TABLE IF NOT EXISTS device_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== DEVICE FINGERPRINTS =====================

CREATE TABLE IF NOT EXISTS device_fingerprints (
    fingerprint     TEXT NOT NULL,
    device_id       TEXT REFERENCES devices(id) ON DELETE SET NULL,
    user_id         TEXT REFERENCES users(id),
    first_seen      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (fingerprint)
);

CREATE TABLE IF NOT EXISTS alert_configs (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id),
    alert_type      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    config          TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS device_status_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id       TEXT NOT NULL,
    status          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- ===================== PLAYER DEBUG LOGS =====================
-- Smart TVs (Tizen, WebOS, Fire TV, etc.) have no accessible devtools. The
-- player captures errors into window.__debugLog client-side and POSTs them
-- to /api/player-debug. This table stores those reports. Submitter is
-- unauthenticated by design - the player may not have paired yet when an
-- error fires. device_id is nullable for unpaired players.
--
-- Capped at 10,000 rows with FIFO eviction on insert (route-side, no sweep).
-- error_fingerprint is a client-computed hash of (error message + first stack
-- frame) - indexed so a future "top N unique errors this week" query is fast
-- without a schema change.

CREATE TABLE IF NOT EXISTS player_debug_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT,
    ip                TEXT,
    user_agent        TEXT,
    url               TEXT,
    error_fingerprint TEXT,
    error_data        TEXT,
    context           TEXT,
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX IF NOT EXISTS idx_player_debug_fingerprint ON player_debug_logs(error_fingerprint);
CREATE INDEX IF NOT EXISTS idx_player_debug_created_at ON player_debug_logs(created_at);

-- ===================== API TOKENS (public API, Phase 1) =====================
-- Scoped personal access tokens for the public API. The full token (st_...) is
-- shown to its owner exactly once at creation; only its SHA-256 hash is stored.
-- A token is bound to ONE workspace and a scope (read|write|full) and always acts
-- with the owner's workspace role - never platform/cross-org powers (apiTokenAuth
-- forces the effective platform role to 'user').
CREATE TABLE IF NOT EXISTS api_tokens (
    id              TEXT PRIMARY KEY,
    token_hash      TEXT NOT NULL UNIQUE,                     -- SHA-256 hex of the full token
    prefix          TEXT NOT NULL,                            -- e.g. 'st_a1b2c3d4' (display only)
    name            TEXT NOT NULL,                            -- user-given label
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    scope           TEXT NOT NULL DEFAULT 'read',             -- 'read' | 'write' | 'full'
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_used_at    INTEGER,
    revoked_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- ===================== SCHEMA MIGRATIONS =====================

CREATE TABLE IF NOT EXISTS schema_migrations (
    id              TEXT PRIMARY KEY,
    ran_at          INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
