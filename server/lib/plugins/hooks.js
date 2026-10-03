'use strict';

/*
 * Named hooks. An allowlist, not a bus.
 *
 * Plugins register at activate() with api.on(name, fn). Core emits from the
 * one place a thing actually happens (playlist publish, a genuine online/offline
 * transition, a content ingest, a plugin-zip decision) — not from telemetry,
 * not from a dashboard fan-out. Unknown names throw at register time so a typo
 * is a load error, not a silent no-op.
 *
 * Isolation (P3): emit never throws into the caller. Each handler runs on its
 * own turn via setImmediate so a tight loop in a plugin cannot stall heartbeat
 * or a publish. A thrown (or rejected) handler is logged and the rest continue.
 *
 * Payloads are identifiers and names. Never tokens, never secrets, never raw
 * request objects, never zip bytes.
 */

const ALLOWED = new Set([
  'device.offline',
  'device.online',
  'playlist.published',
  'content.uploaded',
  'plugin.submitted',
  'plugin.approved',
  'plugin.rejected',
]);

let handlers = new Map(); // name -> [{ pluginId, fn }]

function reset() {
  handlers = new Map();
}

function register(pluginId, name, fn) {
  if (!ALLOWED.has(name)) {
    throw new Error(`unknown hook "${name}" (allowed: ${[...ALLOWED].join(', ')})`);
  }
  if (typeof fn !== 'function') throw new Error('hook handler must be a function');
  const list = handlers.get(name) || [];
  list.push({ pluginId, fn });
  handlers.set(name, list);
}

function emit(name, payload) {
  if (!ALLOWED.has(name)) return 0;
  const list = handlers.get(name);
  if (!list || !list.length) return 0;
  const body = payload && typeof payload === 'object' ? payload : {};
  for (const { pluginId, fn } of list) {
    setImmediate(() => {
      try {
        const result = fn(body);
        if (result && typeof result.then === 'function') {
          result.catch((e) => {
            console.warn(`[plugin:${pluginId}] hook ${name}:`, e && e.message ? e.message : e);
          });
        }
      } catch (e) {
        console.warn(`[plugin:${pluginId}] hook ${name}:`, e && e.message ? e.message : e);
      }
    });
  }
  return list.length;
}

function dropPlugin(pluginId) {
  for (const [name, list] of handlers) {
    handlers.set(name, list.filter((h) => h.pluginId !== pluginId));
  }
}

function list() {
  const out = {};
  for (const [name, list] of handlers) out[name] = list.map((h) => h.pluginId);
  return out;
}

module.exports = { ALLOWED, reset, register, emit, list, dropPlugin };
