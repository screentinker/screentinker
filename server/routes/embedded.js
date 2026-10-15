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
const fs      = require('fs');
const path    = require('path');
const config  = require('../config');

const { db, pruneTelemetry }  = require('../db/database');
const { deviceTokenAuth }   = require('../middleware/deviceTokenAuth');
const { bearerAuth }        = require('../middleware/apiToken');
const { resolveTenancy }    = require('../lib/tenancy');
const { resolveDevicePlaylist, resolvedLayoutId, resolveDeviceContext } = require('../lib/resolve-device-playlist');
const { parseProfile, listPresets, frameDimensions, frameOrientation } = require('../lib/embedded-profiles');
const { cacheKey, toETag, isNotModified, get: cacheGet, set: cacheSet } = require('../lib/embedded-cache');
const { render, renderLayout, isLayoutImageOnly, isBrowserAvailable, looksLikeImage } = require('../lib/embedded-render');
const { postprocess }       = require('../lib/embedded-postprocess');
const pairLockout           = require('../lib/pair-lockout');
const { sixDigitCode }      = require('../lib/numeric-code');
const ScheduleEval          = require('../lib/schedule-eval');
const PlayOrder             = require('../lib/play-order');
const { effectiveDeviceTz } = require('../lib/device-timezone');
const PowerWindow           = require('../lib/power-window');
const { firmwareLimiter, deviceLogsLimiter } = require('../lib/embedded-rate-limits');
const { powerScheduleForDevice } = require('../lib/device-power-schedule');
const { popPendingCommands, peekPendingCommands, popCommand } = require('../lib/command-queue');
const otaBreaker            = require('../lib/ota-breaker');

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/*
 * The preset a device's firmware is filed under, or '' when it cannot be told.
 *
 * ⚠️ NO DEFAULT. An unknown or empty profile is not Sticky. Defaulting here pointed a non-Sticky
 * panel at Sticky firmware. Callers treat '' as "no update for this device".
 */
function normalizePresetName(profileOrPreset) {
  if (!profileOrPreset) return '';
  let str = profileOrPreset;
  if (typeof str === 'object') {
    str = str.preset || '';
  } else if (typeof str === 'string' && str.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      str = parsed.preset || '';
    } catch (_) {}
  }
  return String(str || '').replace(/-/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
}

/*
 * The `update <url> <sha256>` string for one queued update, or null when the device must not be
 * told to update. The device verifies the image against the digest in this string and refuses to
 * flash without one.
 *
 * ⚠️ ONLY EVER THIS SERVER'S OWN BINARY. The URL is always /api/embedded/firmware/<preset>/latest.bin
 * for the preset the panel is filed under, and the digest is the SHA-256 of that file. Anything the
 * caller put in the queued payload (url, binary_url, sha256, version) is ignored: a command payload
 * is operator- or API-supplied, and "flash whatever this URL serves, here is its hash" is remote
 * code execution on the panel with an integrity check the attacker wrote. The firmware's own
 * digest check cannot help when the digest arrived in the same message as the URL.
 *
 * An offer also needs a target version (version.json) so the breaker can judge it, and when
 * version.json declares a sha256 it must match the bytes on disk — a half-copied binary is not
 * offered.
 */
function buildUpdateOffer(deviceId, device, req, update) {
  const payload = (update && update.payload) || {};
  if (payload.url || payload.binary_url || (update && update.url)) {
    console.warn(`[ota] Device '${deviceId}': ignoring a caller-supplied firmware URL; only this server's own binary is offered`);
  }
  const preset = normalizePresetName(device?.screen_profile);
  if (!preset) return null;
  const fw = getFirmwareInfo(preset);
  if (!fw || !fw.sha256) return null;                 // no file on disk: nothing we can offer
  if (fw.declaredSha256 && fw.declaredSha256.toLowerCase() !== fw.sha256.toLowerCase()) {
    console.warn(`[ota] Firmware for '${preset}' does not match its version.json sha256; not offered`);
    return null;
  }
  const url = `/api/embedded/firmware/${preset}/latest.bin`;
  const sha = fw.sha256;
  const targetVersion = fw.version;

  if (!SHA256_HEX.test(String(sha))) return null;      // no verifiable digest: do not emit
  if (!targetVersion) return null;                      // no version.json: breaker cannot judge it

  // OTA breaker (RF-6 / S3). Consulted for every offer; not forgiven here. Forgiveness belongs to
  // an authenticated device reconnect (deviceSocket), not to each poll.
  const currentVersion = (req && req.headers ? (req.headers['x-st-firmware-version'] || req.headers['x-st-version']) : null)
    || device?.app_version || '1.0.0';
  const verdict = otaBreaker.decide(currentVersion, targetVersion, deviceId);
  if (!verdict.update_available) {
    console.log(`[ota] Device '${deviceId}' update held off by ota-breaker: reason=${verdict.reason}`);
    return null;
  }
  return `update ${url} ${sha}`;
}

/*
 * ⚠️ EVERY X-ST-Command VALUE IS CHECKED BEFORE IT IS SENT. A value Node refuses as a header
 * (CR/LF, other control characters, anything outside printable ASCII) throws inside res.set(), and
 * because the command is only popped once the response is written, it stayed queued and threw again
 * on every poll: one bad command wedged the panel until the queue TTL ran out. An unsendable or
 * oversized command is popped and logged here, and the next one in line is considered instead.
 */
const MAX_COMMAND_LENGTH = 512;   // `update <path> <64 hex>` is ~130; nothing legitimate comes near it
const SENDABLE_COMMAND = /^[\x21-\x7E][\x20-\x7E]*$/;
function isSendableCommand(str) {
  return typeof str === 'string' && str.length <= MAX_COMMAND_LENGTH && SENDABLE_COMMAND.test(str);
}

function commandStringFor(deviceId, device, req, cmd) {
  if (cmd.type === 'upload_logs') return 'upload_logs';
  if (cmd.type === 'update') return buildUpdateOffer(deviceId, device, req, cmd);
  return typeof cmd.type === 'string' ? cmd.type : null;
}

/*
 * The command to deliver on this response, or null. The one chosen is NOT popped here: the caller
 * pops it with markCommandDelivered() when the response carrying the X-ST-Command header is
 * written. Anything that cannot be sent (an update the breaker or the firmware check holds, a value
 * that is not a valid header) IS popped here, so it never sits in the queue re-failing.
 *
 * Order: upload_logs, then update, then reboot, then the rest first-in first-out.
 */
