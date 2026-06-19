'use strict';

// PIP-Announce-Broadcast — flash a one-off announcement onto a ScreenTinker screen
// or group via the PiP overlay API, then clear it on demand.
//
//   node announce.js "Fire drill at 2:00 PM" [--title "NOTICE"]
//        [--device <id> | --group <id>] [--duration 60] [--color "#CC0000"]
//        [--position center] [--config config.json]
//   node announce.js --clear [--device <id>] [--pip <pip_id>]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

const POSITIONS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];

// --- pure helpers (exported for the offline test) -------------------------

// Sanitise a colour to exactly 6 hex digits (no '#'); fall back to CC0000.
function sanitizeColor(c) {
  const hex = String(c || '').replace(/[^0-9a-fA-F]/g, '');
  return hex.length === 6 ? hex : 'CC0000';
}

// Build the overlay iframe URL: overlay_base_url + ?title&message&color.
// Color is sanitised to 6 hex; everything is URL-encoded by URLSearchParams.
function buildOverlayUri(base, { title = '', message = '', color = '' } = {}) {
  const q = new URLSearchParams({
    title: title || '',
    message: message || '',
    color: sanitizeColor(color),
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

// Minimal flag parser. First non-flag positional is the message.
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clear') out.clear = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

// --- runtime --------------------------------------------------------------

function loadConfig(p) {
  const configPath = p || path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Could not read config at ${configPath}: ${e.message}`);
    console.error('Copy config.example.json to config.json and fill it in.');
    process.exit(1);
  }
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);

  const apiBase = String(cfg.api_base || '').replace(/\/$/, '');
  const token = cfg.api_token;
  const target = args.device || args.group || cfg.device_id;

  if (!apiBase || !token) { console.error('config must set api_base and api_token.'); process.exit(1); }
  if (!target) { console.error('no target: pass --device/--group or set device_id in config.'); process.exit(1); }

  if (args.clear) {
    const body = { device_id: target };
    if (args.pip && args.pip !== true) body.pip_id = args.pip;
    const { ok, status, json } = await postJson(`${apiBase}/api/pip/clear`, token, body);
    if (!ok) { console.error(`clear failed (${status}): ${json.error || 'unknown'}`); process.exit(1); }
    console.log(`cleared on ${target} — sent=${json.sent} offline=${json.offline}`);
    return;
  }

  const message = args._[0];
  if (!message) {
    console.error('usage: node announce.js "your message" [--title T] [--device ID|--group ID] [--duration N] [--color #RRGGBB] [--position P]');
    process.exit(1);
  }

  const ov = cfg.overlay || {};
  const position = args.position || ov.position || 'center';
  if (!POSITIONS.includes(position)) { console.error(`invalid --position; use one of: ${POSITIONS.join(', ')}`); process.exit(1); }

  const color = args.color || ov.color || '#CC0000';
  const duration = args.duration != null ? Math.max(0, parseInt(args.duration, 10) || 0) : (ov.duration != null ? ov.duration : 0);
  const overlayBase = cfg.overlay_base_url;
  if (!overlayBase) { console.error('config must set overlay_base_url.'); process.exit(1); }

  const uri = buildOverlayUri(overlayBase, {
    title: (args.title && args.title !== true) ? args.title : (cfg.default_title || ''),
    message,
    color,
  });

  const body = {
    device_id: target,
    type: 'web',
    uri,
    position,
    width: ov.width || 900,
    height: ov.height || 300,
    duration,
    border_radius: ov.border_radius != null ? ov.border_radius : 16,
    opacity: ov.opacity != null ? ov.opacity : 1,
    close_button: false,
    title: (args.title && args.title !== true) ? args.title : undefined,
  };

  const { ok, status, json } = await postJson(`${apiBase}/api/pip`, token, body);
  if (!ok || !json.pip_id) { console.error(`show failed (${status}): ${json.error || 'unknown'}`); process.exit(1); }
  console.log(`shown on ${target} (${json.target}) pip=${json.pip_id} dur=${duration || '∞'}s sent=${json.sent} offline=${json.offline}`);
  console.log(`clear it with:  node announce.js --clear --device ${target} --pip ${json.pip_id}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { buildOverlayUri, sanitizeColor, parseArgs, POSITIONS };
