'use strict';

// RSS/Atom headline ticker -> ScreenTinker PiP. Polls a feed, extracts headlines,
// and pushes a persistent scrolling strip overlay to a device/group. Refreshes the
// strip on each poll (player single-slot, last-show-wins) and clears on exit.
//
//   node news.js [path/to/config.json]
//
// Node 18+ (global fetch). Needs an st_ API token with the 'full' scope.
// Zero dependencies — the feed parser is hand-rolled and tolerant of RSS and Atom.

const fs = require('fs');
const path = require('path');

// ---- pure helpers (exported for the offline test) -------------------------

// Decode CDATA sections and the handful of XML entities feeds actually use.
function decodeText(s) {
  if (s == null) return '';
  let t = String(s);
  // pull CDATA payloads out verbatim
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // strip any stray tags (some feeds put markup in titles)
  t = t.replace(/<[^>]+>/g, '');
  // named + numeric entities
  t = t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // ampersand last, so &amp;lt; -> &lt; not <
  return t.replace(/\s+/g, ' ').trim();
}

// Grab the first <title>…</title> inside a block (RSS item / Atom entry).
function firstTitle(block) {
  const m = block.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeText(m[1]) : '';
}

// Tolerant headline extraction. Handles RSS (<item>) and Atom (<entry>); falls back
// gracefully if a feed is malformed. Returns up to maxItems non-empty titles in order.
function parseHeadlines(xml, maxItems = 12) {
  const text = String(xml || '');
  let blocks = text.match(/<item\b[\s\S]*?<\/item>/gi);
  if (!blocks || blocks.length === 0) blocks = text.match(/<entry\b[\s\S]*?<\/entry>/gi);
  const out = [];
  for (const b of blocks || []) {
    const title = firstTitle(b);
    if (title) out.push(title);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Feed channel/source title, used as the left-hand chip label when present.
function feedLabel(xml) {
  const text = String(xml || '');
  // RSS: channel > title (the first <title> before any <item>)
  const beforeItem = text.split(/<item\b/i)[0];
  const ch = beforeItem.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (ch) return decodeText(ch[1]);
  return '';
}

function buildOverlayUri(base, { text, label, sep }) {
  const q = new URLSearchParams({ text: text || '', label: label || '', sep: sep || ' • ' });
  return `${base}${base.includes('?') ? '&' : '?'}${q.toString()}`;
}

// ---- live runner ----------------------------------------------------------

function loadConfig() {
  const configPath = process.argv[2] || path.join(__dirname, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { console.error(`Could not read config at ${configPath}: ${e.message}`); process.exit(1); }
  if (!cfg.api_base || !cfg.api_token || !cfg.overlay_base_url || !cfg.device_id || !cfg.feed_url) {
    console.error('config must set api_base, api_token, overlay_base_url, device_id, and feed_url.');
    process.exit(1);
  }
  return cfg;
}

async function pipShow(cfg, uri) {
  const base = cfg.api_base.replace(/\/$/, '');
  const body = {
    device_id: cfg.device_id,
    type: 'web',
    uri,
    position: cfg.position || 'bottom-right',
    width: cfg.width || 1200,
    height: cfg.height || 90,
    duration: 0,                  // persistent until we clear it
    border_radius: cfg.border_radius != null ? cfg.border_radius : 12,
    opacity: cfg.opacity != null ? cfg.opacity : 1,
  };
  const res = await fetch(`${base}/api/pip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.pip_id) throw new Error(`pip show failed (${res.status}): ${json.error || 'unknown'}`);
  return json.pip_id;
}

async function pipClear(cfg, pipId) {
  const base = cfg.api_base.replace(/\/$/, '');
  await fetch(`${base}/api/pip/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_token}` },
    body: JSON.stringify({ device_id: cfg.device_id, pip_id: pipId }),
  }).catch(() => {});
}

async function main() {
  const cfg = loadConfig();
  const maxItems = cfg.max_items || 12;
  const sep = cfg.separator || ' • ';
  const pollSec = cfg.poll_interval_sec || 300;
  let currentPip = null;

  console.log(`News ticker starting — feed=${cfg.feed_url}`);
  console.log(`  poll: every ${pollSec}s   max headlines: ${maxItems}   target: ${cfg.device_id}`);

  async function tick() {
    let xml;
    try {
      const res = await fetch(cfg.feed_url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
      if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
      xml = await res.text();
    } catch (e) {
      console.error(`[${new Date().toISOString()}] feed fetch error: ${e.message}`);
      return;
    }
    const headlines = parseHeadlines(xml, maxItems);
    if (headlines.length === 0) { console.error(`[${new Date().toISOString()}] no headlines parsed`); return; }
    const label = cfg.label || feedLabel(xml) || 'NEWS';
    const text = headlines.join(sep);
    const uri = buildOverlayUri(cfg.overlay_base_url, { text, label, sep });
    try {
      currentPip = await pipShow(cfg, uri);
      console.log(`[${new Date().toISOString()}] SHOW ${headlines.length} headline(s) pip=${currentPip}`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] show error: ${e.message}`);
    }
  }

  await tick();
  const timer = setInterval(tick, pollSec * 1000);

  async function shutdown() {
    clearInterval(timer);
    if (currentPip) { console.log('\nclearing ticker before exit...'); await pipClear(cfg, currentPip); }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { decodeText, firstTitle, parseHeadlines, feedLabel, buildOverlayUri };
