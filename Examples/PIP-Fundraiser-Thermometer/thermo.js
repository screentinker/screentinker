'use strict';

// Fundraiser "thermometer" -> ScreenTinker PiP overlay.
//
// Reads a tiny JSON progress doc ({ campaign, raised, goal, currency }) from a local
// file or a URL, computes the percentage, and pushes a persistent web overlay showing
// a filling thermometer bar. Re-pushes each poll so the bar updates in place (the player
// keeps a single overlay slot, last-show-wins). Clears the overlay on exit.
//
//   node thermo.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.

const fs = require('fs');
const path = require('path');

// Currency symbols we render inline; anything else falls back to "CODE 1,234".
const CURRENCY_SYMBOLS = { USD: '$', CAD: '$', AUD: '$', NZD: '$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' };

// Group an integer with thousands separators without locale surprises.
function groupThousands(n) {
  const neg = n < 0;
  const digits = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return (neg ? '-' : '') + out;
}

// "$12,450" / "€12,450" / "BTC 12,450" (whole units; cents are noise on a wall display).
function formatMoney(amount, currency) {
  const code = String(currency || 'USD').toUpperCase();
  const sym = CURRENCY_SYMBOLS[code];
  const num = groupThousands(Number(amount) || 0);
  return sym ? `${sym}${num}` : `${code} ${num}`;
}

// pct is raised/goal clamped to 0..100; pctLabel is the rounded whole-percent string.
// Divide-by-zero-safe: goal <= 0 yields 0%.
function computeProgress({ raised, goal }) {
  const r = Number(raised) || 0;
  const g = Number(goal) || 0;
  let pct = 0;
  if (g > 0) pct = (r / g) * 100;
  pct = Math.max(0, Math.min(100, pct));
  pct = Math.round(pct * 100) / 100;       // keep 2dp for a smooth bar fill
  return { pct, pctLabel: `${Math.round(pct)}%` };
}

// Raw progress doc -> the fields the overlay displays.
function normalise(data, fallbackCurrency) {
  const currency = data.currency || fallbackCurrency || 'USD';
  const { pct, pctLabel } = computeProgress(data);
  return {
    campaign: data.campaign || 'Fundraiser',
    raisedLabel: formatMoney(data.raised, currency),
    goalLabel: formatMoney(data.goal, currency),
    currency,
    pct,
    pctLabel,
  };
}

function overlayUri(base, view) {
  const q = new URLSearchParams({
    campaign: view.campaign,
    raised: view.raisedLabel,
    goal: view.goalLabel,
    pct: String(view.pct),
    pctLabel: view.pctLabel,
    currency: view.currency,
  });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

module.exports = { groupThousands, formatMoney, computeProgress, normalise, overlayUri };

// ---- runtime (skipped when imported by the test) ----
if (require.main === module) {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }

  const API_BASE = (cfg.api_base || '').replace(/\/$/, '');
  const API_TOKEN = cfg.api_token;
  const OVERLAY_BASE = cfg.overlay_base_url;
  const DEVICE = cfg.device_id;
  const POLL_SEC = cfg.poll_interval_sec || 60;
  const POSITION = cfg.position || 'bottom-left';
  const WIDTH = cfg.width || 460;
  const HEIGHT = cfg.height || 360;

  if (!API_BASE || !API_TOKEN || !OVERLAY_BASE || !DEVICE) {
    console.error('config must set api_base, api_token, overlay_base_url, and device_id.');
    process.exit(1);
  }
  if (!cfg.source_file && !cfg.source_url) {
    console.error('config must set source_file or source_url.');
    process.exit(1);
  }

  let activePip = null;

  async function readProgress() {
    if (cfg.source_url) {
      const res = await fetch(cfg.source_url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`source HTTP ${res.status}`);
      return await res.json();
    }
    const p = path.isAbsolute(cfg.source_file) ? cfg.source_file : path.join(__dirname, cfg.source_file);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  async function pipShow(view) {
    const body = {
      device_id: DEVICE, type: 'web', uri: overlayUri(OVERLAY_BASE, view),
      position: POSITION, width: WIDTH, height: HEIGHT,
      duration: 0, border_radius: 16, close_button: false,
      title: view.campaign,
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

  async function pipClear() {
    if (!activePip) return;
    try {
      await fetch(`${API_BASE}/api/pip/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ device_id: DEVICE, pip_id: activePip }),
      });
    } catch { /* best effort */ }
    activePip = null;
  }

  async function tick() {
    try {
      const view = normalise(await readProgress(), cfg.currency);
      activePip = await pipShow(view);
      console.log(`[${new Date().toISOString()}] SHOW "${view.campaign}" ${view.raisedLabel} of ${view.goalLabel} (${view.pctLabel}) pip=${activePip}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] ${e.message}`);
    }
  }

  async function main() {
    console.log(`Fundraiser thermometer starting — poll every ${POLL_SEC}s, source=${cfg.source_url || cfg.source_file}`);
    await tick();
    const timer = setInterval(tick, POLL_SEC * 1000);
    async function shutdown() {
      clearInterval(timer);
      console.log('\nclearing overlay before exit...');
      await pipClear();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  main();
}
