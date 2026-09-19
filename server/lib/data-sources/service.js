'use strict';

/**
 * Universal Data Sources Service for ScreenTinker.
 *
 * Handles fetching, caching, refreshing, and evaluating data sources.
 */

const { db } = require('../../db/database');
const { resolveIcalData } = require('./ical-resolver');
const pluginRegistry = require('../plugins/registry');
const { makePluginFetch } = require('../plugins/egress');
const { decryptSecrets, fieldsForDataSource } = require('../plugins/secrets');
const { LOCAL_ROWS_SQL } = require('../replica-proxy');

// Bound how many remote calendar feeds may be in flight at once across the whole
// process. Data source syncs (and `/test`) can fire several fetches near-simultaneously;
// without a cap a single busy workspace could exhaust sockets/descriptors against
// third-party calendar hosts.
const FETCH_CONCURRENCY = 4;
let activeFetches = 0;
const fetchWaiters = [];

async function withFetchSlot(fn) {
  if (activeFetches >= FETCH_CONCURRENCY) {
    await new Promise((resolve) => fetchWaiters.push(resolve));
  } else {
    activeFetches += 1;
  }
  try {
    return await fn();
  } finally {
    const next = fetchWaiters.shift();
    if (next) {
      // Hand the slot directly to the next waiter without decrementing/re-incrementing
      next();
    } else {
      activeFetches -= 1;
    }
  }
}

let pollTimer = null;
let ioInstance = null;

/**
 * Periodically poll and sync all due data sources across all workspaces.
 */
// Sources with a sync in flight. The poller re-selected every stale row on each tick, so fifty
// black-holing feeds (10s each, four at a time) queued fifty MORE waiters every minute behind
// the ones still waiting; an operator's own refresh then sat minutes behind background retries.
const inFlight = new Set();

function pollDueDataSources() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    // Scale-out: a copied data source is fetched by the primary; its cached_data arrives by
    // replication. The replica could not decrypt its credentials anyway.
    const rows = db.prepare(`SELECT id, workspace_id, slug, name, type, config, last_fetched_at, last_status FROM data_sources WHERE ${LOCAL_ROWS_SQL('data_sources')}`).all();
    for (const row of rows) {
      if (inFlight.has(row.id)) continue;
      let config = {};
      try { config = JSON.parse(row.config || '{}'); } catch (_) {}
      const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 15);
      const isDue = !row.last_fetched_at || (nowSec - row.last_fetched_at >= intervalMin * 60);
      if (isDue) {
        syncDataSource(row.id, true).catch(err => {
          console.warn(`[data-sources] background sync error for '${row.slug}':`, err.message);
        });
      }
    }
  } catch (e) {
    console.warn('[data-sources] pollDueDataSources error:', e.message);
  }
}

function startDataSourcesPoller(socketIo, intervalMs = 60000) {
  if (pollTimer) return;
  if (socketIo) ioInstance = socketIo;
  const initial = setTimeout(pollDueDataSources, 5000);
  initial.unref?.();
  pollTimer = setInterval(pollDueDataSources, intervalMs);
  pollTimer.unref?.();
}

function stopDataSourcesPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// Per-workspace forced refresh limiter. Protects background slots from being monopolized
// by rapid manual syncs in a single workspace while allowing multitenant fairness.
const forcedSyncs = new Map(); // workspaceId -> { winStart, count }
const FORCED_SYNC_WINDOW_MS = 60000;
const FORCED_SYNC_MAX_PER_WINDOW = 30; // 30 forced syncs per minute per workspace

function checkForcedSyncBudget(workspaceId, now = Date.now()) {
  if (!workspaceId) return true;
  let b = forcedSyncs.get(workspaceId);
  if (!b || (now - b.winStart) >= FORCED_SYNC_WINDOW_MS) {
    b = { winStart: now, count: 0 };
    forcedSyncs.set(workspaceId, b);
  }
  b.count++;
  return b.count <= FORCED_SYNC_MAX_PER_WINDOW;
}

/**
 * Fetch and refresh a data source by ID or row object.
 *
 * @param {string|object} sourceOrId ID or row from data_sources table
 * @param {boolean} [force=false] Force refresh ignoring cache interval
 * @returns {Promise<object>} Updated data source row with parsed cached_data
 */
