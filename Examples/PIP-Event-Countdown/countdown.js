'use strict';

// Countdown -> ScreenTinker PiP. Pushes ONE live countdown overlay to a device or
// group and lets the player auto-clear it the instant the target time arrives, using
// the PiP `duration` field (duration = seconds-to-target, so no clear poll is needed).
//
//   node countdown.js [path/to/config.json]
//   node countdown.js "2026-12-31T23:59:59-06:00" "Happy New Year"   # CLI override
//   node countdown.js [config] --clear                               # clear it early
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

const PIP_DUR_MAX = 86400;   // PiP API duration cap (seconds)

// --- pure, testable helpers (no I/O, explicit `now` so tests are deterministic) ---

// Whole seconds from `now` until `target` (both epoch ms), rounded UP so the last
// partial second still counts. <= 0 means the moment has already passed.
function secondsToTarget(target, now) {
  return Math.ceil((target - now) / 1000);
}

// Split a non-negative second count into d/h/m/s. Negative clamps to zero.
function breakdown(seconds) {
  let s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400); s -= days * 86400;
  const hours = Math.floor(s / 3600); s -= hours * 3600;
  const minutes = Math.floor(s / 60); s -= minutes * 60;
  return { days, hours, minutes, seconds: s };
}

// PiP duration to request: seconds-to-target, but never above the API cap. For targets
// more than 24h out the overlay won't auto-clear at zero (it'd hit the cap first); the
// CLI warns in that case. 0 would mean "until cleared", which we never want here.
function durationForTarget(seconds) {
  return Math.max(1, Math.min(seconds, PIP_DUR_MAX));
}

module.exports = { secondsToTarget, breakdown, durationForTarget, PIP_DUR_MAX };

// --- CLI ---

if (require.main === module) main();

function main() {
  const args = process.argv.slice(2);
  const clear = args.includes('--clear');
  const positional = args.filter(a => !a.startsWith('--'));

  // First positional that isn't an ISO date is treated as the config path.
  let cfgPath = path.join(__dirname, 'config.json');
  let cliTarget = null, cliTitle = null;
  if (positional.length && Number.isFinite(Date.parse(positional[0]))) {
    cliTarget = positional[0];
    cliTitle = positional[1] || null;
  } else if (positional.length) {
    cfgPath = positional[0];
    if (positional[1] && Number.isFinite(Date.parse(positional[1]))) {
      cliTarget = positional[1];
      cliTitle = positional[2] || null;
    }
  }

  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) {
    if (!cliTarget) { console.error(`Could not read config at ${cfgPath}: ${e.message}`); process.exit(1); }
  }

  const apiBase = (cfg.api_base || '').replace(/\/$/, '');
  const apiToken = cfg.api_token;
  const overlayBase = cfg.overlay_base_url;
  const deviceId = cfg.device_id;
  const targetIso = cliTarget || cfg.target;
  const title = cliTitle || cfg.title || 'Countdown';
  const position = cfg.position || 'center';

  if (!apiBase || !apiToken || !deviceId) {
    console.error('config must set api_base, api_token, and device_id.');
    process.exit(1);
  }

  if (clear) { return doClear(apiBase, apiToken, deviceId); }

  if (!overlayBase) { console.error('config must set overlay_base_url for a countdown overlay.'); process.exit(1); }
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) { console.error(`invalid target datetime: ${targetIso}`); process.exit(1); }

  const now = Date.now();
  const secs = secondsToTarget(targetMs, now);
  if (secs <= 0) {
    console.log(`"${title}" target ${targetIso} has already passed — nothing to show.`);
    process.exit(0);
  }
  if (secs > PIP_DUR_MAX) {
    const b = breakdown(secs);
    console.warn(`note: target is ${b.days}d ${b.hours}h away (> 24h). The overlay will show but auto-clear caps at 24h; re-run within 24h of the target for the self-clear-at-zero effect.`);
  }

  showCountdown({ apiBase, apiToken, deviceId, overlayBase, targetMs, title, position, secs });
}

function overlayUri(overlayBase, targetMs, title) {
  const q = new URLSearchParams({ target: String(targetMs), title: title || '' });
  return `${overlayBase}${overlayBase.includes('?') ? '&' : '?'}${q.toString()}`;
}

async function showCountdown({ apiBase, apiToken, deviceId, overlayBase, targetMs, title, position, secs }) {
  const duration = durationForTarget(secs);
  const body = {
    device_id: deviceId,
    type: 'web',
    uri: overlayUri(overlayBase, targetMs, title),
    position,
    width: 820,
    height: 300,
    duration,
    border_radius: 16,
    close_button: false,
    title,
  };
  try {
    const res = await fetch(`${apiBase}/api/pip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.pip_id) throw new Error(`(${res.status}) ${json.error || 'unknown error'}`);
    const b = breakdown(secs);
    console.log(`SHOW "${title}" pip=${json.pip_id} target=${new Date(targetMs).toISOString()}`);
    console.log(`auto-clears in ${secs}s (${b.days}d ${b.hours}h ${b.minutes}m ${b.seconds}s) — player drops it at zero, no clear call needed.`);
  } catch (e) {
    console.error(`pip show failed: ${e.message}`);
    process.exit(1);
  }
}

async function doClear(apiBase, apiToken, deviceId) {
  try {
    const res = await fetch(`${apiBase}/api/pip/clear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ device_id: deviceId }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`(${res.status}) ${json.error || 'unknown error'}`);
    console.log(`CLEAR sent to ${deviceId} (sent=${json.sent ?? '?'} offline=${json.offline ?? '?'})`);
  } catch (e) {
    console.error(`pip clear failed: ${e.message}`);
    process.exit(1);
  }
}
