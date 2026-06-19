'use strict';

// QR Rotator -> ScreenTinker PiP. Cycles through a list of {label, data} entries,
// pushing each as a PiP web overlay that renders the QR code CLIENT-SIDE (the encoder
// lives in qr-overlay.js — no network, no external libraries, CSP-safe). Every
// `rotate_interval_sec` it shows the next entry; the player keeps a single overlay slot
// (last-show-wins) so each push replaces the previous one. Cleared on exit.
//
//   node qr.js [path/to/config.json]
//   node qr.js [config] --clear        # remove the overlay and exit
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.
//
// Good for: guest Wi-Fi join, lunch menu, feedback survey, ticket/checkout links,
// "scan to download the app", event schedule — anything a phone camera should grab.

const fs = require('fs');
const path = require('path');

// --- pure, testable helpers (no I/O) ---

// Keep only well-formed entries: `data` is required (the QR payload); `label` is
// optional caption text. Returns { entries, errors } so the caller can warn and proceed.
function validateEntries(raw) {
  const entries = [];
  const errors = [];
  if (!Array.isArray(raw)) return { entries, errors: ['"entries" must be an array'] };
  raw.forEach((e, i) => {
    if (!e || typeof e !== 'object') { errors.push(`entry ${i}: not an object`); return; }
    const data = typeof e.data === 'string' ? e.data.trim() : '';
    if (!data) { errors.push(`entry ${i}: missing "data"`); return; }
    entries.push({ label: typeof e.label === 'string' ? e.label : '', data });
  });
  return { entries, errors };
}

// Build the overlay URL with the QR payload + caption in the query string.
function overlayUri(overlayBase, entry) {
  const q = new URLSearchParams({ data: entry.data || '', label: entry.label || '' });
  return `${overlayBase}${overlayBase.includes('?') ? '&' : '?'}${q.toString()}`;
}

// Advance the rotation index, wrapping around the list.
function nextIndex(i, len) {
  if (!len || len < 1) return 0;
  return (i + 1) % len;
}

module.exports = { validateEntries, overlayUri, nextIndex };

// --- CLI ---

if (require.main === module) main();

function main() {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  const positional = args.filter(a => !a.startsWith('--'));
  const cfgPath = positional[0] || path.join(__dirname, 'config.json');

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${cfgPath}: ${e.message}`); process.exit(1); }

  const apiBase = (cfg.api_base || '').replace(/\/$/, '');
  const apiToken = cfg.api_token;
  const overlayBase = cfg.overlay_base_url;
  const deviceId = cfg.device_id;

  if (!apiBase || !apiToken || !deviceId) {
    console.error('config must set api_base, api_token, and device_id.');
    process.exit(1);
  }
  if (clear) return doClear(apiBase, apiToken, deviceId);

  if (!overlayBase) { console.error('config must set overlay_base_url (where qr-overlay.html is served).'); process.exit(1); }

  const { entries, errors } = validateEntries(cfg.entries);
  for (const err of errors) console.warn(`skipping ${err}`);
  if (entries.length === 0) { console.error('config.entries has no valid entries (each needs a "data" string).'); process.exit(1); }

  const intervalSec = cfg.rotate_interval_sec || 15;
  const position = cfg.position || 'bottom-right';
  const width = cfg.width || 360;
  const height = cfg.height || 420;
  const opacity = cfg.opacity != null ? cfg.opacity : 1;
  const borderRadius = cfg.border_radius != null ? cfg.border_radius : 16;

  console.log(`QR rotator starting — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, every ${intervalSec}s, position ${position}`);
  entries.forEach((e, i) => console.log(`  ${i + 1}. ${e.label || '(no label)'} -> ${e.data.slice(0, 60)}${e.data.length > 60 ? '…' : ''}`));

  const opts = { apiBase, apiToken, deviceId, overlayBase, position, width, height, opacity, borderRadius };
  let idx = 0;
  let lastPip = null;

  async function show() {
    const entry = entries[idx];
    try {
      lastPip = await pipShow(opts, entry);
      console.log(`[${new Date().toISOString()}] SHOW ${idx + 1}/${entries.length} "${entry.label || '(no label)'}" pip=${lastPip}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] show error: ${e.message}`);
    }
    idx = nextIndex(idx, entries.length);
  }

  show();
  const timer = entries.length > 1 ? setInterval(show, intervalSec * 1000) : null;

  async function shutdown() {
    if (timer) clearInterval(timer);
    console.log('\nclearing overlay before exit...');
    try { await doClear(apiBase, apiToken, deviceId, true); } catch { /* best effort */ }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function pipShow(opts, entry) {
  const body = {
    device_id: opts.deviceId,
    type: 'web',
    uri: overlayUri(opts.overlayBase, entry),
    position: opts.position,
    width: opts.width,
    height: opts.height,
    duration: 0,                 // persistent; we replace/clear it ourselves
    opacity: opts.opacity,
    border_radius: opts.borderRadius,
    close_button: false,
    title: (entry.label || '').slice(0, 200),
  };
  const res = await fetch(`${opts.apiBase}/api/pip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.pip_id) throw new Error(`(${res.status}) ${json.error || 'unknown error'}`);
  return json.pip_id;
}

async function doClear(apiBase, apiToken, deviceId, quiet) {
  const res = await fetch(`${apiBase}/api/pip/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({ device_id: deviceId }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`(${res.status}) ${json.error || 'unknown error'}`);
  if (!quiet) console.log(`CLEAR sent to ${deviceId} (sent=${json.sent ?? '?'} offline=${json.offline ?? '?'})`);
}