async function syncDataSource(sourceOrId, force = false) {
  const row = typeof sourceOrId === 'string'
    ? db.prepare('SELECT * FROM data_sources WHERE id = ?').get(sourceOrId)
    : sourceOrId;

  if (!row) {
    throw new Error('Data source not found');
  }

  if (force && row.workspace_id && !checkForcedSyncBudget(row.workspace_id)) {
    throw Object.assign(new Error('Rate limit exceeded for manual syncs in this workspace'), { code: 'rate-limit' });
  }

  let config = {};
  try {
    // Decrypt secret fields for use (they are stored encrypted at rest).
    config = decryptSecrets(JSON.parse(row.config || '{}'), fieldsForDataSource(row.type));
  } catch (_) {}

  const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 15);
  const nowSec = Math.floor(Date.now() / 1000);

  // Return existing cache if not expired and not forced
  if (!force && row.cached_data && row.last_status === 'ok' && (nowSec - row.last_fetched_at < intervalMin * 60)) {
    let parsedData = null;
    try { parsedData = JSON.parse(row.cached_data); } catch (_) {}
    return {
      ...row,
      data: parsedData,
    };
  }

  inFlight.add(row.id);
  try {
    let resolvedData = null;

    if (row.type === 'ical') {
      resolvedData = await withFetchSlot(() => resolveIcalData(config));
    } else {
      const plugin = pluginRegistry.getDataSource(row.type);
      if (!plugin) throw new Error(`Unsupported data source type: ${row.type}`);
      resolvedData = await withFetchSlot(() => plugin.resolve(config, {
        workspaceId: row.workspace_id,
        now: new Date(),
        log: (...args) => console.warn(`[plugin:${plugin.pluginId}]`, ...args),
        fetch: makePluginFetch(plugin.network && plugin.network.allow, { timeoutMs: 10000, maxBytes: 512 * 1024, responseType: 'text' }),
      }));
      if (resolvedData == null) {
        // Plugin signal for 304 / unchanged. Keep the previous cache; do not
        // write a sentinel and do not bump widget revisions.
        const doneSec = Math.floor(Date.now() / 1000);
        db.prepare(`
          UPDATE data_sources
          SET last_fetched_at = ?, last_status = 'ok', last_error = NULL
          WHERE id = ?
        `).run(doneSec, row.id);
        let parsedData = null;
        try { parsedData = JSON.parse(row.cached_data || 'null'); } catch (_) {}
        return {
          ...row,
          last_fetched_at: doneSec,
          last_status: 'ok',
          last_error: null,
          data: parsedData,
        };
      }
      if (typeof resolvedData !== 'object' || Array.isArray(resolvedData)) {
        throw new Error('data-source plugin must return a plain object');
      }
    }

    // Stamped when the fetch FINISHED. The pre-queue timestamp made a source that waited
    // minutes for a slot look due again on the very next tick.
    const doneSec = Math.floor(Date.now() / 1000);
    const cachedJson = JSON.stringify(resolvedData);
    const dataChanged = !row.cached_data || cachedJson !== row.cached_data;

    if (dataChanged) {
      // Data changed: update cached data and advance updated_at
      db.prepare(`
        UPDATE data_sources
        SET cached_data = ?, last_fetched_at = ?, last_status = 'ok', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(cachedJson, doneSec, doneSec, row.id);

      bumpDependentWidgets(row, doneSec);
    } else {
      // Data did not change: update heartbeat/fetch timestamp only, do not defeat immutable cache
      db.prepare(`
        UPDATE data_sources
        SET last_fetched_at = ?, last_status = 'ok', last_error = NULL
        WHERE id = ?
      `).run(doneSec, row.id);
    }

    return {
      ...row,
      cached_data: cachedJson,
      last_fetched_at: nowSec,
      last_status: 'ok',
      last_error: null,
      updated_at: dataChanged ? doneSec : row.updated_at,
      data: resolvedData,
    };
  } catch (err) {
    console.warn(`[data-sources] Sync failed for "${row.name}" (${row.id}): ${err.message}`);
    const publicError = describeSyncError(err);
    const doneSec = Math.floor(Date.now() / 1000);

    // Never update updated_at on error: an upstream outage must not defeat the player's immutable cache
    db.prepare(`
      UPDATE data_sources
      SET last_status = 'error', last_error = ?, last_fetched_at = ?
      WHERE id = ?
    `).run(publicError, doneSec, row.id);

    // If we have stale cached data, return it with error status so displays keep showing something
    let staleData = null;
    if (row.cached_data) {
      try { staleData = JSON.parse(row.cached_data); } catch (_) {}
    }

    return {
      ...row,
      last_status: 'error',
      last_error: publicError,
      data: staleData,
    };
  } finally {
    inFlight.delete(row.id);
  }
}

/*
 * What a sync failure looks like to the dashboard. The raw message is for the server log:
 * `blocked: blocked-ip:10.0.0.5` names the internal address a hostname resolved to,
 * `connect ECONNREFUSED 203.0.113.5:443` names a port, and both were stored in last_error and
 * shown to every workspace member, viewers included, while /test deliberately answers with a
 * fixed string for exactly that reason. One vocabulary, no addresses.
 */
function describeSyncError(err) {
  if (!err) return 'Sync failed';
  const m = String(err.message || '');
  if (err.name === 'SsrfError' || err.code === 'ssrf' || /^blocked:/i.test(m)) {
    return 'The address is not allowed';
  }
  if (err.code === 'timeout' || /timed out/i.test(m)) {
    return 'The host did not respond in time';
  }
  if (err.code === 'size-limit' || /size limit/i.test(m)) {
    return 'The response is too large';
  }
  if (err.code === 'upstream-status' || err.statusCode || /responded (\d{3})|HTTP (\d{3})/i.test(m)) {
    const sc = err.statusCode || (m.match(/responded (\d{3})/i) || [])[1] || (m.match(/HTTP (\d{3})/i) || [])[1] || (m.match(/(\d{3})/) || [])[1];
    return sc ? `The host responded with HTTP ${sc}` : 'The host responded with an error';
  }
  if (err.code === 'too-many-redirects' || err.code === 'bad-redirect') {
    return 'The host could not be reached';
  }
  if (/No valid iCal URL/i.test(m)) {
    return 'No calendar URL or data configured';
  }
  if (/could not be parsed|parse/i.test(m)) {
    return 'The data could not be parsed';
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|certificate/i.test(m)) {
    return 'The host could not be reached';
  }
  if (/Unsupported data source type/i.test(m)) {
    return 'Unsupported data source type';
  }
  return 'Sync failed';
}

/*
 * Advance the revision of every widget bound to this source's slug, and push to the displays
 * playing them. widgets.updated_at IS the player's widget_rev (the snapshot copies it, the
 * device socket refreshes it at send time, the embedded cache keys on it), so this one write is
 * what makes a data change reach a screen through the immutable render cache. Used by a sync
 * that changed data and by DELETE, which used to leave players on the deleted source's last
 * values indefinitely.
 */
function bumpDependentWidgets(row, nowSec) {
  try {
    const slugLower = (row.slug || '').toLowerCase();
    if (!slugLower || !row.workspace_id) return [];
    const candidateWidgets = db.prepare(`
      SELECT id, config FROM widgets
      WHERE workspace_id = ?
    `).all(row.workspace_id);

    // `{{ds:slug.` and not `{{ds:slug`: 'room' must not bump the widgets bound to 'room-b'.
    const dependentWidgets = candidateWidgets.filter(w => {
      if (!w.config) return false;
      const cfg = w.config.toLowerCase();
      return cfg.includes(`{{ds:${slugLower}.`) || cfg.includes(`"slug":"${slugLower}"`);
    });
    if (dependentWidgets.length === 0) return [];

    const widgetIds = dependentWidgets.map(w => w.id);
    const placeholders = widgetIds.map(() => '?').join(',');
    db.prepare(`UPDATE widgets SET updated_at = ? WHERE id IN (${placeholders})`).run(nowSec, ...widgetIds);

    // Push the revision change to all displays currently playing any of these widgets
    const io = ioInstance;
    const deviceNs = io?.of?.('/device');
    if (deviceNs) {
      const { buildPlaylistPayload } = require('../../ws/deviceSocket');
      const commandQueue = require('../command-queue');
      const { devicesPlayingWidget } = require('../devices-playing');

      const affectedDeviceIds = new Set();
      for (const wId of widgetIds) {
        for (const dId of devicesPlayingWidget(wId)) {
          affectedDeviceIds.add(dId);
        }
      }
      for (const devId of affectedDeviceIds) {
        commandQueue.queueOrEmitPlaylistUpdate(deviceNs, devId, buildPlaylistPayload);
      }
    }
    return widgetIds;
  } catch (bumpErr) {
    console.warn(`[data-sources] Could not push updates for dependent widgets: ${bumpErr.message}`);
    return [];
  }
}

/**
 * Get all data sources for a workspace mapped by slug synchronously from cache.
 *
 * @param {string} workspaceId Workspace ID
 * @returns {Record<string, object>} Object of slug -> dictionary data
 */
function getWorkspaceDataMapSync(workspaceId) {
  if (!workspaceId) return {};

  const rows = db.prepare('SELECT slug, cached_data FROM data_sources WHERE workspace_id = ?').all(workspaceId);
  const map = {};

  for (const r of rows) {
    try {
      const data = r.cached_data ? JSON.parse(r.cached_data) : {};
      map[r.slug] = data;
      map[r.slug.toLowerCase()] = data;
    } catch (_) {}
  }

  return map;
}

module.exports = {
  syncDataSource,
  bumpDependentWidgets,
  describeSyncError,
  getWorkspaceDataMapSync,
  withFetchSlot,
  pollDueDataSources,
  startDataSourcesPoller,
  stopDataSourcesPoller,
};
