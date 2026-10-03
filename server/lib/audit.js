'use strict';

// One writer for the activity_log rows the approval workflow and version history leave behind.
// The table predates this (auth and device events use it); this only fixes the shape: an
// action name, a JSON details blob, the workspace, and never a secret.
const { db } = require('../db/database');

function audit(action, { userId = null, workspaceId = null, deviceId = null, ip = null, details = null } = {}) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, device_id, action, details, ip_address, workspace_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, deviceId, action, details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)), ip, workspaceId);
  } catch (e) { /* the audit trail must never break the action it records */ }
}

function auditFromReq(req, action, details) {
  audit(action, {
    userId: req && req.user ? req.user.id : null,
    workspaceId: (details && details.workspace_id) || (req && req.workspaceId) || null,
    ip: req && (req.ip || null),
    details,
  });
}

module.exports = { audit, auditFromReq };
