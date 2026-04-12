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
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (e) { /* already exists */ }
}

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
function migrateAssignmentsToPlaylists() {
  // Skip if already migrated (any device has a playlist_id set)
  const migrated = db.prepare('SELECT 1 FROM devices WHERE playlist_id IS NOT NULL LIMIT 1').get();
  if (migrated) return;

  const { v4: uuidv4 } = require('uuid');

  // Find devices that have at least one assignment
  const devicesWithAssignments = db.prepare(`
    SELECT DISTINCT d.id, d.name, d.user_id
    FROM devices d
    INNER JOIN assignments a ON a.device_id = d.id
    WHERE d.user_id IS NOT NULL
  `).all();

  if (devicesWithAssignments.length === 0) return;

  console.log(`Migrating ${devicesWithAssignments.length} device(s) from assignments to playlists...`);

  const insertPlaylist = db.prepare(`
    INSERT INTO playlists (id, user_id, name, description, is_auto_generated)
    VALUES (?, ?, ?, ?, 1)
  `);
  const insertItem = db.prepare(`
    INSERT INTO playlist_items (playlist_id, content_id, widget_id, sort_order, duration_sec)
    VALUES (?, ?, ?, ?, ?)
  `);
  const setDevicePlaylist = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
  const getAssignments = db.prepare(`
    SELECT content_id, widget_id, sort_order, duration_sec
    FROM assignments
    WHERE device_id = ? AND enabled = 1
    ORDER BY sort_order ASC
  `);

  const migrate = db.transaction(() => {
    for (const device of devicesWithAssignments) {
      const playlistId = uuidv4();
      insertPlaylist.run(playlistId, device.user_id, `${device.name} (migrated)`, 'Auto-generated from previous assignments');

      const assignments = getAssignments.all(device.id);
      for (const a of assignments) {
        insertItem.run(playlistId, a.content_id || null, a.widget_id || null, a.sort_order, a.duration_sec);
      }

      setDevicePlaylist.run(playlistId, device.id);
    }
  });
  migrate();

  console.log(`Migration complete: ${devicesWithAssignments.length} playlist(s) created.`);
}

migrateAssignmentsToPlaylists();

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

module.exports = { db, pruneTelemetry, pruneScreenshots };
