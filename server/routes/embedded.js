'use strict';

/*
 * Embedded renderer route.
 *
 * Provides two endpoints for embedded devices (ESP32, Raspberry Pi, etc.):
 *
 *   GET /api/embedded/render
 *     Returns a pre-rendered image of the device's current playlist item,
 *     formatted for the device's screen (resolution, color depth, dithering).
 *     Supports HTTP 304 Not Modified via ETag so the MCU can skip SPI writes.
 *
 *   GET /api/embedded/info
 *     Returns JSON metadata (no image): screen profile, current item, timing.
 *     Useful for MCU startup negotiation and debugging.
 *
 * Authentication — two paths, resolved in this order:
 *   1. Device token:  Authorization: Bearer <device_token>  +  ?device_id=<id>
 *      The same credential the device uses for its WebSocket connection.
 *      Sets req.device, req.workspaceId.
 *   2. API token:     Authorization: Bearer st_...  (for preview/dashboard use)
 *      Requires ?device_id=<id>. The token must be scoped to the same workspace
 *      as the target device. Sets req.user, req.workspaceId (via bearerAuth +
 *      resolveTenancy applied inline).
 *
 * This route is mounted MANUALLY in server.js (not via api-surface.js PUBLIC_ROUTERS)
 * because the dual auth model — device token OR API token — does not fit the
 * bearerAuth loop that all PUBLIC_ROUTERS share.
 *
 * ⚠️ Never call stripDeviceSecrets() on req.device before using it here; we only
 *    read workspace_id and screen_profile, we never return the row to the client.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');

const { db }                = require('../db/database');
const { deviceTokenAuth }   = require('../middleware/deviceTokenAuth');
const { bearerAuth }        = require('../middleware/apiToken');
const { resolveTenancy }    = require('../lib/tenancy');
const { resolveDevicePlaylist, resolvedLayoutId, resolveDeviceContext } = require('../lib/resolve-device-playlist');
const { parseProfile, listPresets } = require('../lib/embedded-profiles');
const { cacheKey, toETag, isNotModified, get: cacheGet, set: cacheSet } = require('../lib/embedded-cache');
const { render, renderLayout, isLayoutImageOnly, isBrowserAvailable, looksLikeImage } = require('../lib/embedded-render');
const { postprocess }       = require('../lib/embedded-postprocess');
const pairLockout           = require('../lib/pair-lockout');
const { sixDigitCode }      = require('../lib/numeric-code');
const ScheduleEval          = require('../lib/schedule-eval');
const PlayOrder             = require('../lib/play-order');
const { effectiveDeviceTz } = require('../lib/device-timezone');

// ─── Auth helper ───────────────────────────────────────────────────────────────

/*
 * Resolve authentication for the embedded endpoints.
 *
 * Tries device token first. If the Authorization header starts with 'Bearer st_',
 * falls through to the standard API token path.
 *
 * After resolution, req.device (device token path) or req.user (API token path)
 * is set, and req.workspaceId is always set.
 *
 * Returns false and sends a 401/400 response if auth fails.
 */
function resolveAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer st_')) {
    // API token path (preview / dashboard use)
    return bearerAuth(req, res, (err) => {
      if (err) return next(err);
      // This router was mounted outside the PUBLIC_ROUTERS bearerAuth+tokenScopeGate loop (it also
      // takes device tokens), so it never applied a scope gate. Every route here is a device-content
      // READ, so only read-ladder tokens (read/write/full) qualify. 'agency' (publish to designated
      // playlists) and 'billing:read' (global billing read) are off-ladder narrow grants and must not
      // be able to read arbitrary device renders in their bound workspace.
      const READ_LADDER = new Set(['read', 'write', 'full']);
      if (req.viaToken && !READ_LADDER.has(req.tokenScope)) {
        return res.status(403).json({ error: `API token scope '${req.tokenScope}' cannot read device content` });
      }
      resolveTenancy(req, res, next);
    });
  }
  // Device token path
  return deviceTokenAuth(req, res, next);
}

/*
 * After resolveAuth, get the target device row.
 *
 * - Device token path: req.device is already set.
 * - API token path: ?device_id is required; verify device is in the caller's workspace.
 */
function resolveDevice(req, res) {
  if (req.device) return req.device;

  const deviceId = req.query.device_id;
  if (!deviceId) {
    res.status(400).json({ error: 'device_id query parameter required' });
    return null;
  }

  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device) {
    res.status(404).json({ error: 'Device not found' });
    return null;
  }
  if (device.workspace_id !== req.workspaceId) {
    res.status(403).json({ error: 'Device belongs to a different workspace' });
    return null;
  }
  return device;
}