function resolvePendingCommand(deviceId, device, req) {
  if (!deviceId) return null;
  const cmds = peekPendingCommands(deviceId);
  if (!cmds || cmds.length === 0) return null;

  const rank = (c) => (c.type === 'upload_logs' ? 0 : c.type === 'update' ? 1 : c.type === 'reboot' ? 2 : 3);
  const ordered = cmds.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);

  for (const cmd of ordered) {
    let commandStr = null;
    try {
      commandStr = commandStringFor(deviceId, device, req, cmd);
    } catch (e) {
      console.warn(`[embedded] Device '${deviceId}': could not build queued '${String(cmd.type).slice(0, 40)}': ${e.message}`);
    }
    if (commandStr !== null && isSendableCommand(commandStr)) {
      return { type: cmd.type, commandStr };
    }
    // An update the breaker or the firmware check held is expected and already logged. Anything
    // else here is a command no panel could be sent.
    if (commandStr !== null || cmd.type !== 'update') {
      console.warn(`[embedded] Device '${deviceId}': dropped an unsendable queued command (${JSON.stringify(String(cmd.type)).slice(0, 60)}, ${String(commandStr ?? cmd.type).length} chars)`);
    }
    if (cmd.type !== undefined && cmd.type !== null) popCommand(deviceId, cmd.type);
  }
  return null;
}

/*
 * Run a render handler that may carry a queued command. If it throws (res.set() on a bad header,
 * anything else), the command it carried is dropped and logged rather than left to fail again on
 * every poll.
 */
async function withCommandDropOnThrow(deviceId, pendingCmdObj, run) {
  try {
    return await run();
  } catch (e) {
    if (pendingCmdObj && pendingCmdObj.type !== undefined) {
      popCommand(deviceId, pendingCmdObj.type);
      console.warn(`[embedded] Device '${deviceId}': dropped queued '${String(pendingCmdObj.type).slice(0, 40)}' after the response carrying it failed: ${e.message}`);
    }
    throw e;
  }
}

