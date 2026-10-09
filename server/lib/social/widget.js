'use strict';

/*
 * The 'social' widget: a social wall showing one of the workspace's social feeds.
 *
 * ⚠️ A CACHEABLE PAGE CARRIES NO POSTS. A rev-pinned /render is cached for a year (and by the
 * player), and its rev is the WIDGET's revision: hiding a post, a deletion at the source or a
 * refetch does not change it. Posts baked into that page would come back on every load, hidden or
 * not. So that page asks /api/widgets/:id/social.json at once (retrying every 15 s until it gets an
 * answer, then every 2 minutes) and only ever shows what the server says now. While it stays
 * loaded it keeps its last answer through an outage; a screen that RELOADS it offline shows the
 * title and no posts rather than posts that may since have been hidden. Only the uncacheable
 * (no-rev) page is seeded with posts. Images come from
 * /api/widgets/:id/social-media/<hash> — this server's cached copies; a screen never fetches from a
 * social network, and the page's CSP says so (img-src and connect-src are this origin only).
 *
 * ⚠️ POST TEXT IS DATA, NEVER MARKUP. It reaches the page as JSON inside a
 * <script type="application/json"> block with every `<` escaped, and is put on screen with
 * textContent. Nothing a stranger posts is ever parsed as HTML here.
 *
 * Layouts: carousel (one post at a time, large), grid (a page of cards, rotating), ticker (one line,
 * scrolling). Sizes are in vmin so a post reads the same on a portrait or landscape panel.
 */

const feeds = require('./feeds');

const LAYOUTS = ['carousel', 'grid', 'ticker'];
const THEMES = ['dark', 'light'];
const NETWORK_LABELS = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', x: 'X', bluesky: 'Bluesky', mastodon: 'Mastodon' };

const intIn = (v, lo, hi, def) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};
const colour = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v) : d);

/** Validate a widget config at save time. The feed must be in the widget's own workspace. */
function normaliseConfig(db, workspaceId, raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const feed = feeds.forWorkspace(db, workspaceId, c.feed_id);
  if (!feed) throw new Error('Choose one of this workspace’s social feeds (Social feeds in the menu).');
  return { feed_id: feed.id, ...displayOptions(c) };
}

function displayOptions(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    layout: LAYOUTS.includes(c.layout) ? c.layout : 'carousel',
    interval_sec: intIn(c.interval_sec, 4, 300, 10),
    columns: intIn(c.columns, 0, 6, 0),
    show_author: c.show_author !== false,
    show_time: c.show_time !== false,
    // Off: pictures only, e.g. an Instagram feed as a promo strip beside the main content. The text
    // is then not sent to the screen at all, and posts with nothing but text are left out.
    show_text: c.show_text !== false,
    theme: THEMES.includes(c.theme) ? c.theme : 'dark',
    background: colour(c.background, ''),
    accent: colour(c.accent, '#4f8cff'),
    title: String(c.title || '').trim().slice(0, 80),
  };
}

/** What a screen receives about a post. Nothing more than it shows. */
function payloadPost(widgetId, r, { showText = true } = {}) {
  const m = (h) => `/api/widgets/${encodeURIComponent(widgetId)}/social-media/${h}`;
  let media = [];
  try { media = JSON.parse(r.media || '[]'); } catch { media = []; }
  return {
    k: `${r.network}:${r.post_id}`,
    n: r.network,
    a: r.author_name || '',
    h: r.author_handle || '',
    av: r.author_avatar ? m(r.author_avatar) : null,
    t: showText ? (r.text || '') : '',
    m: media.slice(0, 4).map(m),
    v: !!r.is_video,
    at: r.posted_at,
  };
}

function payload(db, widget, config) {
  const feed = config && config.feed_id ? feeds.forWorkspace(db, widget.workspace_id, config.feed_id) : null;
  if (!feed) return { posts: [], configured: false };
  const showText = config.show_text !== false;
  let posts = feeds.visiblePosts(db, feed).map((r) => payloadPost(widget.id, r, { showText }));
  if (!showText) posts = posts.filter((p) => p.m.length);   // a text-only post would be an empty card
  return { posts, configured: true, title: config.title || '' };
}

