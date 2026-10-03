'use strict';

/**
 * The Certified Hardware page: data loading and rendering.
 *
 * ⚠️ ONE RENDERER, TWO CALLERS, ON PURPOSE. scripts/build-certified-hardware.js writes the committed
 * static page from the JSON alone. routes/certified-hardware.js renders the same page with approved
 * community submissions merged in. If each built its own markup they would drift, and the half a
 * stranger submitted would start looking different from the half that carries contract weight.
 *
 * The split of responsibility is deliberate and is the whole design:
 *   certified-hardware.json   ScreenTinker's own entries. In git, human-committed, guarded by tests.
 *                             Certification is a support obligation; it does not come from a form.
 *   hardware_submissions      community reports. In the database, published by an approval click.
 *                             No support commitment attaches, which is why this half can be dynamic.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'certified-hardware.json');
const OUT = path.join(ROOT, 'frontend', 'certified-hardware.html');

const URL = 'https://screentinker.com/certified-hardware';
const TITLE = 'Certified Hardware | ScreenTinker';
const DESCRIPTION =
  'Device models tested with ScreenTinker, what each one actually does, and which are not '
  + 'supported. Certified Hardware under ScreenTinker reseller agreements.';

/** Status groups, in the order they appear on the page. Certified first, deliberately. */
const GROUPS = [
  {
    status: 'certified',
    heading: 'Certified',
    blurb: 'Tested by ScreenTinker, works, and supported under ScreenTinker agreements. '
      + 'A unit of each is kept in the ScreenTinker test lab for regression testing.',
    certified: true,
  },
  {
    status: 'certified-with-limits',
    heading: 'Certified with limits',
    blurb: 'Supported under ScreenTinker agreements, with a documented limitation. '
      + 'The limitation is spelled out on each entry.',
    certified: true,
  },
  {
    status: 'community-reported',
    heading: 'Community reported',
    blurb: 'A user reports that this works. ScreenTinker has not tested it and keeps no unit. '
      + 'These are NOT Certified Hardware and carry no support commitment.',
    certified: false,
  },
  {
    status: 'known-issues',
    heading: 'Known issues',
    blurb: 'Runs, but something is broken. What is broken is stated on each entry.',
    certified: false,
  },
  {
    status: 'not-supported',
    heading: 'Not supported',
    blurb: 'Tested and does not work well enough to recommend. '
      + 'Listed with the reason, because otherwise people buy them anyway.',
    certified: false,
  },
];

const CATEGORY_LABELS = {
  'streaming-player': 'Streaming player',
  'soc-display': 'Display with built-in player',
  'media-player': 'Media player',
  browser: 'Browser',
  sbc: 'Single-board computer',
};

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Unknown is rendered as an explicit "Not recorded", never as an empty cell. An empty cell reads
 *  as an oversight; on a page a lawyer may read, say that the value is not known. */
function value(v) {
  if (v == null || v === '') return '<span class="unknown">Not recorded</span>';
  if (Array.isArray(v)) return v.length ? esc(v.join(', ')) : '<span class="unknown">Not recorded</span>';
  return esc(v);
}

