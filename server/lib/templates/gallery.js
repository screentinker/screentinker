'use strict';

/**
 * The public template gallery at /templates: the official catalog as this server last accepted it,
 * rendered as cards on the marketing page.
 *
 * ⚠️ BUILT FROM THE LIVE CATALOG, NOT A LIST IN THE PAGE. Templates are published to the catalog at
 * any time, independent of a server release, and every server picks them up on its own poll. A list
 * hand-written into the page would be stale the day the next template shipped. So the cards come
 * from `cachedIndex('official')` — the index whose signature this server already verified — and a
 * new template appears here on the next poll with nothing redeployed.
 *
 * Pure apart from the inputs it is given: `cards()` takes the index and an `installed` lookup, and
 * `renderCards()` returns markup, so both are testable without a server.
 */

const OFFICIAL = 'official';

/* Filter buttons, in the order shown. A card may sit in more than one. */
const CATEGORIES = [
  { id: 'corporate', label: 'Corporate' },
  { id: 'retail', label: 'Retail & Hospitality' },
  { id: 'data', label: 'Data & Dashboards' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'interactive', label: 'Interactive' },
];

/*
 * Hand-placed for the templates we publish ourselves. Anything else is placed by its tags (below),
 * so a template added to the catalog tomorrow still lands in a sensible filter instead of none.
 */
const PLACED = {
  'event-countdown': ['corporate', 'retail'],
  'guest-wifi': ['retail', 'utilities'],
  'kpi-dashboard': ['data', 'corporate'],
  leaderboard: ['data', 'corporate'],
  'lobby-welcome': ['corporate'],
  'meeting-room': ['corporate', 'utilities'],
  'menu-board': ['retail'],
  'news-ticker': ['corporate', 'utilities'],
  'news-wall': ['data', 'corporate'],
  'uptime-3036': ['interactive'],
  'weather-forecast': ['data', 'utilities'],
  'weather-html': ['data', 'utilities'],
  'world-clocks': ['corporate', 'utilities'],
};

const TAG_RULES = [
  ['retail', ['menu', 'restaurant', 'cafe', 'bar', 'hospitality', 'hotel', 'retail', 'prices', 'shop', 'store']],
  ['corporate', ['corporate', 'lobby', 'reception', 'office', 'meeting-room', 'internal-comms', 'welcome']],
  ['data', ['data-source', 'kpi', 'dashboard', 'metrics', 'rss', 'google-sheets', 'ical', 'calendar']],
  ['interactive', ['game', 'interactive', 'kiosk', 'touch']],
];

function categoriesFor(t) {
  if (PLACED[t.id]) return PLACED[t.id];
  const tags = new Set((t.tags || []).map((x) => String(x).toLowerCase()));
  const out = TAG_RULES.filter(([, words]) => words.some((w) => tags.has(w))).map(([id]) => id);
  return out.length ? out : ['utilities'];
}

/* Mirrors catalog.isRevoked for the one catalog we show, without needing the database. */
function revoked(index, t, v) {
  return (index.revoked || []).some((r) => (r.sha256 && r.sha256 === v.sha256)
    || (r.id === t.id && (!r.version || r.version === v.version)));
}

/**
 * index: the official catalog's accepted index (or null).
 * installed(key): the templates_installed row for `official/<id>`, or null.
 * catalogUrl: the catalog's base URL, for thumbnails of templates this server has not installed.
 *
 * A card gets a live preview only when the package is installed AND active here: the preview is
 * rendered by this server from the package it holds, never fetched from anywhere else.
 */
