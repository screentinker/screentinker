'use strict';

/**
 * Universal Data Sources Service for ScreenTinker.
 *
 * Handles fetching, caching, refreshing, and evaluating data sources.
 */

const { db } = require('../../db/database');
const { resolveIcalData } = require('./ical-resolver');

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
  }
  activeFetches += 1;
  try {
    return await fn();
  } finally {
    activeFetches -= 1;
    const next = fetchWaiters.shift();
    if (next) next();
  }
}

let pollTimer = null;

/**
 * Periodically poll and sync all due data sources across all workspaces.
 */
function pollDueDataSources() {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = db.prepare('SELECT * FROM data_sources').all();
    for (const row of rows) {
      let config = {};
      try { config = JSON.parse(row.config || '{}'); } catch (_) {}
      const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 15);
      const isDue = !row.last_fetched_at || (nowSec - row.last_fetched_at >= intervalMin * 60);
      if (isDue) {
        syncDataSource(row, true).catch(err => {
          console.warn(`[data-sources] background sync error for '${row.slug}':`, err.message);
        });
      }
    }
  } catch (e) {
    console.warn('[data-sources] pollDueDataSources error:', e.message);
  }
}

function startDataSourcesPoller(intervalMs = 60000) {
  if (pollTimer) return;
  setTimeout(pollDueDataSources, 5000);
  pollTimer = setInterval(pollDueDataSources, intervalMs);
  pollTimer.unref?.();
}

function stopDataSourcesPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

if (process.env.NODE_ENV !== 'test') {
  startDataSourcesPoller();
}

/**
 * Fetch and refresh a data source by ID or row object.
 *
 * @param {string|object} sourceOrId ID or row from data_sources table
 * @param {boolean} [force=false] Force refresh ignoring cache interval
 * @returns {Promise<object>} Updated data source row with parsed cached_data
 */
async function syncDataSource(sourceOrId, force = false) {
  let row = typeof sourceOrId === 'string'
    ? db.prepare('SELECT * FROM data_sources WHERE id = ?').get(sourceOrId)
    : sourceOrId;

  if (!row) {
    throw new Error('Data source not found');
  }

  let config = {};
  try {
    config = JSON.parse(row.config || '{}');
  } catch (_) {}

  const intervalMin = Math.max(1, parseInt(config.interval_min, 10) || 5);
  const nowSec = Math.floor(Date.now() / 1000);

  // Return existing cache if not expired and not forced
  if (!force && row.cached_data && row.last_status === 'ok' && (nowSec - row.last_fetched_at < intervalMin * 60)) {
    return {
      ...row,
      data: JSON.parse(row.cached_data),
    };
  }

  try {
    let resolvedData = null;

    if (row.type === 'ical') {
      resolvedData = await withFetchSlot(() => resolveIcalData(config));
    } else {
      throw new Error(`Unsupported data source type: ${row.type}`);
    }

    const cachedJson = JSON.stringify(resolvedData);

    db.prepare(`
      UPDATE data_sources
      SET cached_data = ?, last_fetched_at = ?, last_status = 'ok', last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(cachedJson, nowSec, nowSec, row.id);

    return {
      ...row,
      cached_data: cachedJson,
      last_fetched_at: nowSec,
      last_status: 'ok',
      last_error: null,
      data: resolvedData,
    };
  } catch (err) {
    console.warn(`[data-sources] Sync failed for "${row.name}" (${row.id}): ${err.message}`);

    db.prepare(`
      UPDATE data_sources
      SET last_status = 'error', last_error = ?, last_fetched_at = ?, updated_at = ?
      WHERE id = ?
    `).run(err.message, nowSec, nowSec, row.id);

    // If we have stale cached data, return it with error status so displays keep showing something
    const staleData = row.cached_data ? JSON.parse(row.cached_data) : null;
    return {
      ...row,
      last_status: 'error',
      last_error: err.message,
      data: staleData,
    };
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

/**
 * Get all data sources for a workspace mapped by slug.
 *
 * @param {string} workspaceId Workspace ID
 * @returns {Promise<Map<string, object>>} Map of slug -> dictionary data
 */
async function getWorkspaceDataMap(workspaceId) {
  if (!workspaceId) return new Map();

  const rows = db.prepare('SELECT * FROM data_sources WHERE workspace_id = ?').all(workspaceId);
  const map = new Map();

  for (const r of rows) {
    try {
      const synced = await syncDataSource(r, false);
      if (synced && synced.data) {
        map.set(r.slug, synced.data);
      }
    } catch (_) {}
  }

  return map;
}

module.exports = {
  syncDataSource,
  getWorkspaceDataMap,
  getWorkspaceDataMapSync,
  withFetchSlot,
  pollDueDataSources,
  startDataSourcesPoller,
  stopDataSourcesPoller,
};