/*
 * Every screen showing a wall polls the same answer, so it is built once per PAYLOAD_TTL_MS per
 * widget: a fleet costs one feed query per interval, not one per screen. It is also keyed on the
 * feed's content revision (feeds.touch), so a hide on this node shows on the very next poll; a
 * change made on another node shows once the entry expires.
 */
const PAYLOAD_TTL_MS = 15 * 1000;
const payloadCache = new Map();
function cachedPayload(db, widget, config, nowMs = Date.now()) {
  const feedId = config && config.feed_id ? String(config.feed_id) : '';
  const key = `${widget.updated_at}|${widget.config}|${feeds.contentRev(feedId)}`;
  const hit = payloadCache.get(widget.id);
  if (hit && hit.key === key && nowMs - hit.at < PAYLOAD_TTL_MS) return hit.body;
  const body = payload(db, widget, config);
  if (payloadCache.size > 5000) payloadCache.clear();
  payloadCache.set(widget.id, { key, at: nowMs, body });
  return body;
}

const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
  .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

// `sandbox allow-scripts` (no allow-same-origin), like the BI, room and CAP pages: the wall draws
// third-party post text, so opened top-level it must not run on this server's origin (the dashboard's
// storage and cookies). From the opaque origin its own fetches still work: social.json answers
// ACAO * and the cached images CORP cross-origin (routes/widgets.js liveSocialWidget).
function csp(origin) {
  const o = origin || "'self'";
  return `default-src 'none'; img-src ${o} data:; connect-src ${o}; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`;
}

/**
 * The wall page. `origin` is this server, for the CSP and for absolute data/image URLs. `seed: false`
 * for a page that may be cached (a rev-pinned /render): it then carries no posts (see the header).
 */
