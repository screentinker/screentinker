'use strict';

// ⚠️ FROZEN COPY of lib/news-feed/discover.js as it was before the linear-time rewrite (release/3.0.1,
// 8d9610d6), kept ONLY so test/news-feed-linear.test.js can check the new code gives the same
// answers. Quadratic on hostile input by design: never require this outside that test.

/*
 * Reading a WEB PAGE for news: the feeds it advertises, and — for a site with no feed at all —
 * headlines built from the page itself. Pure functions over text; lib/news-feed/index.js fetches.
 *
 * Built-from-page items come from, in order of how much the site meant them as a list of stories:
 *
 *   1. schema.org JSON-LD   NewsArticle / Article / BlogPosting / ItemList the site publishes for
 *                           search engines. Structured, titled, usually with an image and a date.
 *   2. a Google News sitemap  <news:news> entries: titled and dated by the publisher.
 *   3. headline links        <article> blocks, then <h2>/<h3> links to the same site. A heuristic.
 *
 * ⚠️ HEADLINES, LINKS AND PICTURES ONLY. Nothing here reads an article's body, and the summary of a
 * built item is at most the short description the publisher wrote for search results. A screen
 * shows what a link preview would; it never republishes the story.
 */

const { decodeEntities, plain, absUrl, isoDate, attrIn } = require('./parse');

const MAX_ITEMS = 50;

/* ───────────── advertised feeds ───────────── */

const FEED_TYPES = /^(application\/(?:rss|atom|rdf|feed)\+(?:xml|json)|application\/(?:rss|atom)|text\/xml|application\/xml)$/i;

/**
 * <link rel="alternate" type="application/rss+xml" href="…" title="…"> tags.
 * Returns [{ url, title, type }], de-duplicated, in page order.
 */
function findFeedLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const head = String(html || '').slice(0, 1024 * 1024);
  const re = /<link\b([^>]{0,4000})>/gi;
  let m;
  while ((m = re.exec(head)) && out.length < 60) {
    const attrs = m[1];
    const rel = attrIn(attrs, 'rel').toLowerCase().split(/\s+/);
    const type = attrIn(attrs, 'type').toLowerCase();
    if (!rel.includes('alternate') || !FEED_TYPES.test(type)) continue;
    // text/xml / application/xml alone are too vague unless the address says feed.
    const url = absUrl(attrIn(attrs, 'href'), baseUrl);
    if (!url || seen.has(url)) continue;
    if (/^(text|application)\/xml$/.test(type) && !/(rss|feed|atom)/i.test(url)) continue;
    seen.add(url);
    out.push({ url, title: plain(attrIn(attrs, 'title'), 160), type: kindOfType(type) });
  }
  return out;
}
function kindOfType(type) {
  if (/atom/.test(type)) return 'atom';
  if (/json/.test(type)) return 'json';
  return 'rss';
}

/** Where sites without a <link> tag usually keep their feed, tried in this order. */
const COMMON_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/feed.json'];

/* ───────────── page metadata ───────────── */

function metaContent(html, key) {
  const re = /<meta\b([^>]{0,4000})>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = m[1];
    const k = (attrIn(a, 'property') || attrIn(a, 'name')).toLowerCase();
    if (k === key) return attrIn(a, 'content');
  }
  return '';
}

/** og:title / og:image / og:site_name / <title> of a page. */
function pageMeta(html, baseUrl) {
  const h = String(html || '').slice(0, 512 * 1024);
  return {
    title: plain(metaContent(h, 'og:title') || metaContent(h, 'twitter:title') || (/<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(h) || [])[1] || '', 300),
    siteName: plain(metaContent(h, 'og:site_name') || metaContent(h, 'application-name'), 160),
    image: absUrl(metaContent(h, 'og:image') || metaContent(h, 'og:image:url') || metaContent(h, 'twitter:image'), baseUrl),
    description: plain(metaContent(h, 'og:description') || metaContent(h, 'description'), 300),
  };
}

/* ───────────── 1. JSON-LD ───────────── */

const ARTICLE_TYPES = new Set(['newsarticle', 'article', 'blogposting', 'reportagenewsarticle', 'analysisnewsarticle',
  'opinionnewsarticle', 'backgroundnewsarticle', 'reviewnewsarticle', 'liveblogposting', 'techarticle', 'scholarlyarticle', 'report']);

function typesOf(node) {
  const t = node && node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string').map((x) => x.replace(/^.*[/#]/, '').toLowerCase());
}
const str = (v) => (typeof v === 'string' ? v : (typeof v === 'number' ? String(v) : ''));
function urlOf(v, base) {
  if (typeof v === 'string') return absUrl(v, base);
  if (Array.isArray(v)) { for (const x of v) { const u = urlOf(x, base); if (u) return u; } return ''; }
  if (v && typeof v === 'object') return absUrl(str(v.url) || str(v['@id']) || str(v.contentUrl), base);
  return '';
}

