'use strict';

/*
 * The /download page: every player this INSTANCE can hand out, in one place.
 *
 * It exists because the guides used to send people to the GitHub releases page for the BrightSign
 * package and the webOS .ipk. That is wrong twice over. A self-hoster's operator has no reason to
 * have a GitHub account, and — the part that actually breaks — the BrightSign package has the
 * server URL stamped into it at build time, so a release asset points at screentinker.com and
 * provisions the player against the WRONG instance. The copy this route serves is built for the
 * host that served the page. Downloading from your own server is the only version that can be
 * right by construction.
 *
 * Split out of server.js and pure on purpose: `entries()` takes the artifact state as data and
 * returns rows, so every "is this offered, and what does it say when it is missing" rule is
 * testable without booting an app or touching a filesystem. That is the rule worth testing — an
 * entry offered with no file behind it sends an operator to a 404 and looks like a broken product.
 */

function formatSize(bytes) {
  if (!bytes || bytes < 0) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/*
 * One row per player. `state` is what the caches already know; nothing here stats a file.
 *
 * `available: false` is a first-class outcome, not an error. A deployment with no signed Tizen
 * .wgt is a perfectly normal deployment — it just cannot install on a retail Samsung panel — and
 * the row has to say so and give the operator the thing that does work instead. Hiding the row
 * would be worse: the reader concludes the platform is unsupported.
 */
function entries(state = {}) {
  const apk = state.apk || {};
  const ipk = state.ipk || {};
  const wgt = state.wgt || {};
  const brightsign = state.brightsign || {};

  return [
    {
      id: 'android',
      name: 'Android TV, Fire TV, Android tablets',
      file: 'ScreenTinker.apk',
      what: 'The native player. Sideload it, or install it from this URL on the device.',
      url: '/download/apk',
      guide: '/guides/digital-signage-android-tv.html',
      available: !!apk.exists,
      version: apk.version || null,
      size: formatSize(apk.size),
      absent: 'No APK is hosted on this instance. The web player works in the device browser meanwhile.',
      fallback: '/player',
    },
    {
      id: 'brightsign',
      name: 'BrightSign',
      file: 'autorun.zip',
      what: 'Host script, offline fallback and config in one archive. Drop it on the player’s storage root and power-cycle.',
      // Built per request with THIS server's URL already inside it, which is exactly why it is
      // not a release asset.
      url: '/download/autorun.zip',
      guide: '/guides/brightsign-digital-signage.html',
      available: !!brightsign.exists,
      version: brightsign.version || null,
      size: null,
      note: 'Built for this server — the address is already inside it, nothing to edit.',
      absent: 'This deployment does not ship the brightsign/ directory, so the package cannot be built here.',
      fallback: '/player',
    },
    {
      id: 'webos',
      name: 'LG webOS Signage',
      file: 'ScreenTinker.ipk',
      what: 'Installed from a USB stick or an SI server. Updates itself against this instance afterwards.',
      url: '/webos/ScreenTinker.ipk',
      guide: '/guides/lg-webos-digital-signage.html',
      available: !!ipk.exists,
      version: ipk.version || null,
      size: formatSize(ipk.size),
      absent: 'No .ipk is hosted on this instance. The panel’s own browser can run the web player.',
      fallback: '/player',
    },
    {
      id: 'tizen',
      name: 'Samsung Tizen Signage',
      file: 'ScreenTinker.wgt',
      what: 'Installed by the panel’s URL Launcher. Needs a Samsung partner-signed build to install on a retail panel.',
      url: '/tizen/ScreenTinker.wgt',
      guide: '/guides/samsung-tv-digital-signage.html',
      available: !!wgt.exists,
      version: wgt.version || null,
      size: formatSize(wgt.size),
      absent: 'No signed .wgt is hosted on this instance. Point the panel’s URL Launcher at the web player instead.',
      fallback: '/player',
    },
    {
      id: 'raspberry-pi',
      name: 'Raspberry Pi',
      file: 'raspberry-pi-setup.sh',
      what: 'Installs a kiosk browser, autostart and the player on Pi OS.',
      url: '/scripts/raspberry-pi-setup.sh',
      guide: '/guides/raspberry-pi-digital-signage.html',
      // Ships in the source tree, so it is present wherever the server is.
      available: true,
      version: null,
      size: null,
    },
    {
      id: 'windows',
      name: 'Windows',
      file: 'windows-setup.bat',
      what: 'Creates a kiosk-mode browser shortcut and starts the player at login.',
      url: '/scripts/windows-setup.bat',
      guide: '/guides/windows-digital-signage.html',
      available: true,
      version: null,
      size: null,
    },
    {
      id: 'web',
      name: 'Any browser, ChromeOS, smart TVs',
      file: null,
      what: 'No install. Open the player URL on the screen and claim the pairing code.',
      url: '/player',
      guide: '/guides/chromeos-digital-signage.html',
      available: true,
      version: null,
      size: null,
    },
    {
      id: 'vega',
      name: 'Fire TV Stick 4K Select / HD (Vega OS)',
      file: null,
      // Deliberately NOT offered as a download. It installs through Amazon's own developer
      // tooling, and the hardware is listed as not supported — an install button here would
      // read as a recommendation.
      what: 'Not a download. Built from source and installed with Amazon’s Vega tooling, and this hardware is not certified.',
      url: null,
      guide: '/guides/digital-signage-vega.html',
      available: false,
      version: null,
      size: null,
      absent: 'These two sticks are not Android and the APK does not install. Read the guide before buying one for a sign.',
    },
  ];
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rowHtml(e, base) {
  const meta = [e.version ? `v${e.version}` : null, e.size].filter(Boolean).join(' · ');
  const head = `<h2>${esc(e.name)}</h2>`
    + (meta ? `<span class="meta">${esc(meta)}</span>` : '');

  let action;
  if (e.available && e.url) {
    action = `<a class="btn" href="${esc(e.url)}">${e.file ? 'Download ' + esc(e.file) : 'Open the player'}</a>`;
  } else {
    action = `<p class="absent">${esc(e.absent || 'Not available on this instance.')}</p>`
      + (e.fallback ? `<a class="btn btn-quiet" href="${esc(e.fallback)}">Use the web player</a>` : '');
  }

  return `<section class="row" id="${esc(e.id)}">
  <div class="head">${head}</div>
  <p class="what">${esc(e.what)}</p>
  ${e.note && e.available ? `<p class="note">${esc(e.note)}</p>` : ''}
  <div class="actions">${action}
    <a class="link" href="${esc(e.guide)}">Setup guide &rarr;</a>
  </div>
</section>`;
}

/*
 * The page. `base` is this instance's own address, printed so an operator can copy it into a
 * player — the single thing every one of these installs asks for next, and the step people get
 * wrong when the page they are reading belongs to a different server than the one they run.
 */
function renderPage(state = {}, base = '') {
  const rows = entries(state).map((e) => rowHtml(e, base)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Download a ScreenTinker player</title>
<meta name="robots" content="noindex">
<style>
:root{--bg:#111827;--card:#1e293b;--border:#334155;--text:#f1f5f9;--muted:#94a3b8;--accent:#3b82f6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;line-height:1.6}
.wrap{max-width:820px;margin:0 auto;padding:48px 20px 80px}
h1{font-size:32px;margin:0 0 8px;letter-spacing:-.02em}
.lead{color:var(--muted);margin:0 0 24px}
.server{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:0 0 32px}
.server span{display:block;font-size:12px;color:var(--muted)}
.server code{font-size:15px;color:var(--accent);word-break:break-all;user-select:all}
.row{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin:0 0 14px}
.head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.row h2{font-size:18px;margin:0}
.meta{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.what{margin:6px 0 0;color:#cbd5e1;font-size:14px}
.note{margin:6px 0 0;color:var(--muted);font-size:13px}
.absent{margin:10px 0 0;color:#fbbf24;font-size:14px}
.actions{margin-top:14px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:11px 20px;border-radius:9px;background:var(--accent);color:#fff;font-size:14px;font-weight:700;text-decoration:none}
.btn-quiet{background:transparent;border:1px solid var(--border);color:var(--text);font-weight:600}
.link{color:var(--accent);font-size:14px;text-decoration:none}
.link:hover,.btn:hover{text-decoration:underline}
footer{margin-top:36px;color:var(--muted);font-size:13px}
footer a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
<h1>Download a player</h1>
<p class="lead">Every player below is served by this instance and is already pointed at it. Install one on a screen, then claim the pairing code in your dashboard.</p>
<div class="server">
  <span>Server URL — this is what a player asks for</span>
  <code>${esc(base)}</code>
</div>
${rows}
<footer>
  Nothing here needs a GitHub account. Source and release notes:
  <a href="https://github.com/screentinker/screentinker" rel="noopener">github.com/screentinker/screentinker</a>.
  Choosing hardware? <a href="/certified-hardware">Certified hardware</a>.
</footer>
</div>
</body>
</html>`;
}

module.exports = { entries, renderPage, formatSize };
