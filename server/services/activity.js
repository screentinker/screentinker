const { db } = require('../db/database');

function logActivity(userId, action, details = null, deviceId = null, ipAddress = null) {
  try {
    db.prepare(
      'INSERT INTO activity_log (user_id, device_id, action, details, ip_address) VALUES (?, ?, ?, ?, ?)'
    ).run(userId || null, deviceId || null, action, details || null, ipAddress || null);
  } catch (e) {
    console.error('Activity log error:', e.message);
  }
}

function getActivity(options = {}) {
  const { userId, deviceId, limit = 50, offset = 0 } = options;
  let sql = `SELECT al.*, u.name as user_name, u.email as user_email
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id WHERE 1=1`;
  const params = [];

  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (deviceId) { sql += ' AND al.device_id = ?'; params.push(deviceId); }

  sql += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

// Prune old activity logs (keep 90 days)
function pruneActivityLog() {
  db.prepare("DELETE FROM activity_log WHERE created_at < strftime('%s','now') - (90 * 86400)").run();
}

// Express middleware to auto-log API mutations
function activityLogger(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // Only log successful mutations
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && res.statusCode < 400) {
      const action = `${req.method} ${req.baseUrl || ''}${req.route?.path || req.path}`;
      const userId = req.user?.id;
      const deviceId = req.params?.id || req.params?.deviceId || req.body?.device_id;
      const details = summarizeAction(req);
      logActivity(userId, action, details, deviceId, req.ip);
    }
    return originalJson(data);
  };
  next();
}

function summarizeAction(req) {
  const parts = [];
  if (req.body?.name) parts.push(`name: ${req.body.name}`);
  if (req.body?.filename) parts.push(`file: ${req.body.filename}`);
  if (req.body?.pairing_code) parts.push('device paired');
  if (req.body?.plan_id) parts.push(`plan: ${req.body.plan_id}`);
  if (req.file?.originalname) parts.push(`uploaded: ${req.file.originalname}`);
  return parts.join(', ') || null;
}

module.exports = { logActivity, getActivity, pruneActivityLog, activityLogger };