function ldItem(node, base) {
  const title = plain(str(node.headline) || str(node.name), 300);
  const link = urlOf(node.url, base) || urlOf(node.mainEntityOfPage, base) || (/^https?:/.test(str(node['@id'])) ? absUrl(str(node['@id']), base) : '');
  if (!title || !link) return null;
  return {
    title, link,
    summary: plain(str(node.description), 300),
    published: isoDate(str(node.datePublished) || str(node.dateCreated) || str(node.dateModified)),
    image: urlOf(node.image, base) || urlOf(node.thumbnailUrl, base),
  };
}

/** Articles from every <script type="application/ld+json"> block, in document order. */
function extractJsonLd(html, baseUrl) {
  const items = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  let budget = 2000;   // nodes visited, across all blocks: a hostile page cannot make this walk forever
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8 || --budget < 0 || items.length >= MAX_ITEMS) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
    const types = typesOf(node);
    if (types.some((t) => ARTICLE_TYPES.has(t))) {
      const it = ldItem(node, baseUrl);
      if (it) items.push(it);
    }
    if (types.includes('itemlist') && Array.isArray(node.itemListElement)) {
      for (const el of node.itemListElement) {
        if (!el || typeof el !== 'object') continue;
        const inner = el.item && typeof el.item === 'object' ? el.item : el;
        const it = ldItem({ ...inner, url: inner.url || el.url, name: inner.name || inner.headline || el.name }, baseUrl);
        if (it) items.push(it);
        else visit(inner, depth + 1);
      }
    }
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (node.mainEntity && typeof node.mainEntity === 'object') visit(node.mainEntity, depth + 1);
    if (node.hasPart && typeof node.hasPart === 'object') visit(node.hasPart, depth + 1);
  };
  while ((m = re.exec(String(html || ''))) && items.length < MAX_ITEMS) {
    const raw = m[1].trim().replace(/^<!--|-->$/g, '');
    if (raw.length > 512 * 1024) continue;
    let data;
    try { data = JSON.parse(raw); } catch (_) {
      try { data = JSON.parse(decodeEntities(raw)); } catch (__) { continue; }
    }
    visit(data, 0);
  }
  return dedupe(items);
}

/* ───────────── 2. sitemaps ───────────── */

/**
 * A sitemap: { news: [items with news:title], index: [child sitemap URLs] }. Only Google News entries
 * become items — an ordinary sitemap lists every page on the site, not stories.
 */
