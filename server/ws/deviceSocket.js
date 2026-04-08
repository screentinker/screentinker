const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db, pruneTelemetry, pruneScreenshots } = require('../db/database');
const config = require('../config');
const heartbeat = require('../services/heartbeat');
const { getUserPlan, getUserDeviceCount } = require('../middleware/subscription');

// In-memory store for latest screenshot per device (avoids disk writes during streaming)
let lastScreenshots = {};

function logDeviceStatus(deviceId, status) {
  try {
    db.prepare('INSERT INTO device_status_log (device_id, status) VALUES (?, ?)').run(deviceId, status);
    // Prune entries older than 7 days
    db.prepare("DELETE FROM device_status_log WHERE device_id = ? AND timestamp < strftime('%s','now') - 604800").run(deviceId);
  } catch (e) { /* table might not exist yet */ }
}


// Build playlist payload with layout and zones
function buildPlaylistPayload(deviceId) {
  const assignments = db.prepare(`
    SELECT a.*, COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size, c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM assignments a LEFT JOIN content c ON a.content_id = c.id LEFT JOIN widgets w ON a.widget_id = w.id
    WHERE a.device_id = ? AND a.enabled = 1
    ORDER BY a.sort_order ASC
  `).all(deviceId);

  // Get device's layout with zones
  const device = db.prepare('SELECT layout_id, orientation FROM devices WHERE id = ?').get(deviceId);
  let layout = null;
  if (device?.layout_id) {
    layout = db.prepare('SELECT * FROM layouts WHERE id = ?').get(device.layout_id);
    if (layout) {
      layout.zones = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layout.id);
    }
  }

  return { assignments, layout, orientation: device?.orientation || 'landscape' };
}

// Check if a device should show trial expired screen
function checkDeviceAccess(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  if (!device || !device.user_id) return { allowed: true };

  const plan = getUserPlan(device.user_id);
  if (!plan) return { allowed: true };

  // Check if trial expired and over free limit
  if (plan.trial_started && !plan.trial_active && plan.plan_name === 'free') {
    const deviceCount = getUserDeviceCount(device.user_id);
    // Get this device's position (ordered by created_at)
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);

    // Only the first device (within free limit) is allowed
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'trial_expired',
        message: 'Trial Expired',
        detail: 'Upgrade your plan to continue using this display.',
      };
    }
  }

  // Check if over plan device limit (non-trial)
  if (!plan.trial_started && plan.max_devices > 0) {
    const userDevices = db.prepare('SELECT id FROM devices WHERE user_id = ? ORDER BY created_at ASC').all(device.user_id);
    const deviceIndex = userDevices.findIndex(d => d.id === deviceId);
    if (deviceIndex >= plan.max_devices) {
      return {
        allowed: false,
        reason: 'device_limit',
        message: 'Device Limit Reached',
        detail: 'Upgrade your plan to activate this display.',
      };
    }
  }

  return { allowed: true };
}

