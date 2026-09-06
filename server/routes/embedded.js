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
const { render, renderLayout, isLayoutImageOnly, isBrowserAvailable } = require('../lib/embedded-render');
const { postprocess }       = require('../lib/embedded-postprocess');
const pairLockout           = require('../lib/pair-lockout');
const { sixDigitCode }      = require('../lib/numeric-code');

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

/*
 * Resolve the current playlist item for a device, advancing the cursor if the
 * current item's duration has elapsed.
 *
 * @param {string} deviceId
 * @param {string|null} forceIndex  Optional ?item= override (for testing).
 * @returns {{ item, content, itemIndex, expiresIn } | null}
 *   null when no playlist or no items.
 */
function resolveCurrentItem(deviceId, forceIndex) {
  const { playlist_id } = resolveDeviceContext(deviceId);
  if (!playlist_id) return null;

  // Fetch all active, published items in playlist order (joining content and widgets).
  const items = db.prepare(`
    SELECT pi.*, pl.workspace_id, c.mime_type, c.filepath, c.remote_url, c.thumbnail_path,
           c.updated_at AS content_updated_at, c.id AS content_id,
           w.widget_type, w.config AS widget_config, w.name AS widget_name,
           w.updated_at AS widget_updated_at
    FROM playlist_items pi
    JOIN playlists pl ON pl.id = pi.playlist_id
    LEFT JOIN content c ON c.id = pi.content_id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
      AND (pl.status = 'published' OR pl.status IS NULL)
      AND (c.id IS NULL OR c.is_active IS NULL OR c.is_active = 1)
    ORDER BY pi.sort_order ASC, pi.id ASC
  `).all(playlist_id);

  if (!items.length) return null;

  const now = Math.floor(Date.now() / 1000);

  // If caller forces an index (for testing), honour it directly.
  if (forceIndex !== undefined && forceIndex !== null) {
    const raw = Number(forceIndex);
    const parsed = Number.isInteger(raw) ? raw : 0;
    const idx  = Math.max(0, Math.min(parsed, items.length - 1));
    const item = items[idx];
    return { item, content: item, itemIndex: idx, expiresIn: item.duration_sec || 30, total: items.length };
  }

  // Load or initialise cursor
  let cursor = CURSOR_GET.get(deviceId);
  if (!cursor) {
    CURSOR_UPSERT.run(deviceId, 0);
    cursor = { item_index: 0, started_at: now };
  }

  let idx        = cursor.item_index % items.length;
  let startedAt  = cursor.started_at;
  const item     = items[idx];
  const duration = item.duration_sec || 30;
  const elapsed  = now - startedAt;

  // Advance if the current item's time has passed
  if (elapsed >= duration) {
    idx = (idx + 1) % items.length;
    CURSOR_UPSERT.run(deviceId, idx);
    startedAt = now;
  }

  const currentItem = items[idx];
  const currentDuration = currentItem.duration_sec || 30;
  const expiresIn = Math.max(1, currentDuration - (now - startedAt));

  return {
    item: currentItem,
    content: currentItem,
    itemIndex: idx,
    expiresIn,
    total: items.length,
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
 * @returns {{ layout, zoneEntries, expiresIn, dynamicRev } | null}
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
    allItems = db.prepare(`
      SELECT pi.*, pl.workspace_id, c.mime_type, c.filepath, c.remote_url, c.thumbnail_path,
             c.updated_at AS content_updated_at, c.id AS content_id,
             w.widget_type, w.config AS widget_config, w.name AS widget_name,
             w.updated_at AS widget_updated_at
      FROM playlist_items pi
      JOIN playlists pl ON pl.id = pi.playlist_id
      LEFT JOIN content c ON c.id = pi.content_id
      LEFT JOIN widgets w ON pi.widget_id = w.id
      WHERE pi.playlist_id = ?
        AND (pl.status = 'published' OR pl.status IS NULL)
        AND (c.id IS NULL OR c.is_active IS NULL OR c.is_active = 1)
      ORDER BY pi.sort_order ASC, pi.id ASC
    `).all(playlist_id);
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

    let dRev = item.widget_updated_at || item.content_updated_at || item.updated_at || 0;
    if (item.widget_type === 'clock') {
      dRev = `clock_${Math.floor(now / 60)}`;
    } else if (item.widget_type === 'weather') {
      dRev = `weather_${Math.floor(now / 600)}`;
    } else if (item.widget_type === 'slide') {
      dRev = `slide_${Math.floor(now / 60)}`;
    }
    dynamicRevParts.push(`z_${zone.id}_${item.id}_${dRev}`);

    zoneEntries.push({ zone, item, content: item });
  }

  const expiresIn = expiresList.length ? Math.min(...expiresList) : 60;
  return {
    layout,
    zoneEntries,
    expiresIn,
    dynamicRev: dynamicRevParts.join(';'),
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
  const resolved = resolveCurrentItem(device.id, req.query.item);

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
  if (req.query.mode === 'layout') {
    return handleRenderLayout(req, res, device, profile, { explicitMode: true });
  }
  if (req.query.mode === 'single') {
    return handleRenderStandard(req, res, device, profile);
  }

  // Automatic multi-zone layout detection
  const { layout_id: layoutId } = resolveDeviceContext(device.id);
  if (layoutId) {
    const zoneCount = db.prepare('SELECT COUNT(*) AS count FROM layout_zones WHERE layout_id = ?').get(layoutId)?.count || 0;
    if (zoneCount >= 1) {
      const forceIndex = req.query.item !== undefined ? req.query.item : null;
      const probe = resolveLayoutItems(device.id, forceIndex, { advance: false });
      if (probe) {
        const isImageOnly = isLayoutImageOnly(probe.zoneEntries);
        if (!isImageOnly && !isBrowserAvailable()) {
          // Browser is not available and layout has non-image items (widgets/web).
          // Fall back to single-item standard render with fallback header.
          return handleRenderStandard(req, res, device, profile, { isFallback: true });
        }
        return handleRenderLayout(req, res, device, profile, { explicitMode: false });
      }
    }
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
  const forceIndex = req.query.item !== undefined ? req.query.item : null;
  const resolved = resolveCurrentItem(device.id, forceIndex);
  if (!resolved) {
    return res.status(404).json({ error: 'No playlist assigned or no active items for this device.' });
  }

  const clientIp = touchDeviceHeartbeat(device, req);
  const { item, content, itemIndex, expiresIn, total } = resolved;
  const isPreview = req.query.preview === '1';

  console.log(`[embedded] Device '${device.name}' (${device.id}) requested frame [item=${itemIndex + 1}/${total}] from ${clientIp}`);

  // ── Cache check ─────────────────────────────────────────────────────────────
  let dynamicRev = item.widget_updated_at || content?.content_updated_at || item.updated_at || 0;
  if (item.widget_type === 'clock') {
    dynamicRev = `clock_${Math.floor(Date.now() / 60000)}`; // invalidate every minute
  } else if (item.widget_type === 'weather') {
    dynamicRev = `weather_${Math.floor(Date.now() / 600000)}`; // invalidate every 10 min
  } else if (item.widget_type === 'slide') {
    dynamicRev = `slide_${Math.floor(Date.now() / 60000)}`; // invalidate every minute for dynamic content/clocks
  }

  const key = cacheKey(
    device.id,
    item.id,
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
      renderResult = await render(renderItem, renderContent, profile);
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
  const isExplicit = opts.explicitMode || req.query.mode === 'layout' || req.baseUrl?.endsWith('render-layout') || req.path?.includes('render-layout');
  const forceIndex = req.query.item !== undefined ? req.query.item : null;

  // Probe layout first without advancing cursors
  const probe = resolveLayoutItems(device.id, forceIndex, { advance: false });
  // Fall back to standard single-item render if device has no multi-zone layout
  if (!probe) {
    if (isExplicit) {
      return res.status(404).json({ error: 'Device has no multi-zone layout assigned or no active items.' });
    }
    return handleRenderStandard(req, res, device, profile, { isFallback: true });
  }

  const isImageOnly = isLayoutImageOnly(probe.zoneEntries);
  if (!isImageOnly && !isBrowserAvailable()) {
    if (isExplicit) {
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: 'Browser unavailable for multi-zone rendering with widgets or web pages',
      });
    }
    return handleRenderStandard(req, res, device, profile, { isFallback: true });
  }

  // Advance cursors and resolve actual items
  const resolved = resolveLayoutItems(device.id, forceIndex, { advance: true });
  if (!resolved) {
    if (isExplicit) {
      return res.status(404).json({ error: 'Device has no multi-zone layout assigned or no active items.' });
    }
    return handleRenderStandard(req, res, device, profile, { isFallback: true });
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
    renderResult = await renderLayout(layout, zoneEntries, profile);
  } catch (e) {
    console.error(`[embedded] multi-zone layout render error: ${e.message}`);
    if (isExplicit) {
      return res.status(500).json({
        error: 'Multi-zone layout rendering failed.',
        detail: 'An unexpected error occurred while rendering the layout.',
      });
    }
    return handleRenderStandard(req, res, device, profile, { isFallback: true });
  }

  if (!renderResult || renderResult.unsupported) {
    if (isExplicit) {
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: renderResult?.reason || 'Browser unavailable for multi-zone rendering',
      });
    }
    // Auto mode fallback to standard single-item rendering
    return handleRenderStandard(req, res, device, profile, { isFallback: true });
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


