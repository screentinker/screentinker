const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

// Escape HTML to prevent XSS
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Validate CSS color values to prevent style injection
function safeColor(val, fallback) {
  if (!val) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(val) || /^[a-zA-Z]+$/.test(val)) return val;
  return fallback;
}

// Validate CSS numeric values
function safeNumber(val, fallback) {
  const n = Number(val);
  return isFinite(n) ? n : fallback;
}

// List kiosk pages
router.get('/', (req, res) => {
  const isAdmin = req.user.role === 'superadmin';
  const pages = db.prepare(
    `SELECT * FROM kiosk_pages ${isAdmin ? '' : 'WHERE user_id = ?'} ORDER BY created_at DESC`
  ).all(...(isAdmin ? [] : [req.user.id]));
  res.json(pages);
});

// Helper: check kiosk ownership
function checkKioskAccess(req, res) {
  const page = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id);
  if (!page) { res.status(404).json({ error: 'Page not found' }); return null; }
  if (req.user && !['admin','superadmin'].includes(req.user.role) && page.user_id !== req.user.id) {
    res.status(403).json({ error: 'Access denied' }); return null;
  }
  return page;
}

// Get kiosk page
router.get('/:id', (req, res) => {
  const page = checkKioskAccess(req, res);
  if (!page) return;
  res.json(page);
});

// Render kiosk page (public - accessed by devices)
router.get('/:id/render', (req, res) => {
  const page = db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id);
  if (!page) return res.status(404).send('Page not found');

  const config = JSON.parse(page.config || '{}');
  const buttons = config.buttons || [];
  const style = config.style || {};

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
  * { margin:0; padding:0; box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { width:100vw; height:100vh; overflow:hidden; font-family:${escapeHtml(style.fontFamily) || '-apple-system,sans-serif'};
    background:${escapeHtml(style.background) || '#111827'}; color:${safeColor(style.textColor, '#f1f5f9')}; display:flex; flex-direction:column; }
  .header { padding:40px 60px 20px; text-align:${/^(left|center|right)$/.test(style.headerAlign) ? style.headerAlign : 'center'}; }
  .header h1 { font-size:${safeNumber(style.titleSize, 48)}px; font-weight:700; }
  .header p { font-size:${safeNumber(style.subtitleSize, 20)}px; opacity:0.7; margin-top:8px; }
  .header img { max-height:80px; margin-bottom:16px; }
  .content { flex:1; display:flex; align-items:center; justify-content:center; padding:20px 60px; }
  .button-grid { display:grid; grid-template-columns:repeat(${safeNumber(style.columns, 3)}, 1fr); gap:${safeNumber(style.gap, 24)}px; width:100%; max-width:1200px; }
  .kiosk-btn {
    background:${safeColor(style.buttonBg, '#1e293b')}; border:2px solid ${safeColor(style.buttonBorder, '#334155')};
    border-radius:${safeNumber(style.buttonRadius, 16)}px; padding:${safeNumber(style.buttonPadding, 32)}px;
    text-align:center; cursor:pointer; transition:all 0.2s ease; touch-action:manipulation;
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px;
  }
  .kiosk-btn:hover, .kiosk-btn:active { background:${safeColor(style.buttonHover, '#3b82f6')}; border-color:${safeColor(style.buttonHover, '#3b82f6')}; transform:scale(1.02); }
  .kiosk-btn .icon { font-size:${safeNumber(style.iconSize, 48)}px; }
  .kiosk-btn .label { font-size:${safeNumber(style.labelSize, 20)}px; font-weight:600; }
  .kiosk-btn .sublabel { font-size:${safeNumber(style.sublabelSize, 14)}px; opacity:0.6; }
  .footer { padding:20px 60px; text-align:center; font-size:14px; opacity:0.4; }
  .idle-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.95); display:none; flex-direction:column;
    align-items:center; justify-content:center; z-index:100; cursor:pointer; }
  .idle-overlay h2 { font-size:48px; margin-bottom:16px; }
  .idle-overlay p { font-size:20px; opacity:0.6; }