function cards(index, { installed = () => null, catalogUrl = null } = {}) {
  if (!index || !Array.isArray(index.templates)) return [];
  const out = [];
  for (const t of index.templates) {
    const latest = (t.versions || []).find((v) => !revoked(index, t, v));
    if (!latest) continue;
    const inst = installed(`${OFFICIAL}/${t.id}`);
    const live = !!(inst && inst.status === 'active' && inst.sha256 === latest.sha256);
    let thumbnail = null;
    if (t.thumbnail && live) thumbnail = `/api/templates/thumb/${latest.sha256}`;
    else if (t.thumbnail && catalogUrl && /^https:\/\//.test(catalogUrl)) {
      try { thumbnail = new URL(t.thumbnail, catalogUrl).href; } catch { thumbnail = null; }
    }
    if (thumbnail && !/^(\/api\/templates\/thumb\/[0-9a-f]{64}|https:\/\/)/.test(thumbnail)) thumbnail = null;
    const tags = (t.tags || []).map((x) => String(x).toLowerCase());
    out.push({
      id: t.id,
      name: t.name,
      description: t.description || '',
      kind: t.kind === 'html' ? 'html' : 'slide',
      categories: categoriesFor(t),
      orientation: Array.isArray(t.orientation) ? t.orientation : [],
      liveData: tags.includes('data-source') || /weather/.test(t.id),
      offline: Array.isArray(latest.network) && latest.network.length === 0,
      version: latest.version,
      thumbnail,
      preview: live ? `/api/templates/demo/${latest.sha256}` : null,
      homepage: typeof t.homepage === 'string' && /^https:\/\//.test(t.homepage) ? t.homepage : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.label]));

function renderCard(c) {
  const chips = [
    `<span class="tg-chip ${c.kind === 'html' ? 'tg-chip-code' : 'tg-chip-slide'}">${c.kind === 'html' ? 'Code template' : 'Slide template'}</span>`,
    c.liveData ? '<span class="tg-chip tg-chip-data">Live data</span>' : '',
    c.offline ? '<span class="tg-chip">No internet needed</span>' : '',
  ].filter(Boolean).join(' ');
  const thumb = c.thumbnail
    ? `<img src="${esc(c.thumbnail)}" alt="${esc(c.name)} template preview" loading="lazy" width="640" height="360">`
    : `<div class="tg-thumb-empty">${esc(c.name)}</div>`;
  const previewBtn = c.preview
    ? `<button type="button" class="btn btn-outline tg-preview" data-preview="${esc(c.preview)}" data-name="${esc(c.name)}" data-orientation="${esc(c.orientation.join(','))}">Interactive web preview</button>`
    : '';
  return `
      <article class="tg-card" data-categories="${esc(c.categories.join(' '))}">
        <div class="tg-thumb">${thumb}</div>
        <div class="tg-body">
          <h3>${esc(c.name)}</h3>
          <div class="tg-chips">${chips}</div>
          <p>${esc(c.description)}</p>
          <div class="tg-cats">${c.categories.map((id) => esc(LABEL[id] || id)).join(' · ')}</div>
        </div>
        <div class="tg-actions">${previewBtn}</div>
      </article>`;
}

function renderFilters() {
  return [`<button type="button" class="tg-filter is-active" data-filter="all" aria-pressed="true">All</button>`]
    .concat(CATEGORIES.map((c) => `<button type="button" class="tg-filter" data-filter="${c.id}" aria-pressed="false">${esc(c.label)}</button>`))
    .join('\n        ');
}

const START = '<!-- templates:cards -->';
const END = '<!-- /templates:cards -->';
const FSTART = '<!-- templates:filters -->';
const FEND = '<!-- /templates:filters -->';

/**
 * Put the live cards and filters into the committed page between its markers. With no cards (no
 * catalog accepted yet, or the library switched off on a self-hosted server) the committed
 * fallback between the markers is left exactly as it is — the page never errors and never shows
 * an empty grid with filters that filter nothing.
 */
function renderPage(shell, list) {
  if (!list.length) return shell;
  const i = shell.indexOf(START), j = shell.indexOf(END);
  const fi = shell.indexOf(FSTART), fj = shell.indexOf(FEND);
  if (i < 0 || j < i || fi < 0 || fj < fi) return shell;
  let out = shell.slice(0, i + START.length) + list.map(renderCard).join('') + '\n      ' + shell.slice(j);
  const fi2 = out.indexOf(FSTART), fj2 = out.indexOf(FEND);
  out = out.slice(0, fi2 + FSTART.length) + '\n        ' + renderFilters() + '\n        ' + out.slice(fj2);
  return out;
}

/* ----------------------------------------------------------------- demo data for previews */

/*
 * Demo values for the Weather data source a weather template needs. The keys are the ones
 * lib/data-sources/weather-resolver.js produces. Nothing here is fetched: a public preview must
 * never reach out on a visitor's behalf, and must never read any workspace's real data.
 */
function demoWeather(now = new Date()) {
  const WMO = { 0: ['Clear sky', '☀️'], 1: ['Mainly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    61: ['Slight rain', '🌦️'], 80: ['Slight rain showers', '🌦️'] };
  const days = [[2, 19, 9, 10], [0, 21, 10, 0], [61, 16, 11, 70], [3, 15, 8, 20], [1, 17, 7, 5], [80, 14, 9, 55]];
  const out = {
    location: 'Manchester', temperature: 18, apparent_temperature: 17, humidity: 58, wind_speed: 11,
    condition: 'Partly cloudy', icon: '⛅', code: 2, units: 'C',
    updated: now.toISOString().slice(0, 16).replace('T', ' '),
  };
  days.forEach(([code, hi, lo, pp], i) => {
    const d = new Date(now.getTime() + i * 86400000);
    Object.assign(out, {
      [`day${i}_name`]: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      [`day${i}_date`]: d.toISOString().slice(0, 10),
      [`day${i}_high`]: hi, [`day${i}_low`]: lo, [`day${i}_condition`]: WMO[code][0], [`day${i}_icon`]: WMO[code][1],
      [`day${i}_code`]: code, [`day${i}_precip_prob`]: pp,
    });
  });
  return out;
}

/*
 * Values for a demo render: every data_source param that needs weather is bound to the demo slug;
 * everything else keeps the template's own defaults (the templates ship sample content for exactly
 * this — a menu, a schedule, metrics — when no data source is bound).
 */
const DEMO_WEATHER_SLUG = 'demo-weather';
function demoValues(manifest) {
  const values = {};
  for (const p of manifest.params || []) {
    if (p.type !== 'data_source') continue;
    const hint = `${p.name} ${p.label || ''} ${p.help || ''}`.toLowerCase();
    if (/weather/.test(hint)) values[p.name] = DEMO_WEATHER_SLUG;
  }
  return values;
}
function demoData(slug) {
  return slug === DEMO_WEATHER_SLUG ? demoWeather() : null;
}

module.exports = {
  OFFICIAL, CATEGORIES, categoriesFor, cards, renderCard, renderPage, esc,
  demoValues, demoData, demoWeather, DEMO_WEATHER_SLUG,
};