function render(db, widget, rawConfig, { origin = '', sample = null, poll = true, seed = true } = {}) {
  let config;
  try { config = normaliseConfig(db, widget.workspace_id, rawConfig); } catch { config = null; }
  if (!config && sample) config = displayOptions(rawConfig);
  const seeded = !!sample || seed || !poll || !config; // an unconfigured wall has no posts to go stale
  let data;
  if (sample) data = { posts: sample, configured: true };
  else if (!config) data = { posts: [], configured: false };
  else data = seeded ? payload(db, widget, config) : { posts: [], configured: true };
  const cfg = config ? {
    layout: config.layout, interval: config.interval_sec, columns: config.columns, showAuthor: config.show_author, showTime: config.show_time,
    showText: config.show_text, title: config.title, accent: config.accent,
  } : { layout: 'carousel', interval: 10, columns: 0, showAuthor: true, showTime: true, showText: true, title: '', accent: '#4f8cff' };
  const dark = !config || config.theme === 'dark';
  const bg = (config && config.background) || (dark ? '#0d1117' : '#f5f6f8');
  const fg = dark ? '#f2f4f8' : '#16181d';
  const muted = dark ? 'rgba(242,244,248,.62)' : 'rgba(22,24,29,.6)';
  const card = dark ? 'rgba(255,255,255,.06)' : '#ffffff';
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Social wall</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:${bg};color:${fg};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#app{position:absolute;inset:0;display:flex;flex-direction:column;padding:3vmin}
#title{font-size:4.2vmin;font-weight:700;margin-bottom:2vmin;display:none}
#stage{position:relative;flex:1;min-height:0}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:${muted};font-size:3.4vmin;padding:6vmin}
.post{display:flex;flex-direction:column;background:${card};border-radius:2vmin;overflow:hidden;min-height:0}
.who{display:flex;align-items:center;gap:1.6vmin;padding:2vmin 2.4vmin 1vmin}
.av{width:6vmin;height:6vmin;border-radius:50%;object-fit:cover;flex:none;background:${muted}}
.names{min-width:0;flex:1}
.name{font-weight:700;font-size:2.8vmin;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.handle{color:${muted};font-size:2.2vmin;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.net{flex:none;font-size:1.9vmin;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#fff;background:${cfg.accent};padding:.6vmin 1.2vmin;border-radius:1vmin}
.media{position:relative;flex:1;min-height:0;background:rgba(0,0,0,.35)}
.media img{width:100%;height:100%;object-fit:contain;display:block}
.play{position:absolute;left:50%;top:50%;width:12vmin;height:12vmin;margin:-6vmin 0 0 -6vmin;border-radius:50%;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}
.play:after{content:"";border-left:4.4vmin solid #fff;border-top:2.6vmin solid transparent;border-bottom:2.6vmin solid transparent;margin-left:1vmin}
.text{padding:1.4vmin 2.4vmin 0;font-size:3vmin;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical}
.when{color:${muted};font-size:2vmin;padding:1vmin 2.4vmin 2vmin}
/* carousel */
.carousel .post{position:absolute;inset:0;opacity:0;transition:opacity 1s ease}
.carousel .post.on{opacity:1}
.carousel .text{font-size:3.6vmin;-webkit-line-clamp:6}
.carousel .post.textonly .text{font-size:5vmin;-webkit-line-clamp:10;flex:1;padding-top:3vmin}
/* grid */
.grid{display:grid;gap:2vmin;height:100%}
.grid .post{opacity:0;transition:opacity .8s ease}
.grid .post.on{opacity:1}
.grid .text{font-size:2.5vmin;-webkit-line-clamp:4}
.grid .post.textonly .text{-webkit-line-clamp:9;flex:1}
/* ticker */
/* ticker: made for a strip zone, so it fills its zone and sizes from the zone's HEIGHT (capped by width) */
body.ticker-mode #app{padding:0}
.ticker{position:absolute;inset:0;display:flex;align-items:center;overflow:hidden;background:${card};font-size:min(30vh,4.2vw)}
.tick-track{display:flex;gap:2.5em;white-space:nowrap;will-change:transform;padding-left:100%}
.tick-item{display:flex;align-items:center;gap:.5em;font-size:1em}
.tick-item .av{width:1.6em;height:1.6em}
.tick-item .net{font-size:.55em;padding:.2em .45em;border-radius:.3em}
.tick-item .handle{font-size:.75em}
.tick-item .thumb{height:2.4em;width:auto;max-width:6em;border-radius:.2em;object-fit:cover;display:block}
</style></head><body>
<div id="app"><div id="title"></div><div id="stage"></div></div>
<script type="application/json" id="seed">${jsonForScript({ cfg, data })}</script>
<script>
(function(){
  var seed = JSON.parse(document.getElementById('seed').textContent);
  var cfg = seed.cfg, posts = seed.data.posts || [], configured = seed.data.configured;
  // Unseeded (a cacheable page): nothing is known until the first answer, so not even "no posts".
  var loaded = ${seeded ? 'true' : 'false'};
  var NETS = ${JSON.stringify(NETWORK_LABELS)};
  var ORIGIN = ${JSON.stringify(origin)};
  var WID = ${JSON.stringify(String(widget.id))};
  var stage = document.getElementById('stage');
  var timer = null, idx = 0, sig = '';
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function abs(u){ return u && u.charAt(0) === '/' ? ORIGIN + u : u; }
  function ago(t){
    var s = Math.max(0, Math.floor(Date.now()/1000) - t);
    if (s < 3600) return Math.max(1, Math.floor(s/60)) + ' min ago';
    if (s < 86400) return Math.floor(s/3600) + ' h ago';
    var d = new Date(t*1000); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function who(p){
    var w = el('div','who');
    if (cfg.showAuthor) {
      if (p.av) { var i = el('img','av'); i.alt = ''; i.src = abs(p.av); w.appendChild(i); }
      var n = el('div','names'); n.appendChild(el('div','name', p.a || p.h)); if (p.h && p.h !== p.a) n.appendChild(el('div','handle', p.h)); w.appendChild(n);
    } else w.appendChild(el('div','names'));
    w.appendChild(el('div','net', NETS[p.n] || p.n));
    return w;
  }
  function card(p){
    var c = el('div','post' + (p.m && p.m.length ? '' : ' textonly'));
    c.appendChild(who(p));
    if (p.m && p.m.length) {
      var m = el('div','media'); var im = el('img'); im.alt = ''; im.src = abs(p.m[0]); m.appendChild(im);
      if (p.v) m.appendChild(el('div','play'));
      c.appendChild(m);
    }
    if (p.t && cfg.showText !== false) c.appendChild(el('div','text', p.t));
    if (cfg.showTime) c.appendChild(el('div','when', ago(p.at)));
    return c;
  }
  function clear(){ if (timer) { clearInterval(timer); timer = null; } while (stage.firstChild) stage.removeChild(stage.firstChild); }
  function empty(){ stage.appendChild(el('div','empty', !configured ? 'Choose a social feed for this wall in the widget settings.' : cfg.showText === false ? 'No posts with a picture to show yet.' : 'No posts to show yet.')); }
  function carousel(){
    var box = el('div','carousel'); box.style.position='absolute'; box.style.inset='0'; stage.appendChild(box);
    var cards = posts.map(card); cards.forEach(function(c){ box.appendChild(c); });
    idx = idx % cards.length; cards[idx].classList.add('on');
    if (cards.length > 1) timer = setInterval(function(){ cards[idx].classList.remove('on'); idx = (idx + 1) % cards.length; cards[idx].classList.add('on'); }, cfg.interval * 1000);
  }
  function grid(){
    var portrait = window.innerHeight > window.innerWidth;
    var cols = cfg.columns || (portrait ? 2 : 3), rows = portrait ? 3 : 2, per = cols * rows;
    var box = el('div','grid'); box.style.gridTemplateColumns = 'repeat(' + cols + ',minmax(0,1fr))'; box.style.gridTemplateRows = 'repeat(' + rows + ',minmax(0,1fr))';
    stage.appendChild(box);
    var page = 0, pages = Math.max(1, Math.ceil(posts.length / per));
    function show(){
      while (box.firstChild) box.removeChild(box.firstChild);
      posts.slice(page * per, page * per + per).forEach(function(p){ var c = card(p); box.appendChild(c); requestAnimationFrame(function(){ c.classList.add('on'); }); });
    }
    show();
    if (pages > 1) timer = setInterval(function(){ page = (page + 1) % pages; show(); }, cfg.interval * 1000);
  }
  function ticker(){
    var box = el('div','ticker'); var tr = el('div','tick-track'); box.appendChild(tr); stage.appendChild(box);
    posts.forEach(function(p){
      var it = el('div','tick-item');
      if (cfg.showAuthor && p.av) { var i = el('img','av'); i.alt=''; i.src = abs(p.av); it.appendChild(i); }
      it.appendChild(el('span','net', NETS[p.n] || p.n));
      if (cfg.showAuthor) it.appendChild(el('span','handle', p.h || p.a));
      // Pictures only: the strip shows each post's picture where its text would be.
      if (cfg.showText === false) { if (p.m && p.m[0]) { var th = el('img','thumb'); th.alt = ''; th.src = abs(p.m[0]); it.appendChild(th); } }
      else it.appendChild(el('span','', (p.t || '').replace(/\\s+/g, ' ').slice(0, 280)));
      tr.appendChild(it);
    });
    var x = 0, speed = Math.max(40, window.innerWidth / 12); var last = performance.now();
    function step(now){ x -= speed * (now - last) / 1000; last = now; if (-x > tr.scrollWidth) x = 0; tr.style.transform = 'translateX(' + x + 'px)'; requestAnimationFrame(step); }
    requestAnimationFrame(step);
  }
  function draw(){
    clear();
    var t = document.getElementById('title'); if (cfg.title && cfg.layout !== 'ticker') { t.textContent = cfg.title; t.style.display = 'block'; }
    // Pictures only: a post with nothing but text has nothing to show (the server leaves them out
    // too; this covers the editor's sample preview).
    if (cfg.showText === false) posts = posts.filter(function(p){ return p.m && p.m.length; });
    if (!posts.length) return loaded ? empty() : null;
    document.body.classList.toggle('ticker-mode', cfg.layout === 'ticker');
    if (cfg.layout === 'grid') grid(); else if (cfg.layout === 'ticker') ticker(); else carousel();
  }
  // What is on screen. Media are this server's content-addressed URLs, stable across refetches
  // (lib/social/media.js cacheKey), so an unchanged post never redraws the wall.
  function sigOf(list){ return (list || []).map(function(p){ return [p.k, p.t, p.a, p.h, p.av, (p.m || []).join(',')].join('\u0001'); }).join('\u0002'); }
  function later(){ setTimeout(poll, loaded ? 120000 : 15000); }
  function poll(){
    var x;
    try {
      x = new XMLHttpRequest(); x.open('GET', ORIGIN + '/api/widgets/' + encodeURIComponent(WID) + '/social.json'); x.timeout = 20000;
      x.onload = function(){ if (x.status !== 200) return; try { var d = JSON.parse(x.responseText); var s = sigOf(d.posts);
        var first = !loaded; loaded = true;
        if (s !== sig || first) { sig = s; posts = d.posts || []; configured = d.configured; draw(); } } catch (e) {} };
      x.onloadend = later;
      x.send();
    } catch (e) { later(); }
  }
  sig = sigOf(posts);
  draw();
  // Keeps what it has when the server is unreachable: only a successful answer replaces the posts.
  if (${poll ? 'true' : 'false'} && WID) { if (loaded) setTimeout(poll, 120000); else poll(); }
})();
</script></body></html>`;
  return { html, csp: csp(origin) };
}

/**
 * A self-contained wall for the embedded (server-side screenshot) renderer: images inlined as data
 * URIs, no polling — that renderer has neither the widget's address nor a network to reach it by.
 */
function renderSnapshot(db, workspaceId, rawConfig) {
  let config;
  try { config = normaliseConfig(db, workspaceId, rawConfig); } catch { config = null; }
  if (!config) return render(db, { id: '', workspace_id: workspaceId }, rawConfig, { poll: false }).html;
  const media = require('./media');
  const fs = require('fs');
  let budget = 8 * 1024 * 1024;
  const inline = (hash) => {
    const m = media.lookup(db, hash);
    if (!m) return null;
    try {
      const buf = fs.readFileSync(m.file);
      if (buf.length > budget) return null;
      budget -= buf.length;
      return `data:${m.mime};base64,${buf.toString('base64')}`;
    } catch { return null; }
  };
  const feed = feeds.forWorkspace(db, workspaceId, config.feed_id);
  const posts = feeds.visiblePosts(db, feed).map((r) => {
    let hashes = [];
    try { hashes = JSON.parse(r.media || '[]'); } catch { hashes = []; }
    return { ...payloadPost('', { ...r, media: '[]', author_avatar: null }), av: r.author_avatar ? inline(r.author_avatar) : null,
      m: hashes.slice(0, 1).map(inline).filter(Boolean) };
  });
  return render(db, { id: '', workspace_id: workspaceId }, rawConfig, { sample: posts, poll: false }).html;
}

/** The editor's preview (no saved widget yet): a sample wall, no network. */
function previewHtml(config) {
  const t = Math.floor(Date.now() / 1000);
  const sample = [
    { k: 'bluesky:1', n: 'bluesky', a: 'Your brand', h: '@yourbrand.bsky.social', av: null, t: 'Doors open at 9 — come and see the new collection in store this weekend.', m: [], v: false, at: t - 900 },
    { k: 'instagram:2', n: 'instagram', a: 'yourbrand', h: '@yourbrand', av: null, t: 'Behind the scenes of our autumn shoot 🍂', m: [], v: false, at: t - 7200 },
    { k: 'youtube:3', n: 'youtube', a: 'Your brand', h: '', av: null, t: 'How we make it — a five-minute tour', m: [], v: true, at: t - 86400 },
  ];
  const fakeDb = { prepare: () => ({ get: () => null, all: () => [] }) };
  return render(fakeDb, { id: 'preview', workspace_id: null }, config, { origin: '', sample }).html;
}

module.exports = { LAYOUTS, THEMES, NETWORK_LABELS, normaliseConfig, displayOptions, payload, cachedPayload, payloadPost, render, renderSnapshot, previewHtml, csp, jsonForScript, PAYLOAD_TTL_MS };