function getPendingCommand(deviceId, device, req, options = {}) {
  const resolved = resolvePendingCommand(deviceId, device, req);
  if (!resolved) return null;
  if (!options.peek) {
    popCommand(deviceId, resolved.type);
  }
  return resolved.commandStr;
}

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
      // takes device tokens), so it never applied a scope gate. What an API token may do here is
      // READ device content, so only read-ladder tokens (read/write/full) qualify. 'agency' (publish
      // to designated playlists) and 'billing:read' (global billing read) are off-ladder narrow grants
      // and must not be able to read arbitrary device renders in their bound workspace.
      //
      // ⚠️ The routes that WRITE what a panel reports about itself — POST /logs, and the orientation
      // touchDeviceHeartbeat remembers — are the device's alone and check req.device (the device-token
      // path) themselves. A token reading a render is a dashboard looking, not the panel speaking.
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

  const deviceId = req.query.device_id || req.headers['x-st-device-id'] || (req.body && req.body.device_id);
  if (!deviceId) {
    res.status(400).json({ error: 'device_id parameter required' });
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

/*
 * One call per REQUEST, however many times a handler reaches it. /render touches early (so a
 * device with no playlist still shows as alive) and the render path touches again once it knows
 * the item; without this guard every poll wrote two device_telemetry rows and pruned twice.
 */
const HEARTBEAT_DONE = Symbol('embeddedHeartbeat');

/*
 * ⚠️ NOT lib/device-command.deliverCommand — that one SENDS a command to a screen. This one only
 * records that a polled response carried it, so the queue can drop it.
 *
 * Pop the queued command at the moment a response carrying its X-ST-Command header is written.
 * Every status, including 304 and 404/501 that carry the header. A 304 that carries it has been
 * delivered, so leaving it queued would re-run update / reboot / upload_logs on every unchanged poll.
 */
function markCommandDelivered(deviceId, opts) {
  if (opts && opts.pendingCmdObj) popCommand(deviceId, opts.pendingCmdObj.type);
}

/*
 * Whole seconds until the next scheduled-off edge, or Infinity when there is none.
 *
 * nextEdge.minutes_until counts whole minutes from the current minute, so using it directly rounds
 * a panel 10 s from power-off up to a full minute. Take the sub-minute remainder from the clock.
 * Floored so the answer never runs past the real edge.
 */
function secondsUntilOffEdge(power, nowMs = Date.now()) {
  if (!power || !power.nextEdge || power.nextEdge.to !== 'scheduled_off') return Infinity;
  const minutes = Number(power.nextEdge.minutes_until);
  if (!Number.isFinite(minutes) || minutes < 1) return 1;
  const intoMinute = (nowMs % 60000) / 1000;
  return Math.max(1, Math.floor(minutes * 60 - intoMinute));
}

function touchDeviceHeartbeat(device, req) {
  if (req[HEARTBEAT_DONE] !== undefined) return req[HEARTBEAT_DONE];
  const clientIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').replace(/^::ffff:/, '');
  req[HEARTBEAT_DONE] = clientIp;
  noteNextCallOnFinish(device, req);

  // Extract optional telemetry headers reported by MCU/embedded devices
  const batteryHeader     = req.headers['x-st-device-battery'] || req.headers['x-st-battery'];
  const rssiHeader        = req.headers['x-st-device-rssi']    || req.headers['x-st-rssi'];
  const fwHeader          = req.headers['x-st-firmware-version'] || req.headers['x-st-app-version'] || req.headers['x-st-version'];
  const powerSourceHeader = req.headers['x-st-power-source'];
  const chargingHeader    = req.headers['x-st-charging'] || req.headers['x-st-battery-charging'];
  const tempHeader        = req.headers['x-st-device-temperature'] || req.headers['x-st-temperature'];
  const humidityHeader    = req.headers['x-st-device-humidity']    || req.headers['x-st-humidity'];

  let batteryLevel = null;
  if (batteryHeader !== undefined) {
    const parsed = parseInt(batteryHeader, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      batteryLevel = parsed;
    }
  }

  let wifiRssi = null;
  if (rssiHeader !== undefined) {
    const parsed = parseInt(rssiHeader, 10);
    if (Number.isFinite(parsed) && parsed <= 0 && parsed >= -120) {
      wifiRssi = parsed;
    }
  }

  const appVersion = typeof fwHeader === 'string' ? fwHeader.trim().slice(0, 64) || null : null;

  let powerSource = null;
  if (powerSourceHeader === 'usb' || powerSourceHeader === 'mains' || powerSourceHeader === 'external') {
    powerSource = 'usb';
  } else if (powerSourceHeader === 'battery') {
    powerSource = 'battery';
  }

  /*
   * ⚠️ 0 WHEN NOT REPORTED, NOT NULL. device_telemetry.battery_charging is NOT NULL DEFAULT 0
   * (schema.sql), and an explicit NULL does not fall back to the default: it fails the insert. With
   * NULL here every poll that sent the documented battery / RSSI headers but no X-ST-Charging lost
   * its whole telemetry row, silently, so the panel never got its battery or Wi-Fi card (2.6.0). 0 is
   * what every other player's rows mean by "not charging or not reported", and the dashboard only
   * acts on 1 ("charging").
   */
  let batteryCharging = 0;
  if (chargingHeader !== undefined) {
    batteryCharging = (chargingHeader === '1' || chargingHeader === 'true') ? 1 : 0;
  }

  let temperatureC = null;
  if (tempHeader !== undefined) {
    const parsed = parseFloat(tempHeader);
    if (Number.isFinite(parsed) && parsed >= -40 && parsed <= 85) {
      temperatureC = Math.round(parsed * 10) / 10;
    }
  }

  let humidity = null;
  if (humidityHeader !== undefined) {
    const parsed = parseFloat(humidityHeader);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      humidity = Math.round(parsed * 10) / 10;
    }
  }

  if (powerSource) {
    device.power_source = powerSource;
  }
  if (appVersion) {
    device.app_version = appVersion;
    // Progress for the OTA breaker (S3): every render that reports a version is evidence, whether or
    // not an update was queued. Without this, a device that updated and then stopped being offered
    // an update never clears its no-progress hold.
    otaBreaker.noteReportedVersion(device.id, appVersion);
  }

  /*
   * The orientation the PANEL stated on this request, remembered so a later poll (or a dashboard
   * preview) that states none renders the same way. ⚠️ Only from the device itself: never from a
   * dashboard preview (an operator looking, not the panel saying where it is mounted) and never
   * from an API token, which is a reader, not the panel. Stored in reported_orientation, NULL until
   * a panel says something — devices.orientation is 'landscape' on every row by schema default and
   * means nothing here.
   */
  const stated = statedOrientationRotation(req);
  const isPreviewReq = req.query?.preview === '1';
  const persistOrient = (req.device && !isPreviewReq && stated.orientation) ? stated.orientation : null;
  if (persistOrient) {
    device.reported_orientation = persistOrient;
  }

  try {
    db.prepare(`
      UPDATE devices
      SET status = 'online',
          last_heartbeat = strftime('%s','now'),
          ip_address = CASE WHEN ? != '' THEN ? ELSE ip_address END,
          app_version = COALESCE(?, app_version),
          power_source = COALESCE(?, power_source),
          reported_orientation = COALESCE(?, reported_orientation),
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(clientIp, clientIp, appVersion, powerSource, persistOrient, device.id);

    // If telemetry headers were provided, record a row in device_telemetry.
    // ⚠️ local_ip stays NULL: it means the screen's LAN address (the dashboard prints it as "Local
    // IP"), and all we have here is the address the request came from — the public NAT/proxy one,
    // already kept in devices.ip_address.
    if (batteryLevel !== null || wifiRssi !== null || powerSource !== null || temperatureC !== null || humidity !== null) {
      // ⚠️ No fallback insert and no inner catch: temperature_c / humidity are guaranteed by
      // schema.sql and the database.js migrations, and a swallowed error here is exactly what hid
      // the battery_charging constraint failure in 2.6.0 (#583). Failures go to the logged catch below.
      db.prepare(`
        INSERT INTO device_telemetry (device_id, battery_level, battery_charging, wifi_rssi, local_ip, power_source, temperature_c, humidity, reported_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?, ?, strftime('%s','now'))
      `).run(device.id, batteryLevel, batteryCharging, wifiRssi, powerSource, temperatureC, humidity);

      if (typeof pruneTelemetry === 'function') {
        pruneTelemetry(device.id);
      }
    }
  } catch (e) {
    // Non-fatal for the render, but never silent: a bare catch here hid a constraint failure that
    // dropped every embedded telemetry row for a whole release. Logged once per device per process.
    if (!_telemetryFailureLogged.has(device.id)) {
      _telemetryFailureLogged.add(device.id);
      console.warn(`[embedded] heartbeat/telemetry write failed for ${device.id}: ${e.message}`);
    }
  }
  return clientIp;
}
const _telemetryFailureLogged = new Set();

/**
 * When the response goes out, remember when this device said it will call next: X-ST-Expires-In is
 * the deep-sleep the MCU takes before polling again. The heartbeat sweep and the offline alerts
 * measure lateness from that instant (devices.heartbeat_expected_by), so a panel sleeping through a
 * power-schedule night is not reported offline every evening.
 *
 * ⚠️ Not for a dashboard preview or an ?item= override: those are an operator looking, not the
 * panel being told when to wake, and recording them would hide a genuinely dead screen.
 */
function noteNextCallOnFinish(device, req) {
  const res = req.res;
  if (!res || typeof res.once !== 'function') return;
  if (req.query?.preview === '1' || req.query?.item !== undefined) return;
  res.once('finish', () => {
    try {
      if (res.statusCode >= 400) return;
      const secs = Number(res.getHeader('X-ST-Expires-In'));
      if (!Number.isFinite(secs) || secs <= 0) return;
      db.prepare(`UPDATE devices SET heartbeat_expected_by = CAST(strftime('%s','now') AS INTEGER) + ? WHERE id = ?`)
        .run(Math.round(secs), device.id);
    } catch {
      // non-fatal: without it the device is merely judged by its last call, as before
    }
  });
}

/**
 * Evaluate the effective power schedule for an embedded device.
 *
 * Checks device-beats-group power schedule inheritance via powerScheduleForDevice.
 * If scheduled off, computes the sleep duration until the morning 'on' edge,
 * giving microcontrollers the exact duration to deep-sleep.
 *
 * @param {object} device
 * @param {Date|number} [now]
 * @returns {{
 *   schedule: object|null,
 *   isOff: boolean,
 *   state: 'on'|'scheduled_off',
 *   nextEdge: { at: string, to: 'on'|'scheduled_off', minutes_until: number }|null,
 *   sleepSeconds: number|null,
 * }}
 */
function evaluateDevicePower(device, now = Date.now()) {
  try {
    const schedule = powerScheduleForDevice(db, device.id);
    if (!schedule || !schedule.enabled) {
      return { schedule: null, isOff: false, state: 'on', nextEdge: null, sleepSeconds: null };
    }
    const isOff = PowerWindow.isOff(schedule, now);
    const state = PowerWindow.stateOf(schedule, now);
    const nextEdge = PowerWindow.nextEdge(schedule, now);
    let sleepSeconds = null;
    if (isOff) {
      sleepSeconds = (nextEdge && nextEdge.to === 'on')
        ? Math.max(60, nextEdge.minutes_until * 60)
        : 3600;
    }
    return { schedule, isOff, state, nextEdge, sleepSeconds };
  } catch (_) {
    return { schedule: null, isOff: false, state: 'on', nextEdge: null, sleepSeconds: null };
  }
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
  const period = dynamicPeriodFor(item);
  if (period) return `${period.label}_${Math.floor(now / period.seconds)}_${edited}`;
  return edited;
}

/*
 * How often an item's OUTPUT changes on its own, as { label, seconds }, or null for an item that
 * changes only when someone edits it. The one table behind dynamicRevFor's time buckets — and behind
 * the player raster's X-ST-Refresh-In (routes/player-raster.js), so a Roku and an e-ink panel agree
 * on when a frame is stale. Labels are part of the e-ink cache key; do not rename them.
 */
function dynamicPeriodFor(item) {
  if (!item) return null;
  switch (item.widget_type) {
    case 'clock':   return { label: 'clock', seconds: 60 };
    case 'weather': return { label: 'weather', seconds: 600 };
    // A slide only changes on its own when it binds a data source; a static deck re-rendered
    // in Chrome every minute is pure cost.
    case 'slide':   return String(item.widget_config || '').includes('{{ds:') ? { label: 'slide', seconds: 60 } : null;
    case 'rss':     return { label: 'rss', seconds: 300 };
    case 'webpage': return { label: 'webpage', seconds: 300 };
    case 'social':  return { label: 'social', seconds: 300 };
    // The board polls its data every 60s (widgets.js); a 300s bucket showed stale rows.
    case 'directory-board': return { label: 'directory', seconds: 60 };
    default: break;
  }
  if (item.remote_url && !looksLikeImage(item.remote_url, item.mime_type)) {
    return { label: 'url', seconds: 300 };
  }
  return null;
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
  const allows = (it) => it && it.mime_type !== 'video/hls' && it.mime_type !== 'video/rtsp' && it.mime_type !== 'video/hdmi-in' && ScheduleEval.itemShouldPlay(it, Date.now(), tz);
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
    allItems = getPublishedPlaylistItems(playlist_id).filter((it) => it && it.mime_type !== 'video/hls' && it.mime_type !== 'video/rtsp' && it.mime_type !== 'video/hdmi-in' && ScheduleEval.itemShouldPlay(it, Date.now(), tz));
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
  const parsed = parseProfile(screen_profile || 'seeed-reterminal-sticky');
  const width = parseInt(screen_width) || parsed?.width || 800;
  const height = parseInt(screen_height) || parsed?.height || 480;
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

const VALID_ORIENTATIONS = new Set(['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped']);
const ORIENTATION_FOR_ROTATION = { 0: 'landscape', 90: 'portrait', 180: 'landscape-flipped', 270: 'portrait-flipped' };

/*
 * The orientation/rotation this REQUEST states (?orientation= / ?rotation= / ?rotate= /
 * X-ST-Device-Orientation / X-ST-Device-Rotation, and the X-ST-Orientation / X-ST-Rotation
 * aliases), validated. A rotation alone implies its orientation. Both undefined when none is stated.
 */
function statedOrientationRotation(req) {
  const q = req.query || {};
  const h = req.headers || {};
  const norm = (v) => (v === undefined || v === null ? undefined : String(v).trim().toLowerCase());
  const queryOrient = norm(q.orientation);
  const headerOrient = norm(h['x-st-device-orientation'] || h['x-st-orientation']);
  const queryRotRaw = q.rotation !== undefined ? q.rotation : q.rotate;
  const headerRotRaw = h['x-st-device-rotation'] !== undefined ? h['x-st-device-rotation'] : h['x-st-rotation'];
  const toRot = (v) => {
    if (v === undefined) return undefined;
    const n = parseInt(v, 10);
    return ORIENTATION_FOR_ROTATION[n] !== undefined ? n : undefined;
  };
  let orientation = (VALID_ORIENTATIONS.has(queryOrient) ? queryOrient : undefined)
    || (VALID_ORIENTATIONS.has(headerOrient) ? headerOrient : undefined);
  const rotation = toRot(queryRotRaw) !== undefined ? toRot(queryRotRaw) : toRot(headerRotRaw);
  if (!orientation && rotation !== undefined) orientation = ORIENTATION_FOR_ROTATION[rotation];
  return { orientation, rotation };
}

/*
 * What to render this panel as: what the request states, else what the device itself last
 * reported (devices.reported_orientation), else nothing — and nothing means the stored profile
 * exactly as it is, byte-identical to before orientation support. ⚠️ Never devices.orientation.
 */
function resolveOrientationRotation(req, device) {
  const stated = statedOrientationRotation(req);
  if (stated.orientation || stated.rotation !== undefined) return stated;
  const reported = device && VALID_ORIENTATIONS.has(device.reported_orientation) ? device.reported_orientation : undefined;
  return { orientation: reported, rotation: undefined };
}

/*
 * ?format= for a preview. A nibble panel's bytes are its controller's own packing; a PNG/JPEG/BMP
 * request cannot be honoured by handing back nibbles. Refuse it rather than label nibbles as an image.
 */
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'jpg', 'bmp']);
const PACKED_NIBBLE_DEPTHS = new Set(['spectra6', 'gray16']);
function applyFormatOverride(req, profile) {
  if (!req.query.format) return null;
  const fmt = String(req.query.format).toLowerCase();
  const known = fmt === 'png' || fmt === 'jpeg' || fmt === 'jpg' || fmt === 'bmp' || fmt === 'raw' || fmt === 'x-epd-packed' || fmt === 'x-epd-spectra6' || fmt === 'x-epd-gray16';
  if (!known) return null;
  if (PACKED_NIBBLE_DEPTHS.has(profile.colorDepth) && IMAGE_FORMATS.has(fmt)) {
    return `format=${fmt} is not available for ${profile.colorDepth} panels: the response is packed controller nibbles`;
  }
  profile.outputFormat = fmt;
  return null;
}

// ─── GET /api/embedded/info ─────────────────────────────────────────────────────

router.get('/info', resolveAuth, (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  touchDeviceHeartbeat(device, req);
  const { orientation: overrideOrientation, rotation: overrideRotation } = resolveOrientationRotation(req, device);
  const profile = parseProfile(device.screen_profile, { orientation: overrideOrientation, rotation: overrideRotation });
  const power = evaluateDevicePower(device);
  // /info is metadata (MCU negotiation / debugging / monitors). It must NOT advance the panel's
  // cursor, or a poll that lands after the current item's dwell would make the real render skip an item.
  const resolved = resolveCurrentItem(device.id, req.query.item, { advance: false });
  const expiresIn = (power.isOff && power.sleepSeconds)
    ? power.sleepSeconds
    : (resolved ? resolved.expiresIn : null);

  res.json({
    device_id: device.id,
    device_name: device.name,
    screen_profile: profile,
    presets: listPresets(),
    power_schedule: power.schedule ? {
      enabled: power.schedule.enabled,
      state: power.state,
      next_edge: power.nextEdge,
    } : null,
    playlist: resolved
      ? { item_count: resolved.total, current_index: resolved.itemIndex }
      : null,
    current_item: resolved
      ? {
          index: resolved.itemIndex,
          content_id: resolved.content?.content_id || null,
          content_type: resolved.item?.widget_id ? 'widget' : (resolved.content?.mime_type || null),
          expires_in_seconds: expiresIn,
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

  touchDeviceHeartbeat(device, req);

  const { orientation: overrideOrientation, rotation: overrideRotation } = resolveOrientationRotation(req, device);
  const profile = parseProfile(device.screen_profile, { orientation: overrideOrientation, rotation: overrideRotation });
  if (!profile) {
    return res.status(400).json({
      error: 'Embedded rendering not configured for this device.',
      hint: 'Set devices.screen_profile (use GET /api/embedded/presets for options).',
    });
  }

  // Allow optional query overrides (e.g. ?format=jpeg or ?format=png or ?dither=atkinson for previewing)
  const formatErr = applyFormatOverride(req, profile);
  if (formatErr) return res.status(400).json({ error: formatErr });
  if (req.query.dither) {
    const d = String(req.query.dither).toLowerCase();
    if (d === 'floyd-steinberg' || d === 'atkinson' || d === 'none') {
      profile.dither = d;
    }
  }

  const isPreview = req.query.preview === '1';
  const pendingCmdObj = !isPreview ? resolvePendingCommand(device.id, device, req) : null;
  const pendingCmd = pendingCmdObj ? pendingCmdObj.commandStr : null;
  const renderOpts = { pendingCmd, pendingCmdObj };

  return withCommandDropOnThrow(device.id, pendingCmdObj, () => {
    // Query mode overrides
    if (req.query.mode === 'single') {
      return handleRenderStandard(req, res, device, profile, renderOpts);
    }
    if (req.query.mode === 'layout') {
      return handleRenderLayout(req, res, device, profile, { ...renderOpts, explicitMode: true });
    }

    // Automatic multi-zone layout detection
    const forceIndex = req.query.item !== undefined ? req.query.item : null;
    const layoutResolved = resolveLayoutItems(device.id, forceIndex, { advance: false });

    if (layoutResolved && layoutResolved.zoneEntries.length > 1) {
      const isImageOnly = isLayoutImageOnly(layoutResolved.zoneEntries);
      if (!isImageOnly && !isBrowserAvailable()) {
        return handleRenderStandard(req, res, device, profile, { ...renderOpts, isFallback: true });
      }
      return handleRenderLayout(req, res, device, profile, { ...renderOpts, explicitMode: false, preResolved: layoutResolved });
    }

    return handleRenderStandard(req, res, device, profile, renderOpts);
  });
});

// ─── GET /api/embedded/render-layout ────────────────────────────────────────────

router.get('/render-layout', resolveAuth, async (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  touchDeviceHeartbeat(device, req);

  const { orientation: overrideOrientation, rotation: overrideRotation } = resolveOrientationRotation(req, device);
  const profile = parseProfile(device.screen_profile, { orientation: overrideOrientation, rotation: overrideRotation });
  if (!profile) {
    return res.status(400).json({
      error: 'Embedded rendering not configured for this device.',
      hint: 'Set devices.screen_profile (use GET /api/embedded/presets for options).',
    });
  }

  const formatErr = applyFormatOverride(req, profile);
  if (formatErr) return res.status(400).json({ error: formatErr });
  if (req.query.dither) {
    const d = String(req.query.dither).toLowerCase();
    if (d === 'floyd-steinberg' || d === 'atkinson' || d === 'none') {
      profile.dither = d;
    }
  }

  const isPreview = req.query.preview === '1';
  const pendingCmdObj = !isPreview ? resolvePendingCommand(device.id, device, req) : null;
  const pendingCmd = pendingCmdObj ? pendingCmdObj.commandStr : null;
  return withCommandDropOnThrow(device.id, pendingCmdObj,
    () => handleRenderLayout(req, res, device, profile, { pendingCmd, pendingCmdObj, explicitMode: true }));
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

  // ── Power Schedule check ──────────────────────────────────────────────────
  const power = (!isPreview && forceIndex === null)
    ? evaluateDevicePower(device)
    : { isOff: false, state: 'on', nextEdge: null, sleepSeconds: null };

  // If the device already holds a frame and is scheduled OFF, answer 304 immediately with deep-sleep duration
  if (!isPreview && req.headers['if-none-match'] && power.isOff) {
    const clientIp = touchDeviceHeartbeat(device, req);
    console.log(`[embedded] Device '${device.name}' (${device.id}) is scheduled OFF [sleep=${power.sleepSeconds}s] from ${clientIp}`);
    const offHeaders = {
      'ETag': req.headers['if-none-match'],
      'Cache-Control': 'no-store',
      'X-ST-Device-Id': device.id,
      'X-ST-Expires-In': String(power.sleepSeconds),
      'X-ST-Power-State': 'scheduled_off',
    };
    if (opts.pendingCmd) {
      offHeaders['X-ST-Command'] = opts.pendingCmd;
    }
    markCommandDelivered(device.id, opts);
    res.set(offHeaders).status(304).end();
    return;
  }

  // A dashboard preview must not advance the real device's cursor (an ?item= override already never
  // does). A genuine device render still advances, time-gated by the current item's dwell.
  const resolved = resolveCurrentItem(device.id, forceIndex, { advance: !isPreview });
  if (!resolved) {
    const errHeaders = { 'X-ST-Device-Name': device.name || '' };
    if (opts.pendingCmd) errHeaders['X-ST-Command'] = opts.pendingCmd;
    res.set(errHeaders);
    markCommandDelivered(device.id, opts);
    return res.status(404).json({ error: 'No playlist assigned or no active items for this device.', device_name: device.name || '' });
  }

  const clientIp = touchDeviceHeartbeat(device, req);
  const { item, content, itemIndex, total } = resolved;
  let expiresIn = resolved.expiresIn;
  if (power.isOff && power.sleepSeconds) {
    expiresIn = power.sleepSeconds;
  } else if (!power.isOff) {
    let secondsUntilOff = Infinity;
    if (power.nextEdge && power.nextEdge.to === 'scheduled_off') {
      secondsUntilOff = secondsUntilOffEdge(power);
      expiresIn = Math.min(expiresIn, secondsUntilOff);
    }
    // S4: the floor is a minimum for a panel that stays on. It is capped by the seconds to the next
    // off edge, so a panel minutes from power-off is never told to wait out the floor.
    if (profile.minRefreshInterval && typeof profile.minRefreshInterval === 'number') {
      expiresIn = Math.min(secondsUntilOff, Math.max(expiresIn, profile.minRefreshInterval));
    }
  }

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
    'X-ST-Device-Name': device.name || '',
    'X-ST-Content-Id': content?.content_id || '',
    'X-ST-Expires-In': String(expiresIn),
    'X-ST-Item-Index': String(itemIndex),
    'X-ST-Total-Items': String(total),
    'X-ST-Power-State': power.state,
    ...frameHeaders(profile),
  };
  if (profile.supportsPartialRefresh !== undefined) {
    headers['X-ST-Supports-Partial'] = profile.supportsPartialRefresh ? '1' : '0';
  }
  if (opts.pendingCmd) {
    headers['X-ST-Command'] = opts.pendingCmd;
  }
  if (opts.isFallback) {
    headers['X-ST-Layout-Fallback'] = '1';
  }

  if (!isPreview && isNotModified(key, req.headers['if-none-match'])) {
    markCommandDelivered(device.id, opts);
    res.set(headers).status(304).end();
    return;
  }

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (!isPreview) {
    const cached = cacheGet(key);
    if (cached.hit) {
      markCommandDelivered(device.id, opts);
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
    if (opts.pendingCmd) res.set('X-ST-Command', opts.pendingCmd);
    markCommandDelivered(device.id, opts);
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
    // Same as every other answer here (and the layout path's 500): a frame we could not build is
    // no reason to withhold a queued reboot or log upload — it is often exactly when one is needed.
    if (opts.pendingCmd) res.set('X-ST-Command', opts.pendingCmd);
    markCommandDelivered(device.id, opts);
    return res.status(500).json({ error: `Post-processing failed: ${e.message}` });
  }

  // Store in cache (non-blocking; non-fatal on failure)
  if (!isPreview) {
    try { cacheSet(key, processed.buffer); } catch { /* best-effort */ }
  }

  res.set({
    ...headers,
    ...(processed.width && processed.height
      ? { 'X-ST-Screen-Width': String(processed.width), 'X-ST-Screen-Height': String(processed.height) }
      : {}),
    'Content-Type': processed.contentType,
  });
  markCommandDelivered(device.id, opts);
  res.status(200).send(processed.buffer);
}

async function handleRenderLayout(req, res, device, profile, opts = {}) {
  const isPreview = req.query.preview === '1' || opts.preview === true;
  const pendingCmdObj = opts.pendingCmdObj !== undefined
    ? opts.pendingCmdObj
    : (!isPreview ? resolvePendingCommand(device.id, device, req) : null);
  const pendingCmd = opts.pendingCmd !== undefined
    ? opts.pendingCmd
    : (pendingCmdObj ? pendingCmdObj.commandStr : null);
  const cmdOpts = { ...opts, pendingCmd, pendingCmdObj };

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
      if (cmdOpts.pendingCmd) res.setHeader('X-ST-Command', cmdOpts.pendingCmd);
      markCommandDelivered(device.id, cmdOpts);
      return res.status(404).json({ error: 'Device has no multi-zone layout assigned or no active items.' });
    }
    return handleRenderStandard(req, res, device, profile, { ...cmdOpts, isFallback: true, signal });
  }

  const isImageOnly = isLayoutImageOnly(resolved.zoneEntries);
  if (!isImageOnly && !isBrowserAvailable()) {
    if (isExplicit) {
      if (cmdOpts.pendingCmd) res.setHeader('X-ST-Command', cmdOpts.pendingCmd);
      markCommandDelivered(device.id, cmdOpts);
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: 'Browser unavailable for multi-zone rendering with widgets or web pages',
      });
    }
    return handleRenderStandard(req, res, device, profile, { ...cmdOpts, isFallback: true, signal });
  }

  // Persist pending cursor advances now that the layout is confirmed for rendering
  if (!forceIndex && resolved.pendingAdvances && resolved.pendingAdvances.length > 0) {
    for (const adv of resolved.pendingAdvances) {
      ZONE_CURSOR_UPSERT.run(device.id, adv.zoneId, adv.index);
    }
  }

  // ── Power Schedule check ──────────────────────────────────────────────────
  const power = (!isPreview && forceIndex === null)
    ? evaluateDevicePower(device)
    : { isOff: false, state: 'on', nextEdge: null, sleepSeconds: null };

  if (!isPreview && req.headers['if-none-match'] && power.isOff) {
    const clientIp = touchDeviceHeartbeat(device, req);
    console.log(`[embedded] Device '${device.name}' (${device.id}) is scheduled OFF [layout sleep=${power.sleepSeconds}s] from ${clientIp}`);
    const offHeaders = {
      'ETag': req.headers['if-none-match'],
      'Cache-Control': 'no-store',
      'X-ST-Device-Id': device.id,
      'X-ST-Expires-In': String(power.sleepSeconds),
      'X-ST-Power-State': 'scheduled_off',
    };
    if (cmdOpts.pendingCmd) {
      offHeaders['X-ST-Command'] = cmdOpts.pendingCmd;
    }
    markCommandDelivered(device.id, cmdOpts);
    res.set(offHeaders).status(304).end();
    return;
  }

  const clientIp = touchDeviceHeartbeat(device, req);
  const { layout, zoneEntries, dynamicRev } = resolved;
  let expiresIn = resolved.expiresIn;
  if (power.isOff && power.sleepSeconds) {
    expiresIn = power.sleepSeconds;
  } else if (!power.isOff) {
    let secondsUntilOff = Infinity;
    if (power.nextEdge && power.nextEdge.to === 'scheduled_off') {
      secondsUntilOff = secondsUntilOffEdge(power);
      expiresIn = Math.min(expiresIn, secondsUntilOff);
    }
    // S4: the floor is a minimum for a panel that stays on. It is capped by the seconds to the next
    // off edge, so a panel minutes from power-off is never told to wait out the floor.
    if (profile.minRefreshInterval && typeof profile.minRefreshInterval === 'number') {
      expiresIn = Math.min(secondsUntilOff, Math.max(expiresIn, profile.minRefreshInterval));
    }
  }

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
    'X-ST-Power-State': power.state,
    ...frameHeaders(profile),
  };
  if (profile.supportsPartialRefresh !== undefined) {
    headers['X-ST-Supports-Partial'] = profile.supportsPartialRefresh ? '1' : '0';
  }
  if (cmdOpts.pendingCmd) {
    headers['X-ST-Command'] = cmdOpts.pendingCmd;
  }

  if (!isPreview && isNotModified(key, req.headers['if-none-match'])) {
    markCommandDelivered(device.id, cmdOpts);
    res.set(headers).status(304).end();
    return;
  }

  // ── Cache hit ───────────────────────────────────────────────────────────────
  if (!isPreview) {
    const cached = cacheGet(key);
    if (cached.hit) {
      markCommandDelivered(device.id, cmdOpts);
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
      if (cmdOpts.pendingCmd) res.setHeader('X-ST-Command', cmdOpts.pendingCmd);
      markCommandDelivered(device.id, cmdOpts);
      return res.status(500).json({
        error: 'Multi-zone layout rendering failed.',
        detail: 'An unexpected error occurred while rendering the layout.',
      });
    }
    return handleRenderStandard(req, res, device, profile, { ...cmdOpts, isFallback: true, signal });
  }

  if (!renderResult || renderResult.unsupported) {
    if (isExplicit) {
      if (cmdOpts.pendingCmd) res.setHeader('X-ST-Command', cmdOpts.pendingCmd);
      markCommandDelivered(device.id, cmdOpts);
      return res.status(501).json({
        error: 'Multi-zone layout rendering failed or not supported.',
        detail: renderResult?.reason || 'Browser unavailable for multi-zone rendering',
      });
    }
    // Auto mode fallback to standard single-item rendering
    return handleRenderStandard(req, res, device, profile, { ...cmdOpts, isFallback: true, signal });
  }

  // ── Post-process ─────────────────────────────────────────────────────────────
  let processed;
  try {
    processed = await postprocess(renderResult.png, profile);
  } catch (e) {
    console.error('[embedded] postprocess error:', e.message);
    if (cmdOpts.pendingCmd) res.setHeader('X-ST-Command', cmdOpts.pendingCmd);
    markCommandDelivered(device.id, cmdOpts);
    return res.status(500).json({ error: `Post-processing failed: ${e.message}` });
  }

  if (!isPreview) {
    try { cacheSet(key, processed.buffer); } catch { /* best-effort */ }
  }

  res.set({
    ...headers,
    ...(processed.width && processed.height
      ? { 'X-ST-Screen-Width': String(processed.width), 'X-ST-Screen-Height': String(processed.height) }
      : {}),
    'Content-Type': processed.contentType,
  });
  markCommandDelivered(device.id, cmdOpts);
  res.status(200).send(processed.buffer);
}

// ─── POST /api/embedded/logs ──────────────────────────────────────────────────
/*
 * Ingest buffered diagnostic logs uploaded from an embedded device (#3 / mcu#9).
 * Accepts JSON object ({ logs: [...], log_count, battery, rssi, version }),
 * JSON array of logs, or plain text log lines.
 * Emits dashboard:embedded-logs to dashboard subscribers in the device's workspace room.
 */
// The MCU ring holds 100 entries. The body is stored whole and re-emitted whole on the dashboard
// socket, so it gets its own small parser (server.js leaves this path to it) instead of the 12 MB
// global one.
const LOG_BODY_LIMIT = '256kb';
const MAX_LOG_ENTRIES = 100;
const logJsonParser = express.json({ limit: LOG_BODY_LIMIT });
// text/plain: one log line per line. server.js skips its global parser for this path, so without
// this the plain-text branch of handleDeviceLogs could never run (req.body was {}).
const logTextParser = express.text({ limit: LOG_BODY_LIMIT, type: 'text/plain' });

function parseLogBody(req, res, next) {
  const done = (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: `Log upload exceeds ${LOG_BODY_LIMIT}` });
    }
    return res.status(400).json({ error: 'Malformed log body' });
  };
  logJsonParser(req, res, (err) => (err ? done(err) : logTextParser(req, res, done)));
}

// Only the panel itself uploads its logs: an API token (even a 'full' one) is a reader here.
function requireDevice(req, res, next) {
  if (!req.device) return res.status(403).json({ error: 'Only the device itself can upload its diagnostic logs (device token required)' });
  return next();
}

router.post('/logs', deviceLogsLimiter, resolveAuth, requireDevice, parseLogBody, (req, res) => handleDeviceLogs(req, res));

function handleDeviceLogs(req, res) {
  const device = resolveDevice(req, res);
  if (!device) return;

  touchDeviceHeartbeat(device, req);

  let rawLogs = req.body;
  let logCount = 0;
  let battery = null;
  let wifiRssi = null;
  let version = null;

  if (typeof rawLogs === 'string') {
    if (rawLogs.length > 500000) {
      return res.status(400).json({ error: 'Payload size exceeds limit' });
    }
    try {
      rawLogs = JSON.parse(rawLogs);
    } catch (_) {
      const lines = rawLogs.split('\n').filter(Boolean);
      if (lines.length > MAX_LOG_ENTRIES) {
        return res.status(400).json({ error: `Log entries exceed maximum limit of ${MAX_LOG_ENTRIES}` });
      }
      rawLogs = {
        logs: lines.map(line => ({ msg: line, level: 'INFO' })),
        log_count: lines.length
      };
    }
  }

  if (Array.isArray(rawLogs)) {
    if (rawLogs.length > MAX_LOG_ENTRIES) {
      return res.status(400).json({ error: `Log entries exceed maximum limit of ${MAX_LOG_ENTRIES}` });
    }
    rawLogs = { logs: rawLogs, log_count: rawLogs.length };
  }

  if (rawLogs && typeof rawLogs === 'object') {
    if (Array.isArray(rawLogs.logs) && rawLogs.logs.length > MAX_LOG_ENTRIES) {
      return res.status(400).json({ error: `Log entries exceed maximum limit of ${MAX_LOG_ENTRIES}` });
    }

    if (rawLogs.battery !== undefined && rawLogs.battery !== null) {
      const b = Number(rawLogs.battery);
      if (!Number.isFinite(b) || b < 0 || b > 100) {
        return res.status(400).json({ error: 'Invalid battery value; must be a finite number between 0 and 100' });
      }
      battery = b;
    }

    const rawRssi = rawLogs.wifi_rssi !== undefined ? rawLogs.wifi_rssi : rawLogs.rssi;
    if (rawRssi !== undefined && rawRssi !== null) {
      const r = Number(rawRssi);
      if (!Number.isFinite(r) || r < -120 || r > 0) {
        return res.status(400).json({ error: 'Invalid rssi value; must be a finite number between -120 and 0' });
      }
      wifiRssi = r;
    }

    version = (rawLogs.version !== undefined && rawLogs.version !== null) ? String(rawLogs.version) : null;
    if (Array.isArray(rawLogs.logs)) {
      logCount = rawLogs.logs.length;
    } else if (Number.isInteger(rawLogs.log_count)) {
      logCount = rawLogs.log_count;
    }
  }

  if (battery === null && req.headers['x-st-device-battery'] !== undefined) {
    const bH = Number(req.headers['x-st-device-battery']);
    if (Number.isFinite(bH) && bH >= 0 && bH <= 100) battery = bH;
  }
  if (wifiRssi === null) {
    const rHRaw = req.headers['x-st-device-rssi'] || req.headers['x-st-device-wifi-rssi'];
    if (rHRaw !== undefined) {
      const rH = Number(rHRaw);
      if (Number.isFinite(rH) && rH >= -120 && rH <= 0) wifiRssi = rH;
    }
  }
  if (!version && req.headers['x-st-firmware-version']) {
    version = String(req.headers['x-st-firmware-version']);
  }

  const logJson = typeof rawLogs === 'object' ? JSON.stringify(rawLogs) : String(rawLogs || '');

  const insertAndPrune = db.transaction((devId, json, count, batt, rssi, ver) => {
    const info = db.prepare(`
      INSERT INTO device_diagnostic_logs (device_id, log_json, log_count, battery, wifi_rssi, version, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'))
    `).run(devId, json, count, batt, rssi, ver);
    const id = info.lastInsertRowid;

    db.prepare(`
      DELETE FROM device_diagnostic_logs
      WHERE device_id = ? AND id NOT IN (
        SELECT id FROM device_diagnostic_logs
        WHERE device_id = ?
        ORDER BY uploaded_at DESC, id DESC
        LIMIT 20
      )
    `).run(devId, devId);

    return id;
  });

  let logId;
  try {
    logId = insertAndPrune(device.id, logJson, logCount, battery, wifiRssi, version);
  } catch (err) {
    console.error('[embedded-logs] Failed to store diagnostic log:', err.message);
    return res.status(500).json({ error: 'Failed to store diagnostic log' });
  }

  // Pop pending upload_logs command if queued
  try {
    popCommand(device.id, 'upload_logs');
  } catch (_) {}

  // Broadcast WebSocket event to dashboard room
  try {
    const io = req.app.get('io');
    const dashboardNs = io ? io.of('/dashboard') : null;
    if (dashboardNs) {
      const { deviceRoom, emitToWorkspace } = require('../lib/socket-rooms');
      emitToWorkspace(dashboardNs, deviceRoom(device.id), 'dashboard:embedded-logs', {
        device_id: device.id,
        id: logId,
        log_id: logId,
        log_count: logCount,
        battery,
        wifi_rssi: wifiRssi,
        version,
        logs: rawLogs.logs || rawLogs,
        uploaded_at: Math.floor(Date.now() / 1000)
      });
    }
  } catch (err) {
    console.warn(`[embedded-logs] Failed to emit socket event: ${err.message}`);
  }

  res.status(200).json({ status: 'ok', log_id: logId, id: logId, count: logCount });
}

// ─── GET /api/embedded/logs ───────────────────────────────────────────────────
router.get('/logs', deviceLogsLimiter, resolveAuth, (req, res) => {
  const device = resolveDevice(req, res);
  if (!device) return;

  const logs = db.prepare(`
    SELECT * FROM device_diagnostic_logs
    WHERE device_id = ?
    ORDER BY uploaded_at DESC, id DESC
    LIMIT 20
  `).all(device.id);

  res.json({ logs });
});

// ─── Firmware Distribution & OTA Management ───────────────────────────────────

const _firmwareHashCache = new Map(); // filePath -> { mtimeMs, size, sha256 }

function getFirmwareInfo(preset) {
  const safePreset = normalizePresetName(preset);
  if (!safePreset) return null;

  const candidateDirs = [];
  if (process.env.ST_FIRMWARE_DIR) {
    candidateDirs.push(path.join(process.env.ST_FIRMWARE_DIR, safePreset));
  } else {
    if (config.embeddedFirmwareDir) {
      candidateDirs.push(path.join(config.embeddedFirmwareDir, safePreset));
    }
    candidateDirs.push(path.join(__dirname, '../data/firmware', safePreset));
    candidateDirs.push(path.join(__dirname, '../firmware', safePreset));
  }

  for (const base of candidateDirs) {
    const binPaths = [
      path.join(base, 'firmware.bin'),
      path.join(base, 'latest.bin'),
      path.join(base, `${safePreset}.bin`),
      path.join(base, `${safePreset}-firmware.bin`),
    ];

    for (const binPath of binPaths) {
      if (fs.existsSync(binPath)) {
        try {
          const stat = fs.statSync(binPath);
          let sha256 = null;
          const cached = _firmwareHashCache.get(binPath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            sha256 = cached.sha256;
          } else {
            const fd = fs.openSync(binPath, 'r');
            try {
              const hash = crypto.createHash('sha256');
              const chunk = Buffer.alloc(65536);
              let bytesRead = 0;
              while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
                hash.update(chunk.subarray(0, bytesRead));
              }
              sha256 = hash.digest('hex');
            } finally {
              fs.closeSync(fd);
            }
            _firmwareHashCache.set(binPath, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
          }

          let version = null;
          let declaredSha256 = null;
          const vJsonPath = path.join(path.dirname(binPath), 'version.json');
          const vTxtPath = path.join(path.dirname(binPath), 'version.txt');
          if (fs.existsSync(vJsonPath)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(vJsonPath, 'utf8'));
              if (parsed.version) version = String(parsed.version);
              if (typeof parsed.sha256 === 'string' && SHA256_HEX.test(parsed.sha256)) declaredSha256 = parsed.sha256;
            } catch (_) {}
          } else if (fs.existsSync(vTxtPath)) {
            try {
              const vStr = fs.readFileSync(vTxtPath, 'utf8').trim();
              if (vStr) version = vStr;
            } catch (_) {}
          }

          return {
            preset: safePreset,
            version,
            size: stat.size,
            sha256,
            declaredSha256,
            filePath: binPath,
            download_url: `/api/embedded/firmware/${safePreset}/latest.bin`
          };
        } catch (_) {}
      }
    }
  }

  return null;
}

// GET /api/embedded/firmware/:preset/version
router.get('/firmware/:preset/version', firmwareLimiter, (req, res) => {
  const preset = req.params.preset;
  const fw = getFirmwareInfo(preset);
  if (!fw) {
    return res.status(404).json({ error: `No firmware found for preset '${preset}'` });
  }

  res.json({
    preset: fw.preset,
    version: fw.version,
    size: fw.size,
    sha256: fw.sha256,
    download_url: fw.download_url
  });
});

// GET /api/embedded/firmware/:preset/latest.bin
router.get('/firmware/:preset/latest.bin', firmwareLimiter, (req, res) => {
  const preset = req.params.preset;
  const fw = getFirmwareInfo(preset);
  if (!fw) {
    return res.status(404).json({ error: `No firmware found for preset '${preset}'` });
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', fw.size);
  res.setHeader('Content-Disposition', `attachment; filename="${fw.preset}-firmware.bin"`);
  if (fw.version) {
    res.setHeader('X-ST-Firmware-Version', fw.version);
  }
  res.setHeader('X-ST-Firmware-SHA256', fw.sha256);

  const stream = fs.createReadStream(fw.filePath);
  stream.on('error', (err) => {
    stream.destroy();
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
});

// ─── Helpers ────────────────────────────────────────────────────────────────────

/*
 * The frame description every render answer carries, 304 and cache hit included:
 *   X-ST-Screen-Width / -Height  the frame's dimensions as sent (after any server-side rotation)
 *   X-ST-Rotation                 the mount rotation the frame was composed for, degrees
 *   X-ST-Orientation              the stated orientation, else the composed box's shape
 * See docs/embedded-renderer.md (Orientation and rotation) for what firmware does with them.
 */
function frameHeaders(profile) {
  const dims = frameDimensions(profile);
  return {
    'X-ST-Screen-Width': String(dims.width),
    'X-ST-Screen-Height': String(dims.height),
    'X-ST-Rotation': String(profile.rotation || 0),
    'X-ST-Orientation': frameOrientation(profile),
  };
}

function detectContentType(profile) {
  switch (profile.outputFormat) {
    case 'png':            return 'image/png';
    case 'jpeg':
    case 'jpg':            return 'image/jpeg';
    case 'bmp':            return 'image/bmp';
    case 'x-epd-packed':
    case 'x-epd-spectra6':
    case 'x-epd-gray16':
    case 'raw':
    default:               return 'application/octet-stream';
  }
}

module.exports = router;
module.exports.resolveCurrentItem = resolveCurrentItem;
module.exports.resolveLayoutItems = resolveLayoutItems;
module.exports.resolveDevicePlaylist = resolveDevicePlaylist;
module.exports.resolvedLayoutId = resolvedLayoutId;
module.exports.resolveDeviceContext = resolveDeviceContext;
module.exports.touchDeviceHeartbeat = touchDeviceHeartbeat;
module.exports.dynamicRevFor = dynamicRevFor;
module.exports.dynamicPeriodFor = dynamicPeriodFor;
module.exports.getPendingCommand = getPendingCommand;
module.exports.resolvePendingCommand = resolvePendingCommand;
module.exports.normalizePresetName = normalizePresetName;
module.exports.getFirmwareInfo = getFirmwareInfo;
module.exports.otaBreaker = otaBreaker;


