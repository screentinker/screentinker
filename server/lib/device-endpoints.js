'use strict';

const { db } = require('../db/database');
const secrets = require('./plugins/secrets');
const guard = require('./http-target-guard');

/*
 * WHICH SAVED ENDPOINTS DOES THIS SCREEN RUN — the single definition.
 *
 * ⚠️ A UNION, NOT AN OVERRIDE, and the difference from lib/device-power-schedule.js is deliberate.
 * A power schedule answers one question ("is this screen lit"), so device beats group and only one
 * row can win. A list of endpoints is not one answer: a screen should run the endpoints its group
 * defines AND the ones defined for it alone. Picking a winner there would silently drop work an
 * operator configured.
 *
 * The one override is BY NAME. A device-level endpoint called "PLC state" replaces the group's
 * endpoint of the same name, so a single panel can be pointed at a different address without being
 * taken out of the group. Names are how an operator refers to these, so names are what collide.
 *
 * ⚠️ Nothing here polls. These rows are a DEFINITION, synced to the panel, and the panel runs them
 * on its own clock — including with the WAN down, which is the entire reason the request happens
 * there rather than here.
 */

/** Header names are arbitrary, so the secret-field list is built from the names present. */
function headerFields(headers) {
  return Object.keys(headers || {}).map((name) => ({ name, type: 'password' }));
}

function parseHeaders(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

/**
 * ⚠️ EVERY header value is treated as secret, not just the ones that look like credentials.
 *
 * lib/plugins/secrets has a name-based heuristic (`authorization`, `x-api-key`, …) which is right
 * for a plugin schema where most fields are innocuous. Here the opposite is true: an endpoint
 * header is overwhelmingly a credential, and the one that is not — `Accept: application/json` —
 * costs nothing to encrypt. Guessing wrong in the other direction leaks an API key to anyone who
 * can read the row.
 */
function encryptHeaders(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  return secrets.encryptSecrets(h, headerFields(h));
}

function decryptHeaders(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  return secrets.decryptSecrets(h, headerFields(h));
}

/** For GET: names visible, values never. */
function redactHeaders(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const out = {};
  for (const k of Object.keys(h)) out[k] = '';
  return out;
}

/**
 * Merge incoming headers over stored ones, keeping a value the caller left blank.
 *
 * Without this, editing an endpoint's URL in a form that cannot show the API key would erase the
 * key — the classic "the form saved what it could see" data loss.
 */
function mergeHeaders(incoming, storedPlain) {
  const next = incoming && typeof incoming === 'object' ? { ...incoming } : {};
  const prev = storedPlain && typeof storedPlain === 'object' ? storedPlain : {};
  for (const k of Object.keys(next)) {
    if (next[k] === '' || next[k] === '***') {
      if (prev[k] !== undefined && prev[k] !== '') next[k] = prev[k];
      else delete next[k];
    }
  }
  return next;
}

const RUN_ON = ['screen_on', 'screen_off', 'heartbeat'];

/**
 * Validate a definition before it is stored.
 *
 * Strict here, forgiving on the panel — the same split the power windows and set_server_url use.
 * The panel refuses a bad target too (a stored row can be edited in the database), but an operator
 * typing `file:///` deserves a 400 that names the problem rather than a silent no-op on a screen.
 */
function validate(body, { partial = false } = {}) {
  const b = body || {};

  if (!partial || b.name !== undefined) {
    const name = String(b.name || '').trim();
    if (!name) return 'name is required';
    if (name.length > 80) return 'name is too long';
  }

  if (!partial || b.url !== undefined) {
    const verdict = guard.check(b.url);
    if (!verdict.allow) return `url: ${guard.explain(verdict.reason)}`;
  }

  if (!partial || b.method !== undefined) {
    const { HTTP_METHODS } = require('./device-command');
    if (b.method !== undefined && b.method !== null
        && !HTTP_METHODS.includes(String(b.method).toUpperCase())) {
      return `method must be one of ${HTTP_METHODS.join(', ')}`;
    }
  }

  if (b.headers !== undefined && b.headers !== null
      && (typeof b.headers !== 'object' || Array.isArray(b.headers))) {
    return 'headers must be an object';
  }
  for (const [k, v] of Object.entries(b.headers || {})) {
    // A newline in a header value can inject a second header. The panel refuses these too; this
    // keeps the error legible instead of a silent drop at request time.
    if (typeof v === 'string' && /[\r\n]/.test(v)) return `header ${k} must not contain a newline`;
  }

  if (b.timeout_ms !== undefined && b.timeout_ms !== null) {
    const t = Number(b.timeout_ms);
    if (!Number.isFinite(t) || t <= 0 || t > 120000) return 'timeout_ms must be between 1 and 120000';
  }

  if (b.interval_sec !== undefined && b.interval_sec !== null) {
    const n = Number(b.interval_sec);
    /*
     * ⚠️ A 30-SECOND FLOOR. This runs on a panel whose day job is playing video, against a target
     * that is frequently a small embedded controller. A one-second poll is how a screen stutters
     * and a PLC gets hammered, and neither symptom points back here.
     */
    if (!Number.isFinite(n) || n < 30 || n > 86400) return 'interval_sec must be between 30 and 86400';
  }

  if (b.run_on !== undefined && b.run_on !== null && b.run_on !== '') {
    if (!RUN_ON.includes(b.run_on)) return `run_on must be one of ${RUN_ON.join(', ')}`;
  }

  if (b.interval_sec && b.run_on) {
    return 'an endpoint runs on an interval OR on an event, not both';
  }

  return null;
}

/** The wire shape the panel stores and runs. Headers are PLAINTEXT here — it must make the call. */
function toPlayerShape(row) {
  return {
    id: row.id,
    name: row.name,
    method: (row.method || 'GET').toUpperCase(),
    url: row.url,
    headers: decryptHeaders(parseHeaders(row.headers)),
    body: row.body || null,
    timeout_ms: row.timeout_ms || null,
    interval_sec: row.interval_sec || null,
    run_on: row.run_on || null,
  };
}

/**
 * Every endpoint this device should run: its group's, plus its own, with its own winning by name.
 */
function endpointsForDevice(deviceId) {
  const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return [];

  const groupRows = db.prepare(
    `SELECT e.* FROM device_endpoints e
       JOIN device_group_members m ON m.group_id = e.group_id
      WHERE m.device_id = ? AND e.workspace_id = ? AND e.enabled = 1
      ORDER BY e.group_id ASC, e.name ASC`
  ).all(deviceId, device.workspace_id);

  const ownRows = db.prepare(
    'SELECT * FROM device_endpoints WHERE device_id = ? AND workspace_id = ? AND enabled = 1 ORDER BY name ASC'
  ).all(deviceId, device.workspace_id);

  const byName = new Map();
  for (const r of groupRows) byName.set(r.name, r);
  for (const r of ownRows) byName.set(r.name, r);   // the device's own wins the name
  return [...byName.values()].map(toPlayerShape);
}

/** Devices whose list may have changed because this endpoint did. */
function devicesForEndpoint(endpointId) {
  const e = db.prepare('SELECT device_id, group_id FROM device_endpoints WHERE id = ?').get(endpointId);
  if (!e) return [];
  if (e.device_id) return [e.device_id];
  return db.prepare('SELECT device_id FROM device_group_members WHERE group_id = ?')
    .all(e.group_id).map((r) => r.device_id);
}

module.exports = {
  RUN_ON, validate, endpointsForDevice, devicesForEndpoint, toPlayerShape,
  encryptHeaders, decryptHeaders, redactHeaders, mergeHeaders, parseHeaders,
};
