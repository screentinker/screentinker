'use strict';

// Event-driven PiP: an inbound webhook receiver. Instead of polling a feed, it waits for
// your monitoring stack to PUSH it incidents, then shows / clears a ScreenTinker PiP overlay
// in real time:
//   - status "firing"   -> POST /api/pip   (red overlay, kept until cleared)
//   - status "resolved" -> POST /api/pip/clear
//
// Accepts two payload shapes on POST /webhook:
//   (a) generic     { status:"firing"|"resolved", key, title, detail, severity }
//   (b) Alertmanager{ status, alerts:[{ status, labels:{alertname,severity,...},
//                                        annotations:{summary,description}, fingerprint }] }
//
//   node server.js [path/to/config.json]
//
// Node 18+ (built-in http + global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');
const http = require('http');

// --- pure logic (unit-tested in test.js; no network) -------------------------------------

// severity -> overlay band colour (#RRGGBB, the PiP colour contract).
const SEV_COLORS = { critical: '7B0000', warning: 'E8730C', info: 'F2C200' };
const DEFAULT_COLOR = 'CC0000';

function colorFor(severity) {
  return SEV_COLORS[String(severity || '').toLowerCase()] || DEFAULT_COLOR;
}

// Map "firing"/"resolved" (and Alertmanager's per-alert status) to our two states.
function stateOf(status) {
  return String(status || '').toLowerCase() === 'resolved' ? 'resolved' : 'firing';
}

// Normalise either payload shape into a flat list of incidents:
//   { key, state:"firing"|"resolved", title, detail, severity }
// `key` is the stable identity used to match a later resolve to its overlay.
function normalise(payload) {
  const p = payload || {};
  const out = [];

  if (Array.isArray(p.alerts)) {
    // Alertmanager group webhook. Each alert may carry its own status; fall back to the
    // group status. fingerprint is Alertmanager's stable per-alert id.
    for (const a of p.alerts) {
      const labels = a.labels || {};
      const ann = a.annotations || {};
      const name = labels.alertname || ann.summary || 'alert';
      out.push({
        key: a.fingerprint || `${name}:${JSON.stringify(labels.instance || labels.job || '')}`,
        state: stateOf(a.status || p.status),
        title: ann.summary || name,
        detail: ann.description || '',
        severity: (labels.severity || 'warning').toLowerCase(),
      });
    }
    return out;
  }

  // Generic single-incident shape.
  const name = p.title || p.key || 'incident';
  out.push({
    key: p.key || name,
    state: stateOf(p.status),
    title: p.title || name,
    detail: p.detail || '',
    severity: (p.severity || 'warning').toLowerCase(),
  });
  return out;
}

// Build the overlay iframe URL from an incident.
function overlayUri(base, inc, sourceLabel, nowIso) {
  const q = new URLSearchParams({
    level: 'incident',
    title: inc.title || '',
    detail: inc.detail || '',
    severity: inc.severity || '',
    color: colorFor(inc.severity),
    source: sourceLabel || '',
    updated: nowIso || '',
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

module.exports = { colorFor, stateOf, normalise, overlayUri, SEV_COLORS, DEFAULT_COLOR };

// --- server (only when run directly) -----------------------------------------------------

if (require.main === module) {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const PORT = cfg.listen_port || 8088;
  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE = cfg.device_id;
  const POSITION = cfg.position || 'top-right';
  const SOURCE_LABEL = cfg.source_label || 'Monitoring';
  const SECRET = cfg.shared_secret || null;
  const OVERLAY = cfg.overlay || {};

  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE) {
    console.error('config must set api_base, api_token, overlay_base_url, and device_id.');
    process.exit(1);
  }

  // key -> pip_id of the overlay currently showing for that incident.
  const active = new Map();
  const nowIso = () => new Date().toISOString();

  async function pipShow(inc) {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri(OVERLAY_BASE, inc, SOURCE_LABEL, nowIso()),
      position: POSITION,
      width: OVERLAY.width || 760, height: OVERLAY.height || 280,
      duration: 0, // keep until we clear it on resolve
      opacity: OVERLAY.opacity != null ? OVERLAY.opacity : 1,
      border_radius: OVERLAY.border_radius != null ? OVERLAY.border_radius : 16,
      close_button: false,
      title: inc.title,
    };
    const res = await fetch(`${API_BASE}/api/pip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
    return json.pip_id;
  }

  async function pipClear(pipId) {
    const res = await fetch(`${API_BASE}/api/pip/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify({ device_id: DEVICE, pip_id: pipId }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(`pip clear failed (${res.status}): ${json.error || 'unknown'}`);
    }
  }

  async function handleIncidents(incidents) {
    const summary = { fired: 0, cleared: 0, skipped: 0 };
    for (const inc of incidents) {
      if (!inc.key) { summary.skipped++; continue; }
      try {
        if (inc.state === 'firing') {
          if (active.has(inc.key)) {            // refresh: clear the old card, show the new
            try { await pipClear(active.get(inc.key)); } catch { /* best effort */ }
          }
          const pipId = await pipShow(inc);
          active.set(inc.key, pipId);
          summary.fired++;
          console.log(`[${nowIso()}] FIRING "${inc.title}" (${inc.severity}) key=${inc.key} pip=${pipId}`);
        } else {
          const pipId = active.get(inc.key);
          if (pipId) {
            await pipClear(pipId);
            active.delete(inc.key);
            summary.cleared++;
            console.log(`[${nowIso()}] RESOLVED key=${inc.key} pip=${pipId} (cleared)`);
          } else {
            summary.skipped++;
            console.log(`[${nowIso()}] RESOLVED key=${inc.key} (nothing showing)`);
          }
        }
      } catch (e) {
        summary.skipped++;
        console.error(`[${nowIso()}] error for key=${inc.key}: ${e.message}`);
      }
    }
    return summary;
  }

  function authOk(req, url) {
    if (!SECRET) return true;
    const hdr = req.headers['x-webhook-secret'];
    const qs = url.searchParams.get('secret');
    return hdr === SECRET || qs === SECRET;
  }

  function readBody(req, cap = 1_000_000) {
    return new Promise((resolve, reject) => {
      let n = 0; const chunks = [];
      req.on('data', (c) => { n += c.length; if (n > cap) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(200, { ok: true, active: active.size });
    }
    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      return send(404, { error: 'POST /webhook or GET /healthz' });
    }
    if (!authOk(req, url)) return send(401, { error: 'bad or missing shared secret' });

    let payload;
    try { payload = JSON.parse(await readBody(req) || '{}'); }
    catch (e) { return send(400, { error: `invalid JSON: ${e.message}` }); }

    const incidents = normalise(payload);
    const summary = await handleIncidents(incidents);
    send(200, { ok: true, received: incidents.length, ...summary });
  });

  server.listen(PORT, () => {
    console.log(`Incident webhook receiver listening on :${PORT}`);
    console.log(`  POST /webhook   (generic or Alertmanager JSON)${SECRET ? '  [shared secret required]' : ''}`);
    console.log(`  GET  /healthz`);
    console.log(`  -> device ${DEVICE} @ ${API_BASE}, overlay ${OVERLAY_BASE}, position ${POSITION}`);
  });

  async function shutdown() {
    console.log('\nclearing active overlays before exit...');
    for (const pipId of active.values()) { try { await pipClear(pipId); } catch { /* best effort */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