function parseSitemap(xml, baseUrl) {
  const src = String(xml || '').slice(0, 8 * 1024 * 1024);
  const index = [];
  if (/<sitemapindex[\s>]/i.test(src)) {
    const re = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap\s*>/gi;
    let m;
    while ((m = re.exec(src)) && index.length < 200) {
      const loc = absUrl(decodeEntities(((/<loc[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(m[1]) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()), baseUrl);
      if (loc) index.push(loc);
    }
  }
  const news = [];
  const re = /<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi;
  let m;
  while ((m = re.exec(src)) && news.length < MAX_ITEMS) {
    const b = m[1];
    if (!/<news:news[\s>]/i.test(b)) continue;
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i').exec(b);
      return r ? decodeEntities(r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
    };
    const link = absUrl(pick('loc'), baseUrl);
    const title = plain(pick('news:title'), 300);
    if (!link || !title) continue;
    news.push({ title, link, summary: '', published: isoDate(pick('news:publication_date')), image: absUrl(pick('image:loc'), baseUrl) });
  }
  // Newest first: a news sitemap is not required to be in any order.
  news.sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  return { news: dedupe(news), index };
}

/* ───────────── robots.txt ───────────── */

/**
 * robots.txt → { allows(path), sitemaps }. The group for our own token if there is one, else '*'.
 * Longest matching rule wins, Allow on a tie (RFC 9309); `*` and `$` are honoured.
 */
function parseRobots(text, agentTokens = ['screentinker-feedreader', 'screentinker']) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const mm = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!mm) continue;
    const key = mm[1].toLowerCase();
    const val = mm[2].trim();
    if (key === 'sitemap') { const u = absUrl(val); if (u) sitemaps.push(u); continue; }
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
  }
  const mine = groups.filter((g) => g.agents.some((a) => agentTokens.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules).filter((r) => r.path !== '' || !r.allow);
  const toRe = (p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$'));
  return {
    sitemaps,
    allows(pathAndQuery) {
      const p = String(pathAndQuery || '/');
      let best = null;
      for (const r of rules) {
        if (r.path === '') continue;          // "Disallow:" (empty) allows everything
        let re;
        try { re = toRe(r.path); } catch (_) { continue; }
        if (!re.test(p)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

/* ───────────── 3. headline links ───────────── */

function siteKey(host) { return String(host || '').toLowerCase().replace(/^www\d?\./, ''); }

function sameSite(url, baseUrl) {
  try {
    const a = new URL(url), b = new URL(baseUrl);
    const ka = siteKey(a.hostname), kb = siteKey(b.hostname);
    return ka === kb || ka.endsWith('.' + kb) || kb.endsWith('.' + ka);
  } catch (_) { return false; }
}

/** A link that reads like a story: same site, not the page itself, a real path, a headline-length text. */
function storyLike(link, title, baseUrl) {
  if (!link || !sameSite(link, baseUrl)) return false;
  let u;
  try { u = new URL(link); } catch (_) { return false; }
  const path = u.pathname.replace(/\/+$/, '');
  if (!path || path.split('/').filter(Boolean).length < 1) return false;
  if (link.replace(/[#?].*$/, '').replace(/\/+$/, '') === String(baseUrl).replace(/[#?].*$/, '').replace(/\/+$/, '')) return false;
  if (/\/(?:tag|tags|category|categories|author|authors|search|login|signin|subscribe|account|about|contact|privacy|terms|help)(?:\/|$)/i.test(path) && path.split('/').filter(Boolean).length < 3) return false;
  if (/\.(?:jpe?g|png|gif|webp|pdf|mp4|mp3|zip)$/i.test(path)) return false;
  const words = title.split(/\s+/).filter(Boolean).length;
  return title.length >= 20 && words >= 4 && title.length <= 300;
}

function imgIn(block, baseUrl) {
  const m = /<img\b([^>]{0,4000})>/i.exec(block);
  if (!m) return '';
  const a = m[1];
  const srcset = attrIn(a, 'data-srcset') || attrIn(a, 'srcset');
  const fromSet = srcset ? srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
  const src = attrIn(a, 'data-src') || attrIn(a, 'data-lazy-src') || attrIn(a, 'src');
  const pick = (src && !/^data:/.test(src) ? src : '') || fromSet;
  return absUrl(pick, baseUrl);
}

/** <article> blocks first; if that finds too little, links inside (or wrapping) <h1>–<h4>. */
function extractHeadlineLinks(html, baseUrl) {
  const src = String(html || '').slice(0, 3 * 1024 * 1024)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const items = [];
  const push = (href, titleHtml, block) => {
    const link = absUrl(decodeEntities(href), baseUrl);
    const title = plain(titleHtml, 300);
    if (storyLike(link, title, baseUrl)) items.push({ title, link, summary: '', published: null, image: imgIn(block || '', baseUrl) });
  };

  const art = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi;
  let m;
  while ((m = art.exec(src)) && items.length < MAX_ITEMS) {
    const b = m[1];
    // The headline: a link inside a heading, else a heading inside a link, else the longest link text.
    const h = /<h[1-4]\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a\s*>[\s\S]*?<\/h[1-4]\s*>/i.exec(b)
      || /<a\b([^>]*)>\s*(?:<[^>]+>\s*)*<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/i.exec(b);
    if (h) { push(attrIn(h[1], 'href'), h[2], b); continue; }
    let best = null;
    const la = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    let l;
    while ((l = la.exec(b))) { const tx = plain(l[2]); if (!best || tx.length > best.tx.length) best = { href: attrIn(l[1], 'href'), html: l[2], tx }; }
    if (best) push(best.href, best.html, b);
  }

  if (dedupe(items).length < 3) {
    const hl = /<h[1-4]\b[^>]*>\s*(?:<[^a][^>]*>\s*)*<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
    while ((m = hl.exec(src)) && items.length < MAX_ITEMS * 2) push(attrIn(m[1], 'href'), m[2], src.slice(Math.max(0, m.index - 1500), m.index + m[0].length + 200));
    const wrap = /<a\b([^>]*)>\s*(?:<(?!\/a)[^>]+>\s*)*<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/gi;
    while ((m = wrap.exec(src)) && items.length < MAX_ITEMS * 2) push(attrIn(m[1], 'href'), m[2], m[0]);
  }
  return dedupe(items).slice(0, MAX_ITEMS);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = String(it.link).replace(/#.*$/, '').replace(/\/+$/, '');
    if (seen.has(k)) {
      // Keep the first; let a later duplicate fill in what the first lacked (an image, a date).
      const first = out.find((x) => String(x.link).replace(/#.*$/, '').replace(/\/+$/, '') === k);
      if (first && !first.image && it.image) first.image = it.image;
      if (first && !first.published && it.published) first.published = it.published;
      continue;
    }
    seen.add(k);
    out.push(it);
  }
  return out;
}

module.exports = {
  findFeedLinks, pageMeta, extractJsonLd, parseSitemap, parseRobots, extractHeadlineLinks, sameSite, storyLike,
  COMMON_PATHS, MAX_ITEMS,
};
