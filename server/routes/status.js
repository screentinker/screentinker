const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const os = require('os');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Public status page
router.get('/', (req, res) => {
  const totalDevices = db.prepare('SELECT COUNT(*) as count FROM devices').get().count;
  const onlineDevices = db.prepare("SELECT COUNT(*) as count FROM devices WHERE status = 'online'").get().count;
  const totalContent = db.prepare('SELECT COUNT(*) as count FROM content').get().count;
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const uptime = process.uptime();

  // Public status - minimal info only (no user counts, no server internals)
  let version = '1.5.1';
  try { version = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'VERSION'), 'utf8').trim(); } catch {}

  res.json({
    status: 'ok',
    version,
    uptime_human: formatUptime(uptime),
    timestamp: new Date().toISOString(),
  });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Full database backup (superadmin only)
router.get('/backup', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = db.prepare('SELECT role FROM users WHERE id = ?').get(decoded.id);
    if (!user || user.role !== 'superadmin') return res.status(403).json({ error: 'Superadmin only' });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const dbPath = require('../config').dbPath;
  res.download(dbPath, `remotedisplay-backup-${new Date().toISOString().split('T')[0]}.db`);
});

// User data export (own data only)
router.get('/export', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Token required' });

  let userId;
  try {
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const decoded = jwt.verify(token, config.jwtSecret);
    userId = decoded.id;
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = db.prepare('SELECT id, email, name, role, auth_provider, plan_id, created_at FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const devices = db.prepare('SELECT id, name, status, ip_address, android_version, app_version, screen_width, screen_height, created_at FROM devices WHERE user_id = ?').all(userId);
  const deviceIds = devices.map(d => d.id);
  const devicePlaceholders = deviceIds.map(() => '?').join(',') || "'__none__'";

  const content = db.prepare('SELECT id, filename, mime_type, file_size, duration_sec, remote_url, width, height, created_at FROM content WHERE user_id = ?').all(userId);
  const widgets = db.prepare('SELECT id, widget_type, name, config, created_at FROM widgets WHERE user_id = ?').all(userId);
  const layouts = db.prepare('SELECT id, name, width, height, is_template, template_category, created_at FROM layouts WHERE user_id = ? AND is_template = 0').all(userId);
  const layoutIds = layouts.map(l => l.id);
  const layoutPlaceholders = layoutIds.map(() => '?').join(',') || "'__none__'";
  const layoutZones = layoutIds.length ? db.prepare(`SELECT * FROM layout_zones WHERE layout_id IN (${layoutPlaceholders})`).all(...layoutIds) : [];

  const assignments = deviceIds.length ? db.prepare(`SELECT id, device_id, content_id, widget_id, zone_id, sort_order, duration_sec, enabled FROM assignments WHERE device_id IN (${devicePlaceholders})`).all(...deviceIds) : [];
  const schedules = db.prepare('SELECT id, device_id, zone_id, content_id, widget_id, layout_id, title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at FROM schedules WHERE user_id = ?').all(userId);
  const videoWalls = db.prepare('SELECT * FROM video_walls WHERE user_id = ?').all(userId);
  const wallIds = videoWalls.map(w => w.id);
  const wallPlaceholders = wallIds.map(() => '?').join(',') || "'__none__'";
  const wallDevices = wallIds.length ? db.prepare(`SELECT * FROM video_wall_devices WHERE wall_id IN (${wallPlaceholders})`).all(...wallIds) : [];

  const kioskPages = db.prepare('SELECT id, name, config, created_at FROM kiosk_pages WHERE user_id = ?').all(userId);
  const deviceGroups = db.prepare('SELECT id, name, color, created_at FROM device_groups WHERE user_id = ?').all(userId);
  const groupIds = deviceGroups.map(g => g.id);
  const groupPlaceholders = groupIds.map(() => '?').join(',') || "'__none__'";
  const groupMembers = groupIds.length ? db.prepare(`SELECT * FROM device_group_members WHERE group_id IN (${groupPlaceholders})`).all(...groupIds) : [];
  const alertConfigs = db.prepare('SELECT id, alert_type, enabled, config, created_at FROM alert_configs WHERE user_id = ?').all(userId);
  const whiteLabel = db.prepare('SELECT * FROM white_labels WHERE user_id = ?').get(userId);

  const exportData = {
    format: 'screentinker-export-v1',
    exported_at: new Date().toISOString(),
    user,
    devices,
    content,
    widgets: widgets.map(w => ({ ...w, config: JSON.parse(w.config || '{}') })),
    layouts,
    layout_zones: layoutZones,
    assignments,
    schedules,
    video_walls: videoWalls,
    video_wall_devices: wallDevices,
    kiosk_pages: kioskPages.map(k => ({ ...k, config: JSON.parse(k.config || '{}') })),
    device_groups: deviceGroups,
    device_group_members: groupMembers,
    alert_configs: alertConfigs.map(a => ({ ...a, config: JSON.parse(a.config || '{}') })),
    white_label: whiteLabel || null,
  };

  // If include_files requested, bundle as ZIP with content files
  if (req.query.include_files === 'true') {
    const archiver = require('archiver');
    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=screentinker-export-${dateStr}.zip`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    // Collect file info and add files to archive
    const filesToInclude = [];
    for (const c of exportData.content) {
      if (c.remote_url || !c.filename) continue;
      const row = db.prepare('SELECT filepath, thumbnail_path FROM content WHERE id = ?').get(c.id);
      if (row?.filepath) {
        const filePath = path.join(config.contentDir, path.basename(row.filepath));
        if (fs.existsSync(filePath)) {
          c.original_filepath = path.basename(row.filepath);
          archive.file(filePath, { name: `files/${c.id}/${c.original_filepath}` });
        }
      }
      if (row?.thumbnail_path) {
        const thumbPath = path.join(config.contentDir, path.basename(row.thumbnail_path));
        if (fs.existsSync(thumbPath)) {
          c.original_thumbnail = path.basename(row.thumbnail_path);
          archive.file(thumbPath, { name: `files/${c.id}/${c.original_thumbnail}` });
        }
      }
    }

    // Add JSON manifest (after filepath fields are populated)
    archive.append(JSON.stringify(exportData, null, 2), { name: 'export.json' });
    archive.finalize();
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=screentinker-export-${new Date().toISOString().split('T')[0]}.json`);
  res.json(exportData);
});

// User data import (JSON or ZIP with files)
const multer = require('multer');
const importUpload = multer({ dest: path.join(os.tmpdir(), 'screentinker-import'), limits: { fileSize: 2 * 1024 * 1024 * 1024 } }); // 2GB max

router.post('/import', importUpload.single('file'), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token required' });

  let userId;
  try {
    const jwt = require('jsonwebtoken');
    const jwtConfig = require('../config');
    const decoded = jwt.verify(authHeader.split(' ')[1], jwtConfig.jwtSecret);
    userId = decoded.id;
    if (!userId) return res.status(401).json({ error: 'Invalid token' });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let data;
  let extractedFiles = {}; // Map of old content ID -> { filepath, thumbnail }

  if (req.file) {
    // ZIP upload — extract export.json and files/
    try {
      const unzipper = require('unzipper');
      const extractDir = path.join(os.tmpdir(), `screentinker-import-${Date.now()}`);
      fs.mkdirSync(extractDir, { recursive: true });

      await new Promise((resolve, reject) => {
        fs.createReadStream(req.file.path)
          .pipe(unzipper.Extract({ path: extractDir }))
          .on('close', resolve)
          .on('error', reject);
      });

      // Read the JSON manifest
      const jsonPath = path.join(extractDir, 'export.json');
      if (!fs.existsSync(jsonPath)) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'ZIP does not contain export.json' });
      }
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      // Map extracted files by content ID, with path traversal validation
      const filesDir = path.join(extractDir, 'files');
      const resolvedExtractDir = path.resolve(extractDir);
      if (fs.existsSync(filesDir)) {
        for (const contentDir of fs.readdirSync(filesDir)) {
          const contentPath = path.resolve(filesDir, contentDir);
          // Validate path is within extractDir to prevent directory traversal
          if (!contentPath.startsWith(resolvedExtractDir)) continue;
          if (!fs.statSync(contentPath).isDirectory()) continue;
          const files = fs.readdirSync(contentPath);
          extractedFiles[contentDir] = files.map(f => {
            const filePath = path.resolve(contentPath, f);
            // Validate each file path is within extractDir
            if (!filePath.startsWith(resolvedExtractDir)) return null;
            return { name: f, path: filePath };
          }).filter(Boolean);
        }
      }

      // Cleanup uploaded zip
      fs.unlinkSync(req.file.path);
    } catch (err) {
      if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Failed to extract ZIP: ' + err.message });
    }
  } else {
    data = req.body;
  }
  if (!data || !data.format || !data.format.startsWith('screentinker-export')) {
    return res.status(400).json({ error: 'Invalid export file. Must be a ScreenTinker export JSON.' });
  }

  const uuid = require('uuid');
  const stats = { devices: 0, content: 0, widgets: 0, layouts: 0, schedules: 0, video_walls: 0, kiosk_pages: 0, device_groups: 0 };

  // Map old IDs to new IDs
  const idMap = { devices: {}, content: {}, widgets: {}, layouts: {}, zones: {}, groups: {}, walls: {}, kiosk: {} };

  const importDb = db.transaction(() => {
    // Import devices (as offline, unlinked - they'll need re-pairing)
    for (const d of (data.devices || [])) {
      const newId = uuid.v4();
      idMap.devices[d.id] = newId;
      const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
      db.prepare(`INSERT INTO devices (id, user_id, name, pairing_code, status, screen_width, screen_height, created_at) VALUES (?, ?, ?, ?, 'provisioning', ?, ?, ?)`).run(newId, userId, d.name, pairingCode, d.screen_width || null, d.screen_height || null, d.created_at || Math.floor(Date.now() / 1000));
      stats.devices++;
    }

    // Import content metadata + files from ZIP if available
    for (const c of (data.content || [])) {
      const newId = uuid.v4();
      idMap.content[c.id] = newId;

      let newFilepath = '';
      let newThumbnail = null;

      // Copy files from ZIP extract if available
      const files = extractedFiles[c.id];
      if (files && files.length > 0) {
        for (const f of files) {
          const ext = path.extname(f.name);
          const destName = `${newId}${ext}`;
          const destPath = path.join(config.contentDir, destName);
          try {
            fs.copyFileSync(f.path, destPath);
            // Match original filepath vs thumbnail
            if (c.original_filepath && f.name === c.original_filepath) {
              newFilepath = destName;
            } else if (c.original_thumbnail && f.name === c.original_thumbnail) {
              newThumbnail = destName;
            } else if (!newFilepath) {
              // Fallback: first non-thumbnail file is the content
              newFilepath = destName;
            }
            stats.files_restored = (stats.files_restored || 0) + 1;
          } catch (err) {
            // File copy failed, content will need re-upload
          }
        }
      }

      db.prepare(`INSERT INTO content (id, user_id, filename, filepath, mime_type, file_size, duration_sec, remote_url, thumbnail_path, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, userId, c.filename, newFilepath, c.mime_type, c.file_size || 0, c.duration_sec || null, c.remote_url || null, newThumbnail, c.width || null, c.height || null, c.created_at || Math.floor(Date.now() / 1000));
      stats.content++;
    }

    // Import widgets
    for (const w of (data.widgets || [])) {
      const newId = uuid.v4();
      idMap.widgets[w.id] = newId;
      const config = typeof w.config === 'string' ? w.config : JSON.stringify(w.config || {});
      db.prepare(`INSERT INTO widgets (id, user_id, widget_type, name, config, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(newId, userId, w.widget_type, w.name, config, w.created_at || Math.floor(Date.now() / 1000));
      stats.widgets++;
    }

    // Import layouts and zones
    for (const l of (data.layouts || [])) {
      const newId = uuid.v4();
      idMap.layouts[l.id] = newId;
      db.prepare(`INSERT INTO layouts (id, user_id, name, width, height, is_template, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`).run(newId, userId, l.name, l.width || 1920, l.height || 1080, l.created_at || Math.floor(Date.now() / 1000));
      stats.layouts++;
    }
    for (const z of (data.layout_zones || [])) {
      const newLayoutId = idMap.layouts[z.layout_id];
      if (!newLayoutId) continue;
      const newId = uuid.v4();
      idMap.zones[z.id] = newId;
      db.prepare(`INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, newLayoutId, z.name, z.x_percent, z.y_percent, z.width_percent, z.height_percent, z.z_index || 0, z.zone_type || 'content', z.fit_mode || 'cover', z.background_color || '#000000', z.sort_order || 0);
    }

    // Import assignments
    for (const a of (data.assignments || [])) {
      const devId = idMap.devices[a.device_id];
      if (!devId) continue;
      const contentId = a.content_id ? idMap.content[a.content_id] : null;
      const widgetId = a.widget_id ? idMap.widgets[a.widget_id] : null;
      const zoneId = a.zone_id ? (idMap.zones[a.zone_id] || null) : null;
      if (!contentId && !widgetId) continue;
      db.prepare(`INSERT INTO assignments (device_id, content_id, widget_id, zone_id, sort_order, duration_sec, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(devId, contentId, widgetId, zoneId, a.sort_order || 0, a.duration_sec || 10, a.enabled !== undefined ? a.enabled : 1);
    }

    // Import schedules
    for (const s of (data.schedules || [])) {
      const devId = idMap.devices[s.device_id];
      if (!devId) continue;
      const newId = uuid.v4();
      db.prepare(`INSERT INTO schedules (id, user_id, device_id, zone_id, content_id, widget_id, layout_id, title, start_time, end_time, timezone, recurrence, recurrence_end, priority, enabled, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, userId, devId, s.zone_id ? (idMap.zones[s.zone_id] || null) : null, s.content_id ? (idMap.content[s.content_id] || null) : null, s.widget_id ? (idMap.widgets[s.widget_id] || null) : null, s.layout_id ? (idMap.layouts[s.layout_id] || null) : null, s.title || '', s.start_time, s.end_time, s.timezone || 'UTC', s.recurrence || null, s.recurrence_end || null, s.priority || 0, s.enabled !== undefined ? s.enabled : 1, s.color || '#3B82F6', s.created_at || Math.floor(Date.now() / 1000));
      stats.schedules++;
    }

    // Import video walls
    for (const w of (data.video_walls || [])) {
      const newId = uuid.v4();
      idMap.walls[w.id] = newId;
      db.prepare(`INSERT INTO video_walls (id, user_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, screen_w_mm, screen_h_mm, sync_mode, content_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(newId, userId, w.name, w.grid_cols, w.grid_rows, w.bezel_h_mm || 0, w.bezel_v_mm || 0, w.screen_w_mm || 400, w.screen_h_mm || 225, w.sync_mode || 'leader', w.content_id ? (idMap.content[w.content_id] || null) : null, w.created_at || Math.floor(Date.now() / 1000));
      stats.video_walls++;
    }
    for (const wd of (data.video_wall_devices || [])) {
      const wallId = idMap.walls[wd.wall_id];
      const devId = idMap.devices[wd.device_id];
      if (!wallId || !devId) continue;
      db.prepare(`INSERT INTO video_wall_devices (wall_id, device_id, grid_col, grid_row, rotation) VALUES (?, ?, ?, ?, ?)`).run(wallId, devId, wd.grid_col, wd.grid_row, wd.rotation || 0);
    }

    // Import kiosk pages
    for (const k of (data.kiosk_pages || [])) {
      const newId = uuid.v4();
      idMap.kiosk[k.id] = newId;
      const config = typeof k.config === 'string' ? k.config : JSON.stringify(k.config || {});
      db.prepare(`INSERT INTO kiosk_pages (id, user_id, name, config, created_at) VALUES (?, ?, ?, ?, ?)`).run(newId, userId, k.name, config, k.created_at || Math.floor(Date.now() / 1000));
      stats.kiosk_pages++;
    }

    // Import device groups
    for (const g of (data.device_groups || [])) {
      const newId = uuid.v4();
      idMap.groups[g.id] = newId;
      db.prepare(`INSERT INTO device_groups (id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`).run(newId, userId, g.name, g.color || '#3B82F6', g.created_at || Math.floor(Date.now() / 1000));
      stats.device_groups++;
    }
    for (const gm of (data.device_group_members || [])) {
      const groupId = idMap.groups[gm.group_id];
      const devId = idMap.devices[gm.device_id];
      if (!groupId || !devId) continue;
      db.prepare(`INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)`).run(groupId, devId);
    }

    // Import alert configs
    for (const a of (data.alert_configs || [])) {
      const newId = uuid.v4();
      const config = typeof a.config === 'string' ? a.config : JSON.stringify(a.config || {});
      db.prepare(`INSERT INTO alert_configs (id, user_id, alert_type, enabled, config, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(newId, userId, a.alert_type, a.enabled !== undefined ? a.enabled : 1, config, a.created_at || Math.floor(Date.now() / 1000));
    }

    // Import white label
    if (data.white_label) {
      const wl = data.white_label;
      const existing = db.prepare('SELECT id FROM white_labels WHERE user_id = ?').get(userId);
      if (existing) {
        db.prepare(`UPDATE white_labels SET brand_name=?, logo_url=?, favicon_url=?, primary_color=?, bg_color=?, custom_domain=?, custom_css=?, hide_branding=?, updated_at=strftime('%s','now') WHERE user_id=?`).run(wl.brand_name || 'ScreenTinker', wl.logo_url || null, wl.favicon_url || null, wl.primary_color || '#3B82F6', wl.bg_color || '#111827', wl.custom_domain || null, wl.custom_css || null, wl.hide_branding || 0, userId);
      } else {
        db.prepare(`INSERT INTO white_labels (id, user_id, brand_name, logo_url, favicon_url, primary_color, bg_color, custom_domain, custom_css, hide_branding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuid.v4(), userId, wl.brand_name || 'ScreenTinker', wl.logo_url || null, wl.favicon_url || null, wl.primary_color || '#3B82F6', wl.bg_color || '#111827', wl.custom_domain || null, wl.custom_css || null, wl.hide_branding || 0);
      }
    }
  });

  try {
    importDb();
    // Collect pairing codes for imported devices
    const devicePairings = (data.devices || []).map(d => {
      const newId = idMap.devices[d.id];
      const dev = db.prepare('SELECT name, pairing_code FROM devices WHERE id = ?').get(newId);
      return dev ? { name: dev.name, pairing_code: dev.pairing_code } : null;
    }).filter(Boolean);

    res.json({
      success: true,
      message: 'Import complete',
      stats,
      device_pairings: devicePairings,
      notes: [
        'Devices need to be re-paired. Use the pairing codes below or re-pair from the Displays page.',
        stats.files_restored ? `${stats.files_restored} content files restored from export.` : 'File-based content needs to be re-uploaded. Remote URL content works immediately.',
        'All IDs have been regenerated to avoid conflicts.',
      ]
    });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  }
});

module.exports = router;
