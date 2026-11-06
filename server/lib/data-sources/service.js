'use strict';

/**
 * Universal Data Sources Service for ScreenTinker.
 *
 * Handles fetching, caching, refreshing, and evaluating data sources.
 */

const { db } = require('../../db/database');
const { resolveIcalData } = require('./ical-resolver');
const { resolveWeatherData, weatherIntervalMin } = require('./weather-resolver');
const pluginRegistry = require('../plugins/registry');
const { makePluginFetch } = require('../plugins/egress');
const { decryptSecrets, fieldsForDataSource } = require('../plugins/secrets');
const { LOCAL_ROWS_SQL } = require('../replica-proxy');
const { getBuiltinType } = require('./builtin-types');

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

// How often a source may be re-fetched. Weather is floored at 10 minutes: Open-Meteo's current
// conditions only move every 15 minutes and it is a free, keyless service we must not hammer.
function syncIntervalMin(type, config) {
  if (type === 'weather') return weatherIntervalMin(config);
  const builtin = getBuiltinType(type);
  if (builtin) return builtin.interval(config);
  return Math.max(1, parseInt(config && config.interval_min, 10) || 15);
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
      const intervalMin = syncIntervalMin(row.type, config);
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
  // The outbound ledger attributes this refresh's requests to the source's workspace, including the
  // background poller's, which serves no request (lib/outbound-ledger.js).
  return require('../outbound-ledger').withContext({ workspaceId: row.workspace_id || null }, () => syncDataSourceRow(row, force));
}