function touchDeviceHeartbeat(device, req) {
  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
  try {
    db.prepare(`
      UPDATE devices
      SET status = 'online',
          last_heartbeat = strftime('%s','now'),
          ip_address = CASE WHEN ? != '' THEN ? ELSE ip_address END,
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(clientIp, clientIp, device.id);
  } catch {
    // non-fatal
  }
  return clientIp;
}


// ─── Item cursor helpers ────────────────────────────────────────────────────────

const CURSOR_GET = db.prepare(
  'SELECT item_index, started_at FROM embedded_cursor WHERE device_id = ?'
);
const CURSOR_UPSERT = db.prepare(`
  INSERT INTO embedded_cursor (device_id, item_index, started_at)
  VALUES (?, ?, strftime('%s','now'))
  ON CONFLICT(device_id) DO UPDATE SET item_index = excluded.item_index,
                                       started_at = strftime('%s','now')
`);

/**
 * Compute dynamic revision bucket for time-varying widgets and remote dynamic content.
 */
function dynamicRevFor(item, nowSec) {
  if (!item) return 0;
  const now = typeof nowSec === 'number' ? nowSec : Math.floor(Date.now() / 1000);
  /*
   * ⚠️ THE EDIT REV RIDES ALONG. A time bucket says "this widget's OUTPUT changes on its own every
   * N seconds"; it does not say "and nobody edits it". The first version of this helper returned
   * the bucket ALONE for slide/rss/webpage/social/directory-board, so a slide's text edit changed
   * widgets.updated_at and nothing in the cache key — the panel kept answering 304 with the old
   * frame until the bucket rolled (a minute, or five). Before that, an edit was the ONLY thing
   * that changed the key, and it did so immediately. Both signals belong in it.
   */
  // Both shapes: the live join used *_updated_at, the snapshot reader carries *_rev for players.
  // Reading only one set is how an edit stopped invalidating the cache entirely.
  const edited = item.widget_updated_at || item.content_updated_at
    || item.widget_rev || item.content_rev || item.updated_at || 0;
  const bucket = (label, seconds) => `${label}_${Math.floor(now / seconds)}_${edited}`;
  switch (item.widget_type) {
    case 'clock':   return bucket('clock', 60);
    case 'weather': return bucket('weather', 600);
    // A slide only changes on its own when it binds a data source; a static deck re-rendered
    // in Chrome every minute is pure cost.
    case 'slide':   return String(item.widget_config || '').includes('{{ds:') ? bucket('slide', 60) : edited;
    case 'rss':     return bucket('rss', 300);
    case 'webpage': return bucket('webpage', 300);
    case 'social':  return bucket('social', 300);
    // The board polls its data every 60s (widgets.js); a 300s bucket showed stale rows.
    case 'directory-board': return bucket('directory', 60);
    default: break;
  }
  if (item.remote_url && !looksLikeImage(item.remote_url, item.mime_type)) {
    return bucket('url', 300);
  }
  return edited;
}

/*
 * Resolve the current playlist item for a device, advancing the cursor if the
 * current item's duration has elapsed.
 *
 * @param {string} deviceId
 * @param {string|null} forceIndex  Optional ?item= override (for testing).
 * @returns {{ item, content, itemIndex, expiresIn, total } | null}
 *   null when no playlist or no items.
 */
function resolveDeviceTimezone(device) {
  const devTz = effectiveDeviceTz(device);
  if (devTz) return devTz;
  if (device?.workspace_id) {
    try {
      const ws = db.prepare('SELECT timezone FROM workspaces WHERE id = ?').get(device.workspace_id);
      if (ws?.timezone) return ws.timezone;
    } catch (_) {}
  }
  return 'UTC';
}

function getPublishedPlaylistItems(playlistId) {
  if (!playlistId) return [];
  const playlist = db.prepare('SELECT published_snapshot, workspace_id FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist?.published_snapshot) return [];
  let items = [];
  try {
    items = JSON.parse(playlist.published_snapshot);
    if (!Array.isArray(items)) return [];
  } catch (_) {
    return [];
  }
  /*
   * ⚠️ THE SNAPSHOT IS NOT A SUPERSET OF WHAT THE RENDERER NEEDS.
   *
   * published_snapshot is built for players (ws/deviceSocket.js), and it omits four columns the
   * embedded renderer reads. Each omission fails silently and differently:
   *
   *   thumbnail_path      a video item hands Jimp the .mp4, which throws, and isLayoutImageOnly
   *                       drops the whole layout to Chromium or to 501 where no browser exists
   *   widget_workspace_id every {{ds:...}} token resolves empty and workspace fonts fall back
   *   the *_updated_at    dynamicRevFor sees 0, the cache key never moves, and the panel is
   *   pair               answered 304 with a stale frame until the time bucket rolls
   *
   * Anything added to the renderer's read set has to be added here too.
   */
  for (const a of items) {
    if (a.widget_id) {
      try {
        const w = db.prepare('SELECT updated_at, workspace_id FROM widgets WHERE id = ?').get(a.widget_id);
        if (w) {
          a.widget_rev = w.updated_at ?? a.widget_rev ?? 0;
          a.widget_updated_at = w.updated_at ?? null;
          a.widget_workspace_id = w.workspace_id ?? null;
        }
      } catch (_) {}
    }
    if (a.content_id) {
      try {
        const c = db.prepare('SELECT COALESCE(NULLIF(updated_at, 0), created_at) AS rev, filepath, mime_type, file_size, thumbnail_path FROM content WHERE id = ?').get(a.content_id);
        if (c) {
          a.content_rev = c.rev ?? a.content_rev ?? 0;
          a.content_updated_at = c.rev ?? null;
          if (c.filepath) a.filepath = c.filepath;
          if (c.mime_type) a.mime_type = c.mime_type;
          if (c.file_size != null) a.file_size = c.file_size;
          if (c.thumbnail_path) a.thumbnail_path = c.thumbnail_path;
        }
      } catch (_) {}
    }
  }
  // Same bag the live player gets, so play_when can skip on e-ink too.
  try {
    const slugs = new Set();
    for (const it of items) { const s = it && it.play_when && it.play_when.slug; if (s) slugs.add(s); }
    if (slugs.size && playlist.workspace_id) {
      const stmt = db.prepare('SELECT cached_data FROM data_sources WHERE workspace_id = ? AND slug = ?');
      const bag = {};
      for (const slug of slugs) {
        const row = stmt.get(playlist.workspace_id, slug);
        try { bag[slug] = JSON.parse(row?.cached_data || 'null'); } catch { bag[slug] = null; }
      }
      for (const it of items) {
        const slug = it && it.play_when && it.play_when.slug;
        if (slug) it._ds = bag[slug];
      }
    }
  } catch (_) {}
  return items;
}

/*
 * Resolve the current playlist item for a device, advancing the cursor if the
 * current item's duration has elapsed.
 *
 * @param {string} deviceId
 * @param {string|null} forceIndex  Optional ?item= override (for testing).
 * @returns {{ item, content, itemIndex, expiresIn, total } | null}
 *   null when no playlist or no items.
 */
// The device default/standby image as a resolved e-ink item, or null. Shown when the panel would
// otherwise idle: no playlist, no items, or every item filtered out by its schedule (off times).
// E-ink renders STILLS only, so a non-image default is ignored (the panel keeps its own idle).
function defaultResolved(deviceId) {
  const row = db.prepare('SELECT default_content_id FROM devices WHERE id = ?').get(deviceId);
  if (!row || !row.default_content_id) return null;
  const c = db.prepare('SELECT id AS content_id, filename, mime_type, filepath, file_size, remote_url FROM content WHERE id = ?').get(row.default_content_id);
  if (!c || typeof c.mime_type !== 'string' || !c.mime_type.startsWith('image/')) return null;
  const item = Object.assign({}, c, { duration_sec: 3600 });
  return { item, content: item, itemIndex: 0, expiresIn: 3600, total: 1 };
}

function resolveCurrentItem(deviceId, forceIndex, { advance = true } = {}) {
  const { playlist_id } = resolveDeviceContext(deviceId);
  if (!playlist_id) return defaultResolved(deviceId);

  const device = db.prepare('SELECT id, workspace_id, timezone, reported_timezone FROM devices WHERE id = ?').get(deviceId);
  const tz = resolveDeviceTimezone(device);

  const allItems = getPublishedPlaylistItems(playlist_id);
  // E-ink cannot rasterize a live stream, so a video/hls item is never playable here —
  // treated as ineligible so PlayOrder skips it and the panel shows the next real item
  // (or idles if there is none). No attempt to decode a stream to a still frame.
  const allows = (it) => it && it.mime_type !== 'video/hls' && it.mime_type !== 'video/rtsp' && ScheduleEval.itemShouldPlay(it, Date.now(), tz);
  const modeRow = db.prepare('SELECT published_playback_order FROM playlists WHERE id = ?').get(playlist_id);
  const mode = (modeRow && modeRow.published_playback_order) || 'sequential';
  if (!allItems.length) return defaultResolved(deviceId);

  const now = Math.floor(Date.now() / 1000);

  if (forceIndex !== undefined && forceIndex !== null) {
    const raw = Number(forceIndex);
    const parsed = Number.isInteger(raw) ? raw : 0;
    const idx  = Math.max(0, Math.min(parsed, allItems.length - 1));
    const item = allItems[idx];
    return { item, content: item, itemIndex: idx, expiresIn: item.duration_sec || 30, total: allItems.length };
  }

  let cursor = CURSOR_GET.get(deviceId);
  if (!cursor) {
    if (advance) CURSOR_UPSERT.run(deviceId, 0);
    cursor = { item_index: 0, started_at: now };
  }

  let idx        = cursor.item_index;
  let startedAt  = cursor.started_at;
  const st = (resolveCurrentItem._order = resolveCurrentItem._order || new Map());
  if (!st.has(deviceId)) st.set(deviceId, {});
  const state = st.get(deviceId);
  const duration = (allItems[idx] && (allItems[idx].duration_sec || 30)) || 30;
  const elapsed  = now - startedAt;

  if (idx < 0 || idx >= allItems.length || elapsed >= duration || !allows(allItems[idx])) {
    const next = PlayOrder.nextIndex(allItems, idx, allows, mode, state);
    if (next < 0) return defaultResolved(deviceId);
    idx = next;
    if (advance) CURSOR_UPSERT.run(deviceId, idx);   // read-only callers (/info, preview) must not move the panel
    startedAt = now;
  }

  const currentItem = allItems[idx];
  const currentDuration = currentItem.duration_sec || 30;
  const expiresIn = Math.max(1, currentDuration - (now - startedAt));

  return {
    item: currentItem,
    content: currentItem,
    itemIndex: idx,
    expiresIn,
    total: allItems.length,
  };
}

const ZONE_CURSOR_GET = db.prepare(
  'SELECT item_index, started_at FROM embedded_zone_cursor WHERE device_id = ? AND zone_id = ?'
);
const ZONE_CURSOR_UPSERT = db.prepare(`
  INSERT INTO embedded_zone_cursor (device_id, zone_id, item_index, started_at)
  VALUES (?, ?, ?, strftime('%s','now'))
  ON CONFLICT(device_id, zone_id) DO UPDATE SET item_index = excluded.item_index,
                                                 started_at = strftime('%s','now')
`);

/*
 * Resolve all active items per zone for a device's assigned layout.
 *
 * @param {string} deviceId
 * @param {string|number|null} forceIndex
 * @param {{ advance?: boolean }} [options]
 * @returns {{ layout, zoneEntries, expiresIn, dynamicRev, pendingAdvances } | null}
 *   null when device has no layout or layout has no zones.
 */
function resolveLayoutItems(deviceId, forceIndex, { advance = true } = {}) {
  const { playlist_id, layout_id: layoutId } = resolveDeviceContext(deviceId);
  if (!layoutId) return null;

  const layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(layoutId);
  if (!layout) return null;

  const zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order ASC, id ASC').all(layoutId);
  if (!zones || !zones.length) return null;

  let allItems = [];
  if (playlist_id) {
    const device = db.prepare('SELECT id, workspace_id, timezone, reported_timezone FROM devices WHERE id = ?').get(deviceId);
    const tz = resolveDeviceTimezone(device);
    // Zoned e-ink also skips live streams — they cannot be rasterized to a panel.
    allItems = getPublishedPlaylistItems(playlist_id).filter((it) => it && it.mime_type !== 'video/hls' && it.mime_type !== 'video/rtsp' && ScheduleEval.itemShouldPlay(it, Date.now(), tz));
  }

  // If the device has no items in its assigned playlist, return null so caller returns 404
  if (!allItems.length) return null;

  // Identify valid zones and find the largest zone by area for orphan assignment
  // Area calculation matches player/index.html:5769 ((w||0)*(h||0))
  const validZoneIds = new Set(zones.map(z => z.id));
  const fallbackZone = zones.reduce(
    (a, b) => (((Number(b.width_percent) || 0) * (Number(b.height_percent) || 0)) > ((Number(a.width_percent) || 0) * (Number(a.height_percent) || 0)) ? b : a),
    zones[0]
  );

  // Bucket items per zone matching player parity (player/index.html:5767-5801)
  const byZone = {};
  for (const a of allItems) {
    let zid = a.zone_id || '__none__';
    if (a.zone_id && !validZoneIds.has(a.zone_id) && fallbackZone) {
      zid = fallbackZone.id;
    }
    (byZone[zid] = byZone[zid] || []).push(a);
  }
  for (const k in byZone) byZone[k].sort((x, y) => (x.sort_order || 0) - (y.sort_order || 0));

  let unassignedUsed = false;
  const now = Math.floor(Date.now() / 1000);
  const zoneEntries = [];
  const expiresList = [];
  const dynamicRevParts = [layout.updated_at || layout.id];
  const pendingAdvances = [];

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    let matchingItems = byZone[zone.id];
    if ((!matchingItems || !matchingItems.length) && !unassignedUsed && byZone['__none__']) {
      unassignedUsed = true;
      matchingItems = byZone['__none__'];
    }
    matchingItems = matchingItems || [];

    if (!matchingItems.length) {
      zoneEntries.push({ zone, item: null, content: null });
      dynamicRevParts.push(`z_${zone.id}_empty`);
      continue;
    }

    let idx;
    let startedAt;

    if (forceIndex !== undefined && forceIndex !== null) {
      const raw = Number(forceIndex);
      const parsed = Number.isInteger(raw) ? raw : 0;
      idx = Math.max(0, Math.min(parsed, matchingItems.length - 1));
      startedAt = now;
    } else {
      let cursor = ZONE_CURSOR_GET.get(deviceId, zone.id);
      if (!cursor) {
        pendingAdvances.push({ zoneId: zone.id, index: 0 });
        if (advance) {
          ZONE_CURSOR_UPSERT.run(deviceId, zone.id, 0);
        }
        cursor = { item_index: 0, started_at: now };
      }

      idx = cursor.item_index % matchingItems.length;
      startedAt = cursor.started_at;
      const currentItem = matchingItems[idx];
      const duration = currentItem.duration_sec || 30;
      const elapsed = now - startedAt;

      if (elapsed >= duration) {
        idx = (idx + 1) % matchingItems.length;
        pendingAdvances.push({ zoneId: zone.id, index: idx });
        if (advance) {
          ZONE_CURSOR_UPSERT.run(deviceId, zone.id, idx);
        }
        startedAt = now;
      }
    }

    const item = matchingItems[idx];
    const itemDuration = item.duration_sec || 30;
    const expiresIn = Math.max(1, itemDuration - (now - startedAt));
    expiresList.push(expiresIn);

    const dRev = dynamicRevFor(item, now);
    dynamicRevParts.push(`z_${zone.id}_${item.content_id || item.widget_id || item.id || 'item'}_${dRev}`);

    zoneEntries.push({ zone, item, content: item });
  }

  const expiresIn = expiresList.length ? Math.min(...expiresList) : 60;
  return {
    layout,
    zoneEntries,
    expiresIn,
    dynamicRev: dynamicRevParts.join(';'),
    pendingAdvances,
  };
}

// ─── POST /api/embedded/pair/register ───────────────────────────────────────────
// An embedded device requests a server-generated 6-digit pairing code to show on screen.
// Returns the CSPRNG pairing_code and a cryptographic claim_secret.
router.post('/pair/register', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (pairLockout.isLocked(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const { screen_profile, screen_width, screen_height } = req.body || {};
  const id = crypto.randomUUID();
  const newToken = crypto.randomBytes(32).toString('hex');
  const claimSecret = crypto.randomBytes(32).toString('hex');
  const width = parseInt(screen_width) || 800;
  const height = parseInt(screen_height) || 480;
  const profile = typeof screen_profile === 'object' ? JSON.stringify(screen_profile) : (screen_profile || 'seeed-reterminal-sticky');

  let code;
  let inserted = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = sixDigitCode(); // CSPRNG (lib/numeric-code): server generates code, caller cannot choose
    try {
      db.prepare(`
        INSERT INTO devices (id, pairing_code, device_token, claim_secret, status, client_type, screen_profile, screen_width, screen_height, render_width, render_height, last_heartbeat)
        VALUES (?, ?, ?, ?, 'provisioning', 'embedded', ?, ?, ?, ?, ?, strftime('%s','now'))
      `).run(id, code, newToken, claimSecret, profile, width, height, width, height);
      inserted = true;
      break;
    } catch (e) {
      // Collision on pairing_code UNIQUE; retry with a fresh code
    }
  }

  if (!inserted) {
    pairLockout.recordFailure(ip);
    return res.status(500).json({ error: 'Failed to allocate unique pairing code. Please retry.' });
  }

  res.json({
    status: 'ok',
    device_id: id,
    pairing_code: code,
    claim_secret: claimSecret,
    message: 'Display registered for pairing. Show code on screen.',
  });
});

// ─── GET /api/embedded/pair/status ──────────────────────────────────────────────
// Embedded device polls to check if the user entered the pairing code in the dashboard.
// Protected by claim_secret (Bearer token or ?claim_secret=).
router.get('/pair/status', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (pairLockout.isLocked(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const { device_id } = req.query;
  if (!device_id) {
    return res.status(400).json({ error: 'device_id required' });
  }

  const authHeader = req.headers['authorization'];
  const claimSecret = (authHeader && authHeader.startsWith('Bearer '))
    ? authHeader.slice(7).trim()
    : (req.query.claim_secret ? String(req.query.claim_secret).trim() : null);

  if (!claimSecret) {
    pairLockout.recordFailure(ip);
    return res.status(401).json({ error: 'Authorization: Bearer <claim_secret> required' });
  }

  const device = db.prepare('SELECT id, status, workspace_id, device_token, pairing_code, claim_secret FROM devices WHERE id = ?').get(device_id);
  if (!device) {
    pairLockout.recordFailure(ip);
    return res.status(404).json({ error: 'Device not found' });
  }

  // Constant-time comparison for claim_secret
  const bufA = Buffer.from(claimSecret, 'utf8');
  const bufB = Buffer.from(device.claim_secret || '', 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    pairLockout.recordFailure(ip);
    return res.status(401).json({ error: 'Invalid claim secret' });
  }

  // Once claimed into a workspace, return token and burn claim_secret
  if (device.workspace_id && device.status !== 'provisioning') {
    db.prepare("UPDATE devices SET claim_secret = NULL WHERE id = ?").run(device_id);
    pairLockout.reset(ip);

    return res.json({
      paired: true,
      status: 'online',
      device_id: device.id,
      device_token: device.device_token,
    });
  }

  db.prepare("UPDATE devices SET last_heartbeat = strftime('%s','now') WHERE id = ?").run(device_id);
  res.json({
    paired: false,
    status: 'provisioning',
    pairing_code: device.pairing_code,
  });
});

// ─── GET /api/embedded/info ─────────────────────────────────────────────────────

router.get('/info', resolveAuth, (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  touchDeviceHeartbeat(device, req);
  const profile = parseProfile(device.screen_profile);
  // /info is metadata (MCU negotiation / debugging / monitors). It must NOT advance the panel's
  // cursor, or a poll that lands after the current item's dwell would make the real render skip an item.
  const resolved = resolveCurrentItem(device.id, req.query.item, { advance: false });

  res.json({
    device_id: device.id,
    device_name: device.name,
    screen_profile: profile,
    presets: listPresets(),
    playlist: resolved
      ? { item_count: resolved.total, current_index: resolved.itemIndex }
      : null,
    current_item: resolved
      ? {
          index: resolved.itemIndex,
          content_id: resolved.content?.content_id || null,
          content_type: resolved.item?.widget_id ? 'widget' : (resolved.content?.mime_type || null),
          expires_in_seconds: resolved.expiresIn,
        }
      : null,
    server_time_utc: new Date().toISOString(),
  });
});

// ─── GET /api/embedded/presets ──────────────────────────────────────────────────

router.get('/presets', resolveAuth, (req, res) => {
  res.json(listPresets());
});

// ─── GET /api/embedded/render ───────────────────────────────────────────────────

router.get('/render', resolveAuth, async (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  const profile = parseProfile(device.screen_profile);
  if (!profile) {
    return res.status(400).json({
      error: 'Embedded rendering not configured for this device.',
      hint: 'Set devices.screen_profile (use GET /api/embedded/presets for options).',
    });
  }

  // Allow optional query overrides (e.g. ?format=jpeg or ?format=png or ?dither=atkinson for previewing)
  if (req.query.format) {
    const fmt = String(req.query.format).toLowerCase();
    if (fmt === 'png' || fmt === 'jpeg' || fmt === 'jpg' || fmt === 'bmp' || fmt === 'raw' || fmt === 'x-epd-packed') {
      profile.outputFormat = fmt;
    }
  }
  if (req.query.dither) {
    const d = String(req.query.dither).toLowerCase();
    if (d === 'floyd-steinberg' || d === 'atkinson' || d === 'none') {
      profile.dither = d;
    }
  }

  // Query mode overrides
  if (req.query.mode === 'single') {
    return handleRenderStandard(req, res, device, profile);
  }
  if (req.query.mode === 'layout') {
    return handleRenderLayout(req, res, device, profile, { explicitMode: true });
  }

  // Automatic multi-zone layout detection
  const forceIndex = req.query.item !== undefined ? req.query.item : null;
  const layoutResolved = resolveLayoutItems(device.id, forceIndex, { advance: false });

  if (layoutResolved && layoutResolved.zoneEntries.length > 1) {
    const isImageOnly = isLayoutImageOnly(layoutResolved.zoneEntries);
    if (!isImageOnly && !isBrowserAvailable()) {
      return handleRenderStandard(req, res, device, profile, { isFallback: true });
    }
    return handleRenderLayout(req, res, device, profile, { explicitMode: false, preResolved: layoutResolved });
  }

  return handleRenderStandard(req, res, device, profile);
});

// ─── GET /api/embedded/render-layout ────────────────────────────────────────────

router.get('/render-layout', resolveAuth, async (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  const profile = parseProfile(device.screen_profile);
  if (!profile) {
    return res.status(400).json({
      error: 'Embedded rendering not configured for this device.',
      hint: 'Set devices.screen_profile (use GET /api/embedded/presets for options).',
    });
  }

  if (req.query.format) {
    const fmt = String(req.query.format).toLowerCase();
    if (fmt === 'png' || fmt === 'jpeg' || fmt === 'jpg' || fmt === 'bmp' || fmt === 'raw' || fmt === 'x-epd-packed') {
      profile.outputFormat = fmt;
    }
  }
  if (req.query.dither) {
    const d = String(req.query.dither).toLowerCase();
    if (d === 'floyd-steinberg' || d === 'atkinson' || d === 'none') {
      profile.dither = d;
    }
  }

  return handleRenderLayout(req, res, device, profile, { explicitMode: true });
});

async function handleRenderStandard(req, res, device, profile, opts = {}) {
  const ac = opts.signal ? null : new AbortController();
  if (ac) {
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
  }
  const signal = opts.signal || ac.signal;

  const forceIndex = req.query.item !== undefined ? req.query.item : null;
  const isPreview = req.query.preview === '1';
  // A dashboard preview must not advance the real device's cursor (an ?item= override already never
  // does). A genuine device render still advances, time-gated by the current item's dwell.
  const resolved = resolveCurrentItem(device.id, forceIndex, { advance: !isPreview });
  if (!resolved) {
    return res.status(404).json({ error: 'No playlist assigned or no active items for this device.' });
  }

  const clientIp = touchDeviceHeartbeat(device, req);
  const { item, content, itemIndex, expiresIn, total } = resolved;

  console.log(`[embedded] Device '${device.name}' (${device.id}) requested frame [item=${itemIndex + 1}/${total}] from ${clientIp}`);

  // ── Cache check ─────────────────────────────────────────────────────────────
  const dynamicRev = dynamicRevFor(item, Math.floor(Date.now() / 1000));

  const key = cacheKey(
    device.id,
    item.content_id || item.widget_id || item.id || 'item',
    dynamicRev,
    profile
  );

  // Common response headers
  const headers = {
    'ETag': toETag(key),
    'Cache-Control': 'no-store',
    'X-ST-Device-Id': device.id,
    'X-ST-Content-Id': content?.content_id || '',
    'X-ST-Expires-In': String(expiresIn),
    'X-ST-Item-Index': String(itemIndex),
    'X-ST-Total-Items': String(total),
  };
  if (opts.isFallback) {
    headers['X-ST-Layout-Fallback'] = '1';
  }

  if (!isPreview && isNotModified(key, req.headers['if-none-match'])) {
    res.set(headers).status(304).end();
    return;
  }

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (!isPreview) {
    const cached = cacheGet(key);
    if (cached.hit) {
      res.set({ ...headers, 'Content-Type': detectContentType(profile) });
      return res.status(200).send(cached.buffer);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  let renderResult;
  let renderItem = item;
  let renderContent = content;
  let renderIndex = itemIndex;

  for (let attempt = 0; attempt < total; attempt++) {
    try {
      renderResult = await render(renderItem, renderContent, profile, { signal });
      if (!renderResult.unsupported) break;
    } catch (e) {
      console.warn(`[embedded] item ${renderIndex} render error: ${e.message}`);
    }
    if (attempt < total - 1) {
      renderIndex = (renderIndex + 1) % total;
      const nextResolved = resolveCurrentItem(device.id, renderIndex);
      if (nextResolved) {
        renderItem = nextResolved.item;
        renderContent = nextResolved.content;
      }
    }
  }

  if (!renderResult || renderResult.unsupported) {
    return res.status(501).json({
      error: 'Content type not yet supported by Phase 1 renderer.',
      detail: renderResult?.reason || 'No renderable items in playlist',
    });
  }

  // ── Post-process ─────────────────────────────────────────────────────────────
  let processed;
  try {
    processed = await postprocess(renderResult.png, profile);
  } catch (e) {
    console.error('[embedded] postprocess error:', e.message);
    return res.status(500).json({ error: `Post-processing failed: ${e.message}` });
  }

  // Store in cache (non-blocking; non-fatal on failure)
  if (!isPreview) {
    try { cacheSet(key, processed.buffer); } catch { /* best-effort */ }
  }

  res.set({ ...headers, 'Content-Type': processed.contentType });
  res.status(200).send(processed.buffer);
}

async function handleRenderLayout(req, res, device, profile, opts = {}) {
  const ac = opts.signal ? null : new AbortController();
  if (ac) {
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
  }
  const signal = opts.signal || ac.signal;

  const isExplicit = opts.explicitMode || req.query.mode === 'layout' || req.baseUrl?.endsWith('render-layout') || req.path?.includes('render-layout');
  const forceIndex = req.query.item !== undefined ? req.query.item : null;

  const resolved = opts.preResolved || resolveLayoutItems(device.id, forceIndex, { advance: false });
  if (!resolved || resolved.zoneEntries.length === 0) {
    if (isExplicit) {
      return res.status(404).json({ error: 'Device has no multi-zone layout assigned or no active items.' });
    }
    return handleRenderStandard(req, res, device, profile, { ...opts, isFallback: true, signal });
  }

  const isImageOnly = isLayoutImageOnly(resolved.zoneEntries);
  if (!isImageOnly && !isBrowserAvailable()) {
    if (isExplicit) {
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: 'Browser unavailable for multi-zone rendering with widgets or web pages',
      });
    }
    return handleRenderStandard(req, res, device, profile, { ...opts, isFallback: true, signal });
  }

  // Persist pending cursor advances now that the layout is confirmed for rendering
  if (!forceIndex && resolved.pendingAdvances && resolved.pendingAdvances.length > 0) {
    for (const adv of resolved.pendingAdvances) {
      ZONE_CURSOR_UPSERT.run(device.id, adv.zoneId, adv.index);
    }
  }

  const clientIp = touchDeviceHeartbeat(device, req);
  const { layout, zoneEntries, expiresIn, dynamicRev } = resolved;
  const isPreview = req.query.preview === '1';

  console.log(`[embedded] Device '${device.name}' (${device.id}) requested multi-zone frame [layout=${layout.name || layout.id}] from ${clientIp}`);

  // ── Cache check ─────────────────────────────────────────────────────────────
  const key = cacheKey(
    device.id,
    'layout_' + layout.id,
    dynamicRev,
    profile
  );

  const headers = {
    'ETag': toETag(key),
    'Cache-Control': 'no-store',
    'X-ST-Device-Id': device.id,
    'X-ST-Layout-Id': layout.id,
    'X-ST-Content-Id': layout.id,
    'X-ST-Expires-In': String(expiresIn),
    'X-ST-Item-Index': '0',
    'X-ST-Total-Zones': String(zoneEntries.length),
  };

  if (!isPreview && isNotModified(key, req.headers['if-none-match'])) {
    res.set(headers).status(304).end();
    return;
  }

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (!isPreview) {
    const cached = cacheGet(key);
    if (cached.hit) {
      res.set({ ...headers, 'Content-Type': detectContentType(profile) });
      return res.status(200).send(cached.buffer);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  let renderResult;
  try {
    renderResult = await renderLayout(layout, zoneEntries, profile, { signal, device });
  } catch (e) {
    console.error(`[embedded] multi-zone layout render error: ${e.message}`);
    if (isExplicit) {
      return res.status(500).json({
        error: 'Multi-zone layout rendering failed.',
        detail: 'An unexpected error occurred while rendering the layout.',
      });
    }
    return handleRenderStandard(req, res, device, profile, { ...opts, isFallback: true, signal });
  }

  if (!renderResult || renderResult.unsupported) {
    if (isExplicit) {
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: renderResult?.reason || 'Browser unavailable for multi-zone rendering',
      });
    }
    // Auto mode fallback to standard single-item rendering
    return handleRenderStandard(req, res, device, profile, { ...opts, isFallback: true, signal });
  }

  // ── Post-process ─────────────────────────────────────────────────────────────
  let processed;
  try {
    processed = await postprocess(renderResult.png, profile);
  } catch (e) {
    console.error('[embedded] postprocess error:', e.message);
    return res.status(500).json({ error: `Post-processing failed: ${e.message}` });
  }

  if (!isPreview) {
    try { cacheSet(key, processed.buffer); } catch { /* best-effort */ }
  }

  res.set({ ...headers, 'Content-Type': processed.contentType });
  res.status(200).send(processed.buffer);
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

function detectContentType(profile) {
  switch (profile.outputFormat) {
    case 'png': return 'image/png';
    case 'jpeg':
    case 'jpg': return 'image/jpeg';
    case 'bmp': return 'image/bmp';
    default:    return 'application/octet-stream';
  }
}

module.exports = router;
module.exports.resolveCurrentItem = resolveCurrentItem;
module.exports.resolveLayoutItems = resolveLayoutItems;
module.exports.resolveDevicePlaylist = resolveDevicePlaylist;
module.exports.resolvedLayoutId = resolvedLayoutId;
module.exports.resolveDeviceContext = resolveDeviceContext;
module.exports.dynamicRevFor = dynamicRevFor;


