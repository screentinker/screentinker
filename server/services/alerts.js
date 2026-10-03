const { db } = require('../db/database');
// Scale-out: a sweep on a replica must never act on a COPIED workspace (docs/scale-out-design.md §5.5).
const { LOCAL_ROWS_SQL } = require('../lib/replica-proxy');
const { sendEmail } = require('./email');

// Per-(alert_type, target_id) rate limit. In-memory Map; restarts reset it. For
// device_offline that reset no longer causes duplicate mail - repeat suppression within
// one outage lives on devices.offline_alert_heartbeat, which survives a restart. What
// this Map still buys is a floor on how often a FLAPPING target can alert. Future alert
// types (payment_failed, plan_limit_hit, etc.) share it via the alertType axis.
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

  // A device that is still offline is not a new event. The per-outage marker below is
  // keyed on last_heartbeat, so SQL can exclude everything already alerted for - the
  // rows that come back are genuinely un-alerted outages.
  const offlineDevices = db.prepare(`
    SELECT d.id, d.name, d.user_id, d.workspace_id, d.last_heartbeat, d.status,
           u.email as owner_email, u.name as owner_name, u.email_alerts
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    WHERE d.status = 'offline' AND d.last_heartbeat IS NOT NULL
    AND ${LOCAL_ROWS_SQL('d')}
    AND (? - d.last_heartbeat) > ?
    AND (d.offline_alert_heartbeat IS NULL OR d.offline_alert_heartbeat != d.last_heartbeat)
  `).all(now, threshold);

  for (const device of offlineDevices) {
    // Skip if user has alerts disabled
    if (!device.email_alerts) continue;

    // Long-offline cutoff: never open an outage alert for a device that was already
    // dark for >24h when we first saw it - it's not news. This no longer bounds
    // repeats (the per-outage marker does that); it bounds the FIRST alert, which is
    // what stops a restart from mailing about long-abandoned devices.
    const offlineHours = (now - device.last_heartbeat) / 3600;
    if (offlineHours > 24) continue;

    if (device.owner_email) {
      // Two guards doing two different jobs:
      //   - the SQL marker above stops repeats WITHIN one outage (the actual spam bug)
      //   - this window stops a FLAPPING device turning each short outage into its own
      //     mail. It is checked before the marker is written, so a rate-limited alert is
      //     merely deferred to a later tick rather than marked-and-dropped.
      if (!shouldSendAlert('device_offline', device.id)) continue;

      // Mark the outage BEFORE sending. sendEmail() swallows its own transport errors,
      // so a failed send is indistinguishable from a good one here; marking first means
      // a broken mailbox costs one lost alert rather than one every 60s forever. This is
      // a spam fix - when the two failure modes trade off, err toward not sending.
      db.prepare('UPDATE devices SET offline_alert_heartbeat = ? WHERE id = ?')
        .run(device.last_heartbeat, device.id);

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
        // The offline alert is the email people actually want to stop, so it is the one that most
        // needs a link rather than a support request. email_alerts already gates this send, so the
        // link and the gate are the same switch.
        unsubscribeUserId: device.user_id,
      }).catch(e => console.error('[ALERT] sendEmail rejected unexpectedly:', e.message));

      // Log activity. Phase 2.2 writer-leak fix: stamp workspace_id from the
      // device so the row is tenant-queryable.
      try {
        db.prepare(
          'INSERT INTO activity_log (user_id, device_id, action, details, workspace_id) VALUES (?, ?, ?, ?, ?)'
        ).run(device.user_id, device.id, 'alert:device_offline', `${device.name} offline for ${offlineMinutes}m`, device.workspace_id || null);
      } catch {}
    }
  }

  // Recovery: drop the flap window so a device that genuinely comes back and later fails
  // again alerts immediately. The durable per-outage marker needs no clearing here - a
  // reconnect advances last_heartbeat, which invalidates it by construction.
  const onlineDevices = db.prepare(`SELECT id FROM devices WHERE status = 'online' AND ${LOCAL_ROWS_SQL('devices')}`).all();
  for (const device of onlineDevices) {
    alertLastSent.delete(`device_offline:${device.id}`);
  }
}

// ScreenTinker-branded HTML body for alert emails. Owns the visual template
// previously inlined in the webhook payload at sendEmailAlert.
function buildAlertHtml(recipientName, subject, body) {
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
    <h2 style="color:#3b82f6">ScreenTinker Alert</h2>
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
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
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

// Test seam: drive one tick directly, and reach the in-memory window so a restart
// (which is just "that Map is empty again") can be simulated without a real restart.
module.exports.__test = { checkOfflineDevices, alertLastSent };