function deviceCard(d) {
  const rows = [
    ['Manufacturer', value(d.manufacturer)],
    ['Model numbers', value(d.model_numbers)],
    ['Category', value(CATEGORY_LABELS[d.category] || d.category)],
    ['Operating system', value(d.os)],
    ['ScreenTinker player', value(d.player)],
    ['Maximum resolution', value(d.max_resolution)],
    ['Validated on', value(d.validated_on)],
    ['Validated by', value(d.validated_by)],
    ['Tested against', value(d.player_version)],
    ['Minimum ScreenTinker version', value(d.min_version)],
    ['Manufacturer end of life', value(d.eol)],
  ];
  const notes = (d.notes || []).map((n) => `          <li>${esc(n)}</li>`).join('\n');
  const guide = d.provisioning_url
    ? `\n        <p class="setup-link"><a href="${esc(d.provisioning_url)}">Setup guide for this device</a></p>`
    : '';
  /*
   * A real installation photograph, credited.
   *
   * ⚠️ A PHOTO ON THIS PAGE IS A CLAIM, like every other field here. It shows THIS hardware running
   * ScreenTinker, published with the owner's permission and credited to them — never a stock product
   * shot, which would quietly turn a compatibility record into an advert on a page that reseller
   * agreements point at.
   *
   * Lazy and async-decoded: the list is long and a photo must never delay the text somebody came for.
   */
  const photo = d.photo && d.photo.src
    ? `\n        <figure class="device-photo">`
      + `<img src="${esc(d.photo.src)}" alt="${esc(d.photo.alt || '')}" loading="lazy" decoding="async">`
      + (d.photo.credit
        ? `<figcaption>Photo: ${d.photo.credit_url
            ? `<a href="${esc(d.photo.credit_url)}" rel="noopener">${esc(d.photo.credit)}</a>`
            : esc(d.photo.credit)}</figcaption>`
        : '')
      + `</figure>`
    : '';

  // Affiliate/where-to-buy link. rel="sponsored nofollow" is the honest tag for a paid link and the
  // one search engines ask for; it opens in a new tab so it does not navigate away from the list.
  const buy = d.buy_url
    ? `\n        <p class="buy-link"><a href="${esc(d.buy_url)}" rel="sponsored nofollow" target="_blank">Buy this device</a> <span class="affiliate-tag">(affiliate link)</span></p>`
    : '';
  return `      <article class="device" id="${esc(d.id)}">
        <h3><a class="anchor" href="#${esc(d.id)}" aria-label="Link to ${esc(d.name)}">#</a>${esc(d.name)}</h3>
        <dl class="device-spec">
${rows.map(([k, v]) => `          <dt>${esc(k)}</dt><dd>${v}</dd>`).join('\n')}
        </dl>${notes ? `
        <ul class="device-notes">
${notes}
        </ul>` : ''}${photo}${guide}${buy}
      </article>`;
}

function groupSection(group, devices) {
  if (!devices.length) return '';
  return `    <section class="status-group status-${esc(group.status)}">
      <h2>${esc(group.heading)} <span class="count">(${devices.length})</span></h2>
      <p class="group-blurb">${esc(group.blurb)}</p>
${devices.map(deviceCard).join('\n')}
    </section>`;
}