</style>
</head>
<body>
  <div class="header">
    ${config.logoUrl ? `<img src="${escapeHtml(config.logoUrl)}" alt="Logo">` : ''}
    <h1>${escapeHtml(config.title) || 'Welcome'}</h1>
    ${config.subtitle ? `<p>${escapeHtml(config.subtitle)}</p>` : ''}
  </div>
  <div class="content">
    <div class="button-grid">
      ${buttons.map(btn => `
        <div class="kiosk-btn" data-action="${escapeHtml(btn.action) || ''}" data-url="${escapeHtml(btn.url) || ''}" data-page="${escapeHtml(btn.page) || ''}">
          ${btn.icon ? `<div class="icon">${escapeHtml(btn.icon)}</div>` : ''}
          <div class="label">${escapeHtml(btn.label) || 'Button'}</div>
          ${btn.sublabel ? `<div class="sublabel">${escapeHtml(btn.sublabel)}</div>` : ''}
        </div>
      `).join('')}
    </div>
  </div>
  <div class="footer">${escapeHtml(config.footer) || ''}</div>

  <!-- Idle screen (shows after inactivity) -->
  <div class="idle-overlay" id="idleOverlay">
    <h2>${escapeHtml(config.idleTitle) || 'Touch to Begin'}</h2>
    <p>${escapeHtml(config.idleSubtitle) || ''}</p>
  </div>

  <script>
    // Button actions
    document.querySelectorAll('.kiosk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        resetIdleTimer();
        const action = btn.dataset.action;
        const url = btn.dataset.url;
        const page = btn.dataset.page;
        if (action === 'url' && url) window.open(url, '_blank');
        else if (action === 'page' && page) window.location.href = page;
        else if (action === 'back') window.history.back();
        // Visual feedback
        btn.style.transform = 'scale(0.95)';
        setTimeout(() => btn.style.transform = '', 200);

        // Report touch to server
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'kiosk-tap', label: btn.querySelector('.label')?.textContent }, '*');
        }
      });
    });

    // Idle screen after ${config.idleTimeout || 60} seconds of no interaction
    let idleTimer;
    function resetIdleTimer() {
      document.getElementById('idleOverlay').style.display = 'none';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        document.getElementById('idleOverlay').style.display = 'flex';
      }, ${(config.idleTimeout || 60) * 1000});
    }
    document.getElementById('idleOverlay').addEventListener('click', resetIdleTimer);
    ['touchstart', 'click', 'mousemove'].forEach(e => document.addEventListener(e, resetIdleTimer));
    resetIdleTimer();

    // Clock update if element exists
    const clockEl = document.getElementById('clock');
    if (clockEl) setInterval(() => { clockEl.textContent = new Date().toLocaleTimeString(); }, 1000);
  </script>
</body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Create kiosk page
router.post('/', (req, res) => {
  const { name, config: pageConfig } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const id = uuidv4();
  db.prepare('INSERT INTO kiosk_pages (id, user_id, name, config) VALUES (?, ?, ?, ?)')
    .run(id, req.user.id, name, JSON.stringify(pageConfig || getDefaultKioskConfig()));

  res.status(201).json(db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(id));
});

// Update kiosk page
router.put('/:id', (req, res) => {
  const page = checkKioskAccess(req, res);
  if (!page) return;

  const { name, config: pageConfig } = req.body;
  if (name) db.prepare('UPDATE kiosk_pages SET name = ? WHERE id = ?').run(name, req.params.id);
  if (pageConfig) db.prepare('UPDATE kiosk_pages SET config = ?, updated_at = strftime(\'%s\',\'now\') WHERE id = ?')
    .run(JSON.stringify(pageConfig), req.params.id);

  res.json(db.prepare('SELECT * FROM kiosk_pages WHERE id = ?').get(req.params.id));
});

// Delete kiosk page
router.delete('/:id', (req, res) => {
  const page = checkKioskAccess(req, res);
  if (!page) return;
  db.prepare('DELETE FROM kiosk_pages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

function getDefaultKioskConfig() {
  return {
    title: 'Welcome',
    subtitle: 'How can we help you today?',
    footer: '',
    logoUrl: '',
    idleTitle: 'Touch to Begin',
    idleSubtitle: '',
    idleTimeout: 60,
    buttons: [
      { label: 'Directory', sublabel: 'Find a location', icon: '&#128205;', action: 'page', page: '' },
      { label: 'Events', sublabel: 'See what\'s happening', icon: '&#128197;', action: 'page', page: '' },
      { label: 'Map', sublabel: 'Building map', icon: '&#128506;', action: 'page', page: '' },
      { label: 'Contact', sublabel: 'Get in touch', icon: '&#128222;', action: 'page', page: '' },
      { label: 'WiFi', sublabel: 'Connect to WiFi', icon: '&#128246;', action: 'page', page: '' },
      { label: 'Help', sublabel: 'Need assistance?', icon: '&#10068;', action: 'page', page: '' },
    ],
    style: {
      background: 'linear-gradient(135deg, #0c0c0c 0%, #1a1a2e 50%, #16213e 100%)',
      textColor: '#f1f5f9',
      columns: 3,
      buttonBg: '#1e293b',
      buttonBorder: '#334155',
      buttonHover: '#3b82f6',
      buttonRadius: 16,
      buttonPadding: 32,
      gap: 24,
      titleSize: 48,
      iconSize: 48,
      labelSize: 20,
    }
  };
}

module.exports = router;
