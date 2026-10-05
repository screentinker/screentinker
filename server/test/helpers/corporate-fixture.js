'use strict';

/*
 * An in-memory database with exactly the columns the corporate (head office) machinery and the
 * playlist resolver read, built from the SAME definitions the boot migration applies: the corporate
 * schema (lib/corporate/schema-sql.js), the resolver views (lib/playlist-resolver-sql.js) and the
 * backstop (lib/corporate/backstop.js) are imported, never pasted.
 *
 * Seeding helpers return ids so a test reads as the situation it describes.
 */

const Database = require('better-sqlite3');
const crypto = require('node:crypto');

function freshDb({ views = true, guards = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT NOT NULL DEFAULT 'user');
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
    CREATE TABLE organization_members (id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, role TEXT NOT NULL, UNIQUE(organization_id, user_id));
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '', origin_node_id TEXT);
    CREATE TABLE workspace_members (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, joined_at INTEGER NOT NULL DEFAULT 0, UNIQUE(workspace_id, user_id));
    CREATE TABLE layouts (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, is_template INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE content (id TEXT PRIMARY KEY, workspace_id TEXT, filename TEXT, mime_type TEXT, duration_sec REAL);
    CREATE TABLE widgets (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT);
    CREATE TABLE playlists (id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '',
      description TEXT, status TEXT NOT NULL DEFAULT 'draft', published_snapshot TEXT, published_structure TEXT,
      playback_order TEXT, smart_rules TEXT, is_auto_generated INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
    CREATE TABLE playlist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      content_id TEXT REFERENCES content(id) ON DELETE CASCADE, widget_id TEXT, child_playlist_id TEXT REFERENCES playlists(id) ON DELETE RESTRICT,
      zone_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0, duration_sec INTEGER, muted INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_playlist_items_child ON playlist_items(child_playlist_id);
    CREATE TABLE playlist_item_schedules (id TEXT PRIMARY KEY, playlist_item_id INTEGER NOT NULL REFERENCES playlist_items(id) ON DELETE CASCADE,
      active_days TEXT, start_time TEXT, end_time TEXT);
    CREATE TABLE video_walls (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, playlist_id TEXT, leader_device_id TEXT);
    CREATE TABLE devices (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, playlist_id TEXT, playlist_source TEXT, wall_id TEXT,
      layout_id TEXT, scheduled_playlist_id TEXT, scheduled_layout_id TEXT, status TEXT, platform TEXT, ip_address TEXT);
    CREATE TABLE video_wall_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, wall_id TEXT, device_id TEXT);
    CREATE TABLE device_groups (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, playlist_id TEXT, priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0, sync_enabled INTEGER NOT NULL DEFAULT 0, leader_device_id TEXT, sync_backend TEXT);
    CREATE TABLE device_group_members (device_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY (device_id, group_id));
    CREATE TABLE triggers (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE display_power_schedules (id TEXT PRIMARY KEY, workspace_id TEXT, device_id TEXT, group_id TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      timezone TEXT, windows TEXT);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, workspace_id TEXT, device_id TEXT, group_id TEXT, enabled INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, device_id TEXT, action TEXT, details TEXT, ip_address TEXT, workspace_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')));
    CREATE TABLE slide_decks (id TEXT PRIMARY KEY, workspace_id TEXT, playlist_id TEXT);
  `);
  const failed = require('../../lib/corporate/schema-sql').applyCorporateSchema(db, { log: null });
  if (failed.length) throw new Error(`corporate schema failed: ${failed.join(' | ')}`);
  if (views) require('../../lib/playlist-resolver-sql').applyResolverViews(db);
  if (guards) require('../../lib/corporate/backstop').applyCorporateGuards(db);
  return db;
}

const uid = (p) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

function seed(db) {
  const s = {
    org(name = 'Org', { corporate = 1 } = {}) {
      const id = uid('org');
      db.prepare('INSERT INTO organizations (id, name, corporate_enabled) VALUES (?, ?, ?)').run(id, name, corporate);
      return id;
    },
    ws(orgId, name = 'Workspace') {
      const id = uid('ws');
      db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(id, orgId, name);
      return id;
    },
    hq(orgId, wsId) { db.prepare('UPDATE organizations SET hq_workspace_id = ? WHERE id = ?').run(wsId, orgId); },
    playlist(wsId, { corporate = 0, name = 'P', published = true } = {}) {
      const id = uid('pl');
      db.prepare('INSERT INTO playlists (id, workspace_id, name, corporate, status, published_snapshot) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, wsId, name, corporate, published ? 'published' : 'draft', published ? '[]' : null);
      return id;
    },
    device(wsId, extra = {}) {
      const id = uid('dev');
      db.prepare(`INSERT INTO devices (id, workspace_id, name, playlist_id, playlist_source, wall_id, layout_id, scheduled_playlist_id, scheduled_layout_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, wsId, extra.name || id, extra.playlist_id || null, extra.playlist_source || null, extra.wall_id || null,
          extra.layout_id || null, extra.scheduled_playlist_id || null, extra.scheduled_layout_id || null);
      return id;
    },
    group(wsId, { playlist_id = null, priority = 0, created_at = 0, sync_enabled = 0 } = {}) {
      const id = uid('grp');
      db.prepare('INSERT INTO device_groups (id, workspace_id, name, playlist_id, priority, created_at, sync_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, wsId, id, playlist_id, priority, created_at, sync_enabled);
      return id;
    },
    join(deviceId, groupId) { db.prepare('INSERT INTO device_group_members (device_id, group_id) VALUES (?, ?)').run(deviceId, groupId); },
    wall(wsId, { playlist_id = null } = {}) {
      const id = uid('wall');
      db.prepare('INSERT INTO video_walls (id, workspace_id, name, playlist_id) VALUES (?, ?, ?, ?)').run(id, wsId, id, playlist_id);
      return id;
    },
    onWall(deviceId, wallId) {
      db.prepare('UPDATE devices SET wall_id = ? WHERE id = ?').run(wallId, deviceId);
      db.prepare('INSERT INTO video_wall_devices (wall_id, device_id) VALUES (?, ?)').run(wallId, deviceId);
    },
    layout(wsId) {
      const id = uid('lay');
      db.prepare('INSERT INTO layouts (id, workspace_id, name) VALUES (?, ?, ?)').run(id, wsId, id);
      return id;
    },
    mandate(orgId, kind, targetId, { playlist_id = null, dark = 0, layout_id = null, enabled = 1, created_at = 0 } = {}) {
      const id = uid('man');
      db.prepare(`INSERT INTO corporate_mandates (id, organization_id, playlist_id, dark, target_kind, target_id, layout_id, enabled, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, playlist_id, dark, kind, targetId, layout_id, enabled, created_at);
      return id;
    },
    user(id, role = 'user') { db.prepare('INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id, `${id}@x.test`, id, role); return id; },
    orgMember(orgId, userId, role) { db.prepare('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)').run(orgId, userId, role); },
    wsMember(wsId, userId, role) { db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, userId, role); },
  };
  return s;
}

const resolved = (db, deviceId) => {
  const r = db.prepare('SELECT playlist_id, source, layout_id FROM device_resolved_playlist WHERE device_id = ?').get(deviceId);
  return r ? { playlist_id: r.playlist_id, source: r.source, layout_id: r.layout_id } : null;
};

/** Install `db` as the process's database module (before requiring anything that uses it). */
function injectDb(db) {
  const p = require.resolve('../../db/database');
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { db, pruneTelemetry() {}, pruneScreenshots() {} } };
}

module.exports = { freshDb, seed, resolved, injectDb };