function render(data) {
  const devices = data.devices || [];
  const known = new Set(GROUPS.map((g) => g.status));
  const stray = devices.filter((d) => !known.has(d.status));
  if (stray.length) {
    throw new Error(`unknown status on: ${stray.map((d) => `${d.id} (${d.status})`).join(', ')}`);
  }
  const sections = GROUPS
    .map((g) => groupSection(g, devices.filter((d) => d.status === g.status)))
    .filter(Boolean)
    .join('\n\n');

  const certifiedCount = devices.filter(
    (d) => d.status === 'certified' || d.status === 'certified-with-limits').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(TITLE)}</title>
  <meta name="description" content="${esc(DESCRIPTION)}">
  <meta name="keywords" content="certified hardware, digital signage hardware, signage player hardware, screentinker supported devices">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${URL}">
  <!-- The plain-text twin, named in the document as well as in the Link header: a CDN may serve a
       cached HTML body to a request that asked for Markdown, and this survives inside that body. -->
  <link rel="alternate" type="text/markdown" href="${URL.replace(/\.html$/, '')}.md">

  <meta property="og:type" content="article">
  <meta property="og:url" content="${URL}">
  <meta property="og:title" content="Certified Hardware">
  <meta property="og:description" content="${esc(DESCRIPTION)}">
  <meta property="og:image" content="https://screentinker.com/assets/dashboard-preview.png">
  <meta property="og:site_name" content="ScreenTinker">

  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Certified Hardware">
  <meta name="twitter:description" content="${esc(DESCRIPTION)}">
  <meta name="twitter:image" content="https://screentinker.com/assets/dashboard-preview.png">

  <meta name="theme-color" content="#111827">
  <link rel="icon" href="/assets/icon-192.png">
  <link rel="apple-touch-icon" href="/assets/icon-192.png">
  <link rel="stylesheet" href="/css/seo-page.css">
  <style>
    /* Cards, not a wide table. The shared .compare-table is 640px minimum and scrolls sideways;
       with this many fields per device that is unreadable on the phone a reseller is holding on
       site. Cards stack, and each one is the deep-link target for its id. */
    .status-group { margin: 40px 0; }
    .status-group > h2 { border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .status-group .count { color: var(--dim); font-weight: 400; font-size: 16px; }
    .group-blurb { color: var(--muted); font-size: 15px; margin: 0 0 20px; }
    .device { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
      padding: 20px; margin: 16px 0; }
    .device > h3 { margin: 0 0 14px; font-size: 19px; scroll-margin-top: 90px; }
    .device .anchor { color: var(--dim); margin-right: 8px; text-decoration: none; font-weight: 400; }
    .device .anchor:hover { color: var(--accent); }
    .device-spec { display: block; margin: 0; font-size: 14px; }
    .device-spec dt { color: var(--muted); font-weight: 600; margin-top: 10px; }
    .device-spec dd { margin: 2px 0 0; color: var(--text); }
    .device-notes { margin: 16px 0 0; padding-left: 20px; color: var(--text); font-size: 14px; }
    .device-notes li { margin: 6px 0; }
    .device-photo { margin: 18px 0 0; }
    .device-photo img { display: block; width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--border); }
    .device-photo figcaption { margin-top: 8px; font-size: 12px; color: var(--muted); }
    .device-photo figcaption a { color: var(--accent); }
    .setup-link { margin: 14px 0 0; font-size: 14px; }
    .buy-link { margin: 8px 0 0; font-size: 14px; }
    .buy-link .affiliate-tag { color: var(--dim); font-size: 12px; }
    .affiliate-notice { color: var(--muted); font-size: 13px; margin: 20px 0 0; }
    .unknown { color: var(--dim); font-style: italic; }
    .callout { background: var(--card); border: 1px solid var(--border); border-left: 4px solid var(--accent);
      border-radius: 8px; padding: 18px 20px; margin: 24px 0; }
    .callout p:last-child { margin-bottom: 0; }
    .updated { color: var(--dim); font-size: 14px; }
    /* Two columns on a roomy screen, one on a phone. No horizontal scrolling at any width. */
    @media (min-width: 620px) {
      .device-spec { display: grid; grid-template-columns: 220px 1fr; column-gap: 16px; }
      .device-spec dt { margin-top: 0; }
      .device-spec dd { margin: 0; }
      .device-spec dt, .device-spec dd { padding: 5px 0; border-top: 1px solid var(--border); }
      .device-spec dt:first-of-type, .device-spec dt:first-of-type + dd { border-top: 0; }
    }
  </style>
</head>
<body>
  <nav>
    <div class="nav-inner">
      <div class="nav-logo">
        <a href="/" style="display:flex;align-items:center;gap:10px">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <span class="nav-logo-text">ScreenTinker</span>
        </a>
      </div>
      <div class="nav-links">
        <a href="/#features">Features</a>
        <a href="/#pricing">Pricing</a>
        <a href="/#compare">Compare</a>
        <a href="/integrations/">Integrations</a>
        <a href="/app#/login" class="btn btn-outline" style="margin-left:16px">Sign In</a>
        <a href="/app#/login" class="btn btn-primary" style="margin-left:8px">Try Free</a>
      </div>
    </div>
  </nav>

  <main class="article">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="/">Home</a>
      <span>/</span>
      <span>Certified Hardware</span>
    </nav>

    <h1>Certified Hardware</h1>
    <p class="lead">The device models ScreenTinker has tested with ScreenTinker, what each one actually
      does, and which ones to avoid.</p>
    <p class="updated">Last updated ${esc(data.last_updated)}. ${certifiedCount} device${certifiedCount === 1 ? '' : 's'} currently certified.</p>

    <p style="margin:20px 0 4px">
      <a href="/certified-hardware/submit" class="btn btn-primary" style="padding:14px 28px;font-size:16px">Report hardware that works</a>
    </p>

    <div class="callout">
      <p><strong>What "Certified Hardware" means.</strong> Only entries listed below as
        <strong>Certified</strong> or <strong>Certified with limits</strong> are Certified Hardware
        under ScreenTinker agreements. ScreenTinker has tested those models, keeps a unit of each in its
        test lab, and support obligations attach to them.</p>
      <p><strong>What it does not mean.</strong> Entries listed as Community reported, Known issues
        or Not supported are <strong>not</strong> Certified Hardware and carry
        <strong>no support commitment</strong>. They are published because knowing what other people
        have run, and what does not work, is useful when you are choosing what to buy.</p>
      <p>ScreenTinker is open source and runs on far more hardware than this list. Certification is a
        statement about what ScreenTinker has tested and will support, not about what is capable of
        running the software.</p>
    </div>

    <p class="affiliate-notice"><strong>Affiliate links.</strong> Some device cards below include a
      "Buy this device" link that is an affiliate link. If you buy through one, ScreenTinker may earn a
      commission at no extra cost to you. This has no bearing on what gets certified or how it is
      tested: certification is decided on the bench, never by whether a link earns anything.</p>