async function syncDataSourceRow(row, force) {
  if (force && row.workspace_id && !checkForcedSyncBudget(row.workspace_id)) {
    throw Object.assign(new Error('Rate limit exceeded for manual syncs in this workspace'), { code: 'rate-limit' });
  }

  let config = {};
  try {
    // Decrypt secret fields for use (they are stored encrypted at rest).
    config = decryptSecrets(JSON.parse(row.config || '{}'), fieldsForDataSource(row.type));
  } catch (_) {}

  const intervalMin = syncIntervalMin(row.type, config);
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

    const builtin = getBuiltinType(row.type);
    if (builtin) {
      const out = await withFetchSlot(() => builtin.resolve(config, { now: new Date() }));
      resolvedData = keepUpdatedStamp(out.data, row.cached_data);
    } else if (row.type === 'ical') {
      resolvedData = await withFetchSlot(() => resolveIcalData(config));
    } else if (row.type === 'weather') {
      resolvedData = await withFetchSlot(() => resolveWeatherData(config, { now: new Date() }));
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
    const keysChanged = dataChanged ? changedKeys(row.cached_data, resolvedData) : [];
    let slidesUpdated = 0;

    if (dataChanged) {
      // Data changed: update cached data and advance updated_at
      db.prepare(`
        UPDATE data_sources
        SET cached_data = ?, last_fetched_at = ?, last_status = 'ok', last_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(cachedJson, doneSec, doneSec, row.id);

      // #790: for live field patch, the scalar new values of the changed keys, keyed exactly as the
      // slide's data-ds markers are (lowercased slug + exact key). Objects/arrays are whole-source or
      // list bindings that cannot be patched node-by-node, so they are left to the normal rev reload.
      let deltaFields = null;
      if (row.cached_data && keysChanged.length) {
        const slugLower = (row.slug || '').toLowerCase();
        deltaFields = {};
        for (const k of keysChanged) {
          const v = resolvedData[k];
          if (v === null || v === undefined || typeof v === 'object') continue;
          deltaFields[`${slugLower}.${k}`] = String(v);
        }
        if (!Object.keys(deltaFields).length) deltaFields = null;
      }
      // Only the widgets that SHOW a changed field (#790). A first fill (no previous cache) moves them all.
      slidesUpdated = bumpDependentWidgets(row, doneSec, row.cached_data ? keysChanged : null, deltaFields).length;
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
      changed: dataChanged,
      changed_keys: keysChanged,
      // Widgets that got a new revision, i.e. will reload on the screens playing them.
      slides_updated: slidesUpdated,
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
/*
 * Built-in types stamp `updated` into their data. Stamped with the fetch time it would differ on
 * every sync, so every sync would look like a change, bump every bound widget's revision and
 * defeat the players' immutable render cache. It means "when this data last CHANGED": if nothing
 * else moved, the previous stamp is kept.
 */
function keepUpdatedStamp(data, prevJson) {
  if (!data || typeof data !== 'object' || !('updated' in data) || !prevJson) return data;
  let prev;
  try { prev = JSON.parse(prevJson); } catch (_) { return data; }
  if (!prev || typeof prev !== 'object' || !('updated' in prev)) return data;
  const strip = (o) => { const c = { ...o }; delete c.updated; return JSON.stringify(c); };
  return strip(data) === strip(prev) ? { ...data, updated: prev.updated } : data;
}

/*
 * Which variables a sync changed, for the dashboard's "Sync now" answer. A changed source re-renders
 * every slide bound to it, and a slide that reloads on every sync almost always means the response
 * carries something that moves on every call (a timestamp, a request id, a counter). Naming those
 * keys is what lets an operator see that without diffing JSON by hand (#790). Capped: a table
 * source can change hundreds of row keys at once and the toast only needs the first few.
 */
const MAX_CHANGED_KEYS = 10;
function changedKeys(prevJson, next) {
  let prev = {};
  try { prev = prevJson ? JSON.parse(prevJson) : {}; } catch (_) { prev = {}; }
  if (!prev || typeof prev !== 'object') prev = {};
  if (!next || typeof next !== 'object') return [];
  const out = [];
  const seen = new Set();
  for (const k of [...Object.keys(next), ...Object.keys(prev)]) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (JSON.stringify(next[k]) !== JSON.stringify(prev[k])) {
      out.push(k);
      if (out.length >= MAX_CHANGED_KEYS) break;
    }
  }
  return out;
}

// "Not allowed", plus how to allow it where the operator can (a hosted tenant cannot set env).
function notAllowedMessage() {
  const config = require('../../config');
  return config.selfHosted ? 'The address is not allowed. ' + require('../ssrf-guard').privateAddressHint() : 'The address is not allowed';
}

function describeSyncError(err) {
  if (!err) return 'Sync failed';
  // Written for the operator by the built-in resolvers (lib/data-sources/http.js UserFacingError).
  if (typeof err.userMessage === 'string' && err.userMessage) return err.userMessage.slice(0, 300);
  const m = String(err.message || '');
  if (err.name === 'SsrfError' || err.code === 'ssrf' || /^blocked:/i.test(m)) {
    return notAllowedMessage();
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
  if (err.code === 'weather-location' || /^Location not found/i.test(m)) {
    return 'The location could not be found';
  }
  if (err.code === 'weather-config' || /^Invalid weather configuration/i.test(m)) {
    return 'The weather configuration is invalid';
  }
  if (err.code === 'egress-not-allowed') {
    return notAllowedMessage();
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
 * Does this widget config show any of the `changed` top-level keys of source `slugLower`?
 *
 * #790: an API that stamps "state as of <now>" on every call changed the cached data on every
 * sync, and every slide bound to the source reloaded even though it never showed that field. A
 * `{{ds:slug.key}}` tag reads exactly one top-level key (slide-render.js interpolateDataSources,
 * same key pattern as TAG_KEY_RE), so a widget whose tags all name unchanged keys has nothing new
 * to draw and keeps its revision.
 *
 * Anything we cannot see field by field moves on ANY change, as before:
 *   - `changed` null (first fill, delete, slug rename) or at the changedKeys cap (the list is cut
 *     short, so a shown key may be missing from it);
 *   - a whole-source binding (`"slug":"<slug>"`: template ds_refs, table and menu bindings);
 *   - a `{{ds:slug.` that is not a plain `{{ds:slug.key}}` tag.
 */
const TAG_KEY_RE = /^[a-zA-Z0-9_]+\}\}/;
function showsChange(config, slugLower, changed) {
  const cfg = String(config);
  const lower = cfg.toLowerCase();
  const tag = `{{ds:${slugLower}.`;
  const whole = lower.includes(`"slug":"${slugLower}"`);
  if (!whole && !lower.includes(tag)) return false;
  if (changed == null || changed.length >= MAX_CHANGED_KEYS || whole) return true;
  // A toLowerCase that changed the length (some non-ASCII letters) would misalign the indexes below.
  if (lower.length !== cfg.length) return true;
  const keys = new Set(changed);
  // Indexes come from the lowercased copy; the key itself is read from the original, because the
  // resolver looks keys up case-sensitively (`Temp` and `temp` are different fields).
  for (let i = lower.indexOf(tag); i !== -1; i = lower.indexOf(tag, i + tag.length)) {
    const m = TAG_KEY_RE.exec(cfg.slice(i + tag.length, i + tag.length + 200));
    if (!m) return true;
    if (keys.has(m[0].slice(0, -2))) return true;
  }
  return false;
}

/*
 * Advance the revision of every widget bound to this source's slug, and push to the displays
 * playing them. widgets.updated_at IS the player's widget_rev (the snapshot copies it, the
 * device socket refreshes it at send time, the embedded cache keys on it), so this one write is
 * what makes a data change reach a screen through the immutable render cache. Used by a sync
 * that changed data and by DELETE, which used to leave players on the deleted source's last
 * values indefinitely.
 */
function bumpDependentWidgets(row, nowSec, changed = null, deltaFields = null) {
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
      return showsChange(w.config, slugLower, changed);
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
      // #790: when the org has live field patch on and the change is a set of scalar field values,
      // tell the ONLINE displays the new values so they can patch the field in place. The rev bump
      // and playlist-update below still run, so offline devices, a cold reload and the immutable
      // cache all stay correct; the patch only spares an online screen the visible slide reload.
      let liveFieldPatch = false;
      if (deltaFields && Object.keys(deltaFields).length) {
        try {
          const r = db.prepare('SELECT COALESCE(o.live_field_patch, 0) AS v FROM organizations o JOIN workspaces w ON w.organization_id = o.id WHERE w.id = ?').get(row.workspace_id);
          liveFieldPatch = !!(r && r.v);
        } catch (_) { liveFieldPatch = false; }
      }
      for (const devId of affectedDeviceIds) {
        if (liveFieldPatch) {
          try {
            const r = deviceNs.adapter.rooms.get(devId);
            if (r && r.size > 0) deviceNs.to(devId).emit('device:field-patch', { rev: nowSec, widgetIds, fields: deltaFields });
          } catch (_) { /* best effort; the playlist-update below is the reliable fallback */ }
        }
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
  showsChange,
  changedKeys,
  describeSyncError,
  notAllowedMessage,
  getWorkspaceDataMapSync,
  withFetchSlot,
  syncIntervalMin,
  keepUpdatedStamp,
  pollDueDataSources,
  startDataSourcesPoller,
  stopDataSourcesPoller,
};
