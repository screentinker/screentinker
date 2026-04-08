const { db } = require('../db/database');
const config = require('../config');
const https = require('https');
const http = require('http');

// Track device offline timestamps to avoid spamming
const offlineNotified = new Map();

function startAlertService(io) {
  // Check for offline devices every 60 seconds
  setInterval(() => checkOfflineDevices(io), 60000);
  console.log('Alert service started');
}

function checkOfflineDevices(io) {
  const now = Math.floor(Date.now() / 1000);
  const threshold = 300; // 5 minutes offline

  const offlineDevices = db.prepare(`
    SELECT d.id, d.name, d.user_id, d.last_heartbeat, d.status,
           u.email as owner_email, u.name as owner_name, u.email_alerts
    FROM devices d
    LEFT JOIN users u ON d.user_id = u.id
    WHERE d.status = 'offline' AND d.last_heartbeat IS NOT NULL
    AND (? - d.last_heartbeat) > ?
  `).all(now, threshold);

  for (const device of offlineDevices) {
    // Skip if already notified in the last hour
    const lastNotified = offlineNotified.get(device.id) || 0;
    if (now - lastNotified < 3600) continue;

    // Skip if user has alerts disabled
    if (!device.email_alerts) continue;

    // Send alert
    if (device.owner_email) {
      const offlineMinutes = Math.floor((now - device.last_heartbeat) / 60);
      sendEmailAlert(device.owner_email, device.owner_name, {
        subject: `Display Offline: ${device.name}`,
        body: `Your display "${device.name}" has been offline for ${offlineMinutes} minutes.\n\nLast heartbeat: ${new Date(device.last_heartbeat * 1000).toLocaleString()}\n\nCheck your device and network connection.\n\n- ScreenTinker`
      });
      offlineNotified.set(device.id, now);

      // Log activity
      try {
        db.prepare(
          'INSERT INTO activity_log (user_id, device_id, action, details) VALUES (?, ?, ?, ?)'
        ).run(device.user_id, device.id, 'alert:device_offline', `${device.name} offline for ${offlineMinutes}m`);
      } catch {}
    }
  }

  // Clear notifications for devices that came back online
  const onlineDevices = db.prepare("SELECT id FROM devices WHERE status = 'online'").all();
  for (const device of onlineDevices) {
    offlineNotified.delete(device.id);
  }
}

function sendEmailAlert(to, name, { subject, body }) {
  // Use a simple webhook/SMTP relay approach
  // If SMTP_WEBHOOK is set, POST to it (works with services like Mailgun, SendGrid, etc.)
  const webhookUrl = config.emailWebhookUrl;

  if (!webhookUrl) {
    console.log(`[ALERT] Would email ${to}: ${subject}`);
    console.log(`  ${body.split('\n')[0]}`);
    return;
  }

  try {
    const url = new URL(webhookUrl);
    const postData = JSON.stringify({
      to,
      subject: `[ScreenTinker] ${subject}`,
      text: body,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#3b82f6">ScreenTinker Alert</h2>
        <p>Hi ${name || 'there'},</p>
        <div style="background:#f1f5f9;padding:16px;border-radius:8px;margin:16px 0">
          <strong>${subject}</strong><br><br>
          ${body.replace(/\n/g, '<br>')}
        </div>
        <p style="color:#94a3b8;font-size:12px">You're receiving this because you have email alerts enabled in ScreenTinker.</p>
      </div>`
    });

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      if (res.statusCode >= 400) console.error(`Email webhook failed: ${res.statusCode}`);
    });
    req.on('error', (e) => console.error('Email webhook error:', e.message));
    req.write(postData);
    req.end();
  } catch (e) {
    console.error('Email alert error:', e.message);
  }
}

module.exports = { startAlertService, sendEmailAlert };