module.exports = function setupDeviceSocket(io) {
  // Expose lastScreenshots for the screenshot API endpoint
  module.exports.lastScreenshots = lastScreenshots;
  const deviceNs = io.of('/device');
  const dashboardNs = io.of('/dashboard');

  deviceNs.on('connection', (socket) => {
    console.log(`Device socket connected: ${socket.id}`);
    let currentDeviceId = null;

    // Device registers with a pairing code (first time) or device_id (reconnect)
    socket.on('device:register', (data) => {
      const { pairing_code, device_id, device_info, fingerprint } = data;

      // Track device fingerprint to prevent reinstall abuse
      if (fingerprint) {
        try {
          const existing = db.prepare('SELECT * FROM device_fingerprints WHERE fingerprint = ?').get(fingerprint);
          if (existing) {
            db.prepare("UPDATE device_fingerprints SET last_seen = strftime('%s','now'), device_id = ? WHERE fingerprint = ?")
              .run(device_id || existing.device_id, fingerprint);
            // If this fingerprint was previously registered to a different device, block the new registration
            if (!device_id && existing.device_id && pairing_code) {
              // Someone reinstalled - link them back to existing device
              const oldDevice = db.prepare('SELECT * FROM devices WHERE id = ?').get(existing.device_id);
              if (oldDevice) {
                console.log(`Fingerprint match: linking to existing device ${existing.device_id}`);
                socket.emit('device:registered', { device_id: existing.device_id, status: oldDevice.status });
                currentDeviceId = existing.device_id;
                heartbeat.registerConnection(existing.device_id, socket.id);
                socket.join(existing.device_id);
                // Send playlist
                const access = checkDeviceAccess(existing.device_id);
                if (!access.allowed) {
                  socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
                } else {
                  socket.emit('device:playlist-update', buildPlaylistPayload(existing.device_id));
                }
                return;
              }
            }
          } else if (device_id || pairing_code) {
            db.prepare("INSERT OR IGNORE INTO device_fingerprints (fingerprint, device_id) VALUES (?, ?)")
              .run(fingerprint, device_id || null);
          }
        } catch (e) {
          console.error('Fingerprint tracking error:', e.message);
        }
      }

      if (device_id) {
        // Reconnecting known device
        const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(device_id);
        if (device) {
          currentDeviceId = device_id;
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), ip_address = ?, updated_at = strftime('%s','now') WHERE id = ?")
            .run(socket.handshake.address, device_id);

          if (device_info) {
            db.prepare('UPDATE devices SET android_version = ?, app_version = ?, screen_width = ?, screen_height = ? WHERE id = ?')
              .run(device_info.android_version, device_info.app_version, device_info.screen_width, device_info.screen_height, device_id);
          }

          heartbeat.registerConnection(device_id, socket.id);
          socket.join(device_id);
          socket.emit('device:registered', { device_id, status: 'online' });
          logDeviceStatus(device_id, 'online');

          // Check subscription/trial status before sending playlist
          const access = checkDeviceAccess(device_id);
          if (!access.allowed) {
            socket.emit('device:playlist-update', { assignments: [], suspended: true, message: access.message, detail: access.detail });
          } else {
            socket.emit('device:playlist-update', buildPlaylistPayload(device_id));
          }

          dashboardNs.emit('dashboard:device-status', { device_id, status: 'online' });
          console.log(`Device reconnected: ${device_id}`);
          return;
        }

        // Device ID not found in database - tell device to re-provision
        console.log(`Device ${device_id} not found in database, sending unpaired`);
        socket.emit('device:unpaired', { reason: 'not_found' });
        return;
      }

      if (pairing_code) {
        // New device registering with pairing code
        const id = uuidv4();
        currentDeviceId = id;

        db.prepare(`
          INSERT INTO devices (id, pairing_code, status, ip_address, android_version, app_version, screen_width, screen_height, last_heartbeat)
          VALUES (?, ?, 'provisioning', ?, ?, ?, ?, ?, strftime('%s','now'))
        `).run(
          id, pairing_code, socket.handshake.address,
          device_info?.android_version || null,
          device_info?.app_version || null,
          device_info?.screen_width || null,
          device_info?.screen_height || null
        );

        heartbeat.registerConnection(id, socket.id);
        socket.join(id);
        socket.emit('device:registered', { device_id: id, status: 'provisioning' });

        dashboardNs.emit('dashboard:device-added', db.prepare('SELECT * FROM devices WHERE id = ?').get(id));
        console.log(`New device registered: ${id} with pairing code: ${pairing_code}`);
      }
    });

    // Heartbeat with telemetry
    socket.on('device:heartbeat', (data) => {
      const { device_id, telemetry } = data;
      if (!device_id) return;

      currentDeviceId = device_id;
      heartbeat.updateHeartbeat(device_id);

      db.prepare("UPDATE devices SET status = 'online', last_heartbeat = strftime('%s','now'), updated_at = strftime('%s','now') WHERE id = ?")
        .run(device_id);

      if (telemetry) {
        db.prepare(`
          INSERT INTO device_telemetry (device_id, battery_level, battery_charging, storage_free_mb, storage_total_mb,
            ram_free_mb, ram_total_mb, cpu_usage, wifi_ssid, wifi_rssi, uptime_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          device_id,
          telemetry.battery_level ?? null,
          telemetry.battery_charging ? 1 : 0,
          telemetry.storage_free_mb ?? null,
          telemetry.storage_total_mb ?? null,
          telemetry.ram_free_mb ?? null,
          telemetry.ram_total_mb ?? null,
          telemetry.cpu_usage ?? null,
          telemetry.wifi_ssid ?? null,
          telemetry.wifi_rssi ?? null,
          telemetry.uptime_seconds ?? null
        );
        pruneTelemetry(device_id);

        dashboardNs.emit('dashboard:device-status', {
          device_id,
          status: 'online',
          telemetry
        });
      }
    });

    // Screenshot received from device - relay via WebSocket, keep latest in memory
    socket.on('device:screenshot', (data) => {
      const { device_id, image_b64 } = data;
      if (!device_id || !image_b64) return;

      // Store latest screenshot in memory (for Now Playing preview and offline snapshot)
      if (!lastScreenshots) lastScreenshots = {};
      lastScreenshots[device_id] = image_b64;

      // Relay directly to dashboard - no disk write
      try {
        dashboardNs.emit('dashboard:screenshot-ready', {
          device_id,
          image_data: `data:image/jpeg;base64,${image_b64}`,
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('Screenshot save error:', err);
      }
    });

    // Content download acknowledgement
    socket.on('device:content-ack', (data) => {
      const { device_id, content_id, status } = data;
      console.log(`Device ${device_id} content ${content_id}: ${status}`);
      dashboardNs.emit('dashboard:content-ack', { device_id, content_id, status });
    });

    // Playback state update
    socket.on('device:playback-state', (data) => {
      dashboardNs.emit('dashboard:playback-state', data);
    });

    // Play event logging (proof-of-play)
    socket.on('device:play-event', (data) => {
      const { device_id, event, content_id, content_name, zone_id, completed } = data;
      try {
        if (event === 'play_start') {
          db.prepare(`
            INSERT INTO play_logs (device_id, content_id, zone_id, content_name, started_at, trigger_type)
            VALUES (?, ?, ?, ?, strftime('%s','now'), 'playlist')
          `).run(device_id, content_id || null, zone_id || null, content_name || 'Unknown');
        } else if (event === 'play_end') {
          db.prepare(`
            UPDATE play_logs SET ended_at = strftime('%s','now'),
              duration_sec = strftime('%s','now') - started_at,
              completed = ?
            WHERE id = (
              SELECT id FROM play_logs WHERE device_id = ? AND content_id = ? AND ended_at IS NULL
              ORDER BY started_at DESC LIMIT 1
            )
          `).run(completed ? 1 : 0, device_id, content_id);
        }
      } catch (err) {
        console.error('Play log error:', err.message);
      }
    });

    // Video wall sync relay
    socket.on('wall:sync', (data) => {
      // Relay to all devices in the same wall
      const wallDevices = db.prepare(
        'SELECT device_id FROM video_wall_devices WHERE wall_id = ? AND device_id != ?'
      ).all(data.wall_id, data.device_id);
      for (const wd of wallDevices) {
        deviceNs.to(wd.device_id).emit('wall:sync', data);
      }
    });

    socket.on('disconnect', () => {
      if (currentDeviceId) {
        console.log(`Device disconnected: ${currentDeviceId}`);
        db.prepare("UPDATE devices SET status = 'offline', updated_at = strftime('%s','now') WHERE id = ?")
          .run(currentDeviceId);
        heartbeat.removeConnection(currentDeviceId);
        logDeviceStatus(currentDeviceId, 'offline');
        dashboardNs.emit('dashboard:device-status', { device_id: currentDeviceId, status: 'offline' });

        // Save last screenshot to disk as offline snapshot
        const lastB64 = lastScreenshots[currentDeviceId];
        if (lastB64) {
          try {
            const filename = `${currentDeviceId}_latest.jpg`;
            const buffer = Buffer.from(lastB64, 'base64');
            fs.writeFileSync(path.join(config.screenshotsDir, filename), buffer);
            // Upsert screenshot record
            const existing = db.prepare('SELECT id FROM screenshots WHERE device_id = ?').get(currentDeviceId);
            if (existing) {
              db.prepare('UPDATE screenshots SET filepath = ?, captured_at = strftime(\'%s\',\'now\') WHERE device_id = ?')
                .run(filename, currentDeviceId);
            } else {
              db.prepare('INSERT INTO screenshots (device_id, filepath) VALUES (?, ?)').run(currentDeviceId, filename);
            }
          } catch (e) {
            console.error('Failed to save offline screenshot:', e.message);
          }
          delete lastScreenshots[currentDeviceId];
        }
      }
    });
  });

  return deviceNs;
};
