'use strict';
/*
 * #talk / #go2rtc — per-organization WebRTC settings.
 *
 * Two org-level knobs, both resolved from a device or workspace up to its organization:
 *   - talk_enabled: the voice-intercom / PA feature is off by default and enabled per org. Gated on
 *     top of the global TALK_ENABLED master switch (config.talkEnabled).
 *   - ice_servers: an optional per-org ICE (STUN/TURN) override, a JSON array of
 *     [{urls, username?, credential?}]. NULL falls back to the global go2rtc ice_servers, so an org
 *     can bring its own TURN without touching the sidecar. Applies to live video AND talk.
 */
const { db } = require('../db/database');
const config = require('../config');
const go2rtc = require('./go2rtc');

function orgRow(orgId) {
  if (!orgId) return null;
  try { return db.prepare('SELECT talk_enabled, ice_servers FROM organizations WHERE id = ?').get(orgId); }
  catch (_) { return null; }
}

function orgIdForWorkspace(workspaceId) {
  if (!workspaceId) return null;
  try { const w = db.prepare('SELECT organization_id FROM workspaces WHERE id = ?').get(workspaceId); return (w && w.organization_id) || null; }
  catch (_) { return null; }
}

function orgIdForDevice(deviceId) {
  if (!deviceId) return null;
  try { const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(deviceId); return d && d.workspace_id ? orgIdForWorkspace(d.workspace_id) : null; }
  catch (_) { return null; }
}

// Talk available for this org? Global master AND the org's per-org flag. (go2rtc reachability is
// checked separately by each descriptor.)
function talkEnabled(orgId) {
  if (!config.talkEnabled || !orgId) return false;
  const o = orgRow(orgId);
  return !!(o && o.talk_enabled);
}
function talkEnabledForWorkspace(workspaceId) { return talkEnabled(orgIdForWorkspace(workspaceId)); }
function talkEnabledForDevice(deviceId) { return talkEnabled(orgIdForDevice(deviceId)); }

// ICE servers for this org: the per-org override if set and valid, else the global go2rtc set.
function iceServers(orgId) {
  const o = orgRow(orgId);
  if (o && o.ice_servers) {
    try { const a = JSON.parse(o.ice_servers); if (Array.isArray(a) && a.length) return a; } catch (_) { /* bad JSON -> fall back */ }
  }
  return go2rtc.iceServers();
}
function iceServersForWorkspace(workspaceId) { return iceServers(orgIdForWorkspace(workspaceId)); }
function iceServersForDevice(deviceId) { return iceServers(orgIdForDevice(deviceId)); }

module.exports = {
  orgIdForWorkspace, orgIdForDevice,
  talkEnabled, talkEnabledForWorkspace, talkEnabledForDevice,
  iceServers, iceServersForWorkspace, iceServersForDevice,
};