${sections}

    <h2>Android panels, and why we recommend a player plus a display</h2>
    <p>No commercial Android signage panel or all-in-one commercial display has been validated to
      date. If you have arrived here holding a listing for a white-label Android panel, that is the
      gap you are looking at. It is not a judgement about that panel. It means nobody at ScreenTinker
      has had one on a bench, so it cannot be certified and no support obligation can attach to it.</p>
    <p>The recommended path is a certified player driving a commercial display over HDMI. The player
      is the part that runs ScreenTinker, and it is the part that gets certified. <strong>The display
      itself is not player hardware and does not require certification.</strong> Any commercial
      display with an HDMI input will work, and you are free to choose it on the things displays are
      actually chosen for: panel quality, brightness, operating hours, warranty and size.</p>
    <p>That separation is deliberate. It keeps your display choice open, it keeps the part that runs
      software cheap and replaceable, and it means a failed player is a swap rather than a
      replacement screen.</p>

    <h2>Getting a device certified</h2>
    <p>If you need a specific model certified, contact ScreenTinker support and say which model and how
      many screens are involved. Validation of non-certified hardware is a paid engagement for
      reseller partners, and the result is published here whatever the outcome, including a
      Not supported entry if that is what the testing shows.</p>
    <p>If you are running something that is not on this list and it works, tell us. Community reports
      are welcome and are published as Community reported. That is not certification, and it is
      stated as such, but it helps the next person choosing hardware.</p>

    <div class="related">
      <h2>Related guides</h2>
      <ul>
        <li><a href="/guides/digital-signage-android-tv.html">Digital signage for Android TV and Fire TV</a></li>
        <li><a href="/guides/samsung-tv-digital-signage.html">Digital signage on a Samsung TV</a></li>
        <li><a href="/guides/raspberry-pi-digital-signage.html">Digital signage on a Raspberry Pi</a></li>
        <li><a href="/guides/self-hosted-digital-signage.html">Self-hosted digital signage: complete guide</a></li>
      </ul>
    </div>

    <div class="cta">
      <h2>Ready to set up a screen?</h2>
      <p>Start a free ScreenTinker account in under a minute.</p>
      <a href="/app#/login" class="btn btn-primary" style="padding:14px 28px;font-size:16px">Start Free</a>
      <a href="https://github.com/screentinker/screentinker" target="_blank" rel="noopener" class="btn btn-outline" style="padding:14px 28px;font-size:16px;margin-left:12px">View on GitHub</a>
    </div>
  </main>

  <footer>
    <div style="color:var(--dim);font-size:13px">&copy; 2026 ScreenTinker. All rights reserved.</div>
    <div class="links">
      <a href="https://github.com/screentinker/screentinker" target="_blank" rel="noopener">GitHub</a>
      <a href="https://discord.gg/utTdsrqq4Z" target="_blank" rel="noopener">Discord</a>
      <a href="/legal/terms.html">Terms</a>
      <a href="/legal/privacy.html">Privacy</a>
      <a href="/legal/third-party.html">Licenses</a>
      <a href="/app#/login">Sign In</a>
    </div>
  </footer>

  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://screentinker.com/" },
      { "@type": "ListItem", "position": 2, "name": "Certified Hardware", "item": "${URL}" }
    ]
  }
  </script>
</body>
</html>
`;
}

function loadData() {
  return JSON.parse(fs.readFileSync(DATA, 'utf8'));
}

module.exports = { render, loadData, deviceCard, groupSection, GROUPS, CATEGORY_LABELS, esc, DATA, OUT };
