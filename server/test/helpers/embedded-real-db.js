'use strict';

/*
 * The REAL schema for the embedded route tests: db/database.js booted on a throwaway DATA_DIR,
 * routes/embedded mounted on an ephemeral port.
 *
 * Why not a hand-written CREATE TABLE like reterminal-e-series.test.js: devices.orientation is
 * DEFAULT 'landscape' in the real schema (a 2020 migration), and a hand-written table that left
 * the default out is exactly how a column default got mistaken for a device's choice.
 *
 * ⚠️ Call boot() BEFORE anything requires db/database or config: both read DATA_DIR once, at
 * require time. Everything (db, uploads, the e-ink cache) lands under the temp dir, and close()
 * removes it.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function boot({ firmwareDir, beforeRouter } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-emb-real-'));
  process.env.DATA_DIR = dataDir;
  process.env.EMBEDDED_CACHE_DIR = path.join(dataDir, 'embedded-cache');
  process.env.NODE_ENV = 'test';
  process.env.SELF_HOSTED = 'true';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-embedded-real-db';
  // These tests poll one device in quick succession; the OTA breaker's RATE axis would trip.
  process.env.OTA_BREAKER_THRESHOLD = process.env.OTA_BREAKER_THRESHOLD || '1000';
  if (firmwareDir !== undefined) process.env.ST_FIRMWARE_DIR = firmwareDir;

  const { db } = require('../../db/database');
  const config = require('../../config');
  if (typeof beforeRouter === 'function') beforeRouter();
  const express = require('express');
  const router = require('../../routes/embedded');
  const app = express();
  // The same body-parser carve-out as server.js: /api/embedded/logs parses its own body.
  const jsonBody = express.json({ limit: '12mb' });
  app.use((req, res, next) => (/^\/api\/embedded\/logs\/?$/i.test(req.path) ? next() : jsonBody(req, res, next)));
  app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
  app.use('/api/embedded', router);
  const server = app.listen(0);

  // Fill every NOT NULL column that has no default, so an insert survives future schema growth.
  function insert(table, fields) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    const row = { ...fields };
    for (const c of cols) {
      if (row[c.name] !== undefined || c.pk || !c.notnull || c.dflt_value != null) continue;
      row[c.name] = /INT|REAL/i.test(c.type) ? 0 : 'x';
    }
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => row[k]));
    return row;
  }

  const ids = { user: 'u-emb', org: 'o-emb', ws: 'ws-emb' };
  db.pragma('foreign_keys = OFF');
  insert('users', { id: ids.user, email: 'emb@t.local', password_hash: 'x', role: 'user' });
  insert('organizations', { id: ids.org, name: 'Org', owner_user_id: ids.user });
  insert('workspaces', { id: ids.ws, organization_id: ids.org, name: 'WS' });
  insert('workspace_members', { workspace_id: ids.ws, user_id: ids.user, role: 'workspace_admin' });
  db.pragma('foreign_keys = ON');

  function mkToken(scope) {
    const { hashToken } = require('../../middleware/apiToken');
    const secret = 'st_' + scope + '_' + crypto.randomBytes(8).toString('hex');
    db.prepare("INSERT INTO api_tokens (id, token_hash, prefix, name, user_id, workspace_id, scope, created_at) VALUES (?,?,?,?,?,?,?, strftime('%s','now'))")
      .run('tok-' + crypto.randomBytes(4).toString('hex'), hashToken(secret), secret.slice(0, 10), scope + ' token', ids.user, ids.ws, scope);
    return secret;
  }

  /*
   * A paired embedded panel whose playlist is one image. The device row is inserted the way pairing
   * leaves it: NO orientation given, so the column takes the schema default ('landscape').
   */
  async function mkPanel(screenProfile, { color = 0x336699FF, w = 64, h = 48, extra = {} } = {}) {
    const { Jimp } = require('jimp');
    const id = 'dev-' + crypto.randomBytes(4).toString('hex');
    const token = 'tok-' + crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(config.contentDir, { recursive: true });
    const file = id + '.png';
    const img = new Jimp({ width: w, height: h, color });
    // A diagonal so a rotation or transpose is visible in the bytes.
    for (let i = 0; i < Math.min(w, h); i++) img.setPixelColor(0xFFFFFFFF, i, i);
    await img.write(path.join(config.contentDir, file));
    const cid = 'c-' + id;
    insert('content', { id: cid, workspace_id: ids.ws, user_id: ids.user, filename: file, filepath: file, mime_type: 'image/png', file_size: 1, created_at: 1, updated_at: 1 });
    const pl = 'pl-' + id;
    insert('playlists', { id: pl, workspace_id: ids.ws, user_id: ids.user, name: 'PL ' + id, status: 'published',
      published_snapshot: JSON.stringify([{ id: 'pi-' + id, content_id: cid, duration_sec: 30, enabled: 1 }]) });
    insert('devices', { id, name: 'Panel ' + id, workspace_id: ids.ws, user_id: ids.user, status: 'online', client_type: 'embedded',
      device_token: token, playlist_id: pl, screen_profile: typeof screenProfile === 'string' ? screenProfile : JSON.stringify(screenProfile), ...extra });
    return { id, token };
  }

  async function ready() {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${server.address().port}/api/embedded`;
  }

  async function close() {
    await new Promise((r) => server.close(r));
    try { db.close(); } catch (_) { /* already */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { db, config, dataDir, ids, insert, mkToken, mkPanel, ready, close };
}

module.exports = { boot };
