const { db } = require('../db/database');
const { sendEmail } = require('./email');

// Per-(alert_type, target_id) dedup. In-memory Map; restarts reset it, which
// at current alert volume is fine - worst case is one duplicate alert after
// a server restart. Future alert types (payment_failed, plan_limit_hit, etc.)
// share this same mechanism via the alertType axis.
const alertLastSent = new Map();
const DEFAULT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

function shouldSendAlert(alertType, targetId, windowMs = DEFAULT_DEDUP_WINDOW_MS) {
  const key = `${alertType}:${targetId}`;
  const last = alertLastSent.get(key) || 0;
  if (Date.now() - last < windowMs) return false;
  alertLastSent.set(key, Date.now());
  return true;
}

function startAlertService(io) {
  setInterval(() => checkOfflineDevices(io), 60000);
  console.log('Alert service started');
}

async function checkOfflineDevices(io) {
  const now = Math.floor(Date.now() / 1000);
  const threshold = 300; // 5 minutes offline

  const offlineDevices = db.prepare(`
    SELECT d.id, d.name, d.user_id, d.workspace_id, d.last_heartbeat, d.status,
           u.email as owner_email, u.name as owner_name, u.email_alerts
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    WHERE d.status = 'offline' AND d.last_heartbeat IS NOT NULL
    AND (? - d.last_heartbeat) > ?
  `).all(now, threshold);

  for (const device of offlineDevices) {
    // Dedup: skip if we've alerted on this device within the window
    if (!shouldSendAlert('device_offline', device.id)) continue;

    // Skip if user has alerts disabled
    if (!device.email_alerts) continue;

    // Long-offline cutoff: stop nagging about devices that have been offline
    // for >24 hours. They're not a notification-worthy event anymore - either
    // the user knows, or the device is abandoned. Spares ~15 chronic-offline
    // prod devices from re-firing every 2-hour dedup window.
    const offlineHours = (now - device.last_heartbeat) / 3600;
    if (offlineHours > 24) continue;

    if (device.owner_email) {
      const offlineMinutes = Math.floor((now - device.last_heartbeat) / 60);
      const subject = `Display Offline: ${device.name}`;
      const body = `Your display "${device.name}" has been offline for ${offlineMinutes} minutes.\n\nLast heartbeat: ${new Date(device.last_heartbeat * 1000).toLocaleString()}\n\nCheck your device and network connection.\n\n- ScreenTinker`;

      // Sequential await: Microsoft Graph imposes a MailboxConcurrency limit
      // (429 ApplicationThrottled when fanning out ~20+ parallel sends from
      // one app). At ~250ms per send, a backlog of 20 devices takes ~5s -
      // well within the 60s alert tick interval. sendEmail() never throws
      // (catches Graph errors internally) so the .catch is defensive only.
      await sendEmail({
        to: device.owner_email,
        subject,
        text: body,
        html: buildAlertHtml(device.owner_name, subject, body),
      }).catch(e => console.error('[ALERT] sendEmail rejected unexpectedly:', e.message));

      // Log activity. Phase 2.2 writer-leak fix: stamp workspace_id from the
      // device so the row is tenant-queryable.
      try {
        db.prepare(
          'INSERT INTO activity_log (user_id, device_id, action, details, workspace_id) VALUES (?, ?, ?, ?, ?)'
        ).run(device.user_id, device.id, 'alert:device_offline', `${device.name} offline for ${offlineMinutes}m`, device.workspace_id || null);
      } catch { }
    }
  }

  // Clear notifications for devices that came back online
  const onlineDevices = db.prepare("SELECT id FROM devices WHERE status = 'online'").all();
  for (const device of onlineDevices) {
    alertLastSent.delete(`device_offline:${device.id}`);
  }
}

// ScreenTinker-branded HTML body for alert emails. Owns the visual template
// previously inlined in the webhook payload at sendEmailAlert.
function buildAlertHtml(recipientName, subject, body) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
    <h2 style="color:#e65c00">ScreenTinker Alert</h2>
    <p>Hi ${escapeHtml(recipientName || 'there')},</p>
    <div style="background:#f1f5f9;padding:16px;border-radius:8px;margin:16px 0">
      <strong>${escapeHtml(subject)}</strong><br><br>
      ${escapeHtml(body).replace(/\n/g, '<br>')}
    </div>
    <p style="color:#94a3b8;font-size:12px">You're receiving this because you have email alerts enabled in ScreenTinker.</p>
  </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Legacy export name preserved - some other modules may still call this.
// Internally delegates to sendEmail() with the ScreenTinker HTML template.
function sendEmailAlert(to, name, { subject, body }) {
  return sendEmail({
    to,
    subject,
    text: body,
    html: buildAlertHtml(name, subject, body),
  });
}

module.exports = { startAlertService, sendEmailAlert };
