'use strict';

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
 *
 * ⚠️ LINEAR TIME, like parse.js: pages, sitemaps and robots.txt are a stranger's text of up to 8 MB,
 * read on the main thread. Every scan below is the linear form of the regex quoted beside it
 * (lib/news-feed/scan.js; test/news-feed-linear.test.js checks they agree). No `[\s\S]*?`, no
 * unbounded `[^>]*` and no regex built from a robots.txt rule over this text.
 */

const { decodeEntities, plain, absUrl, isoDate, attrIn } = require('./parse');
const {
  isWs, skipWs, finder, gtFinder, replacePairs, replaceBlocks, closerByName, eachBlock, firstBlock, eachTag,
} = require('./scan');
const { trimTrailing } = require('../trim-trailing');

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
  eachTag(head, /<link\b/gi, 4000, (attrs) => {   // /<link\b([^>]{0,4000})>/gi
    if (out.length >= 60) return false;
    const rel = attrIn(attrs, 'rel').toLowerCase().split(/\s+/);
    const type = attrIn(attrs, 'type').toLowerCase();
    if (!rel.includes('alternate') || !FEED_TYPES.test(type)) return;
    // text/xml / application/xml alone are too vague unless the address says feed.
    const url = absUrl(attrIn(attrs, 'href'), baseUrl);
    if (!url || seen.has(url)) return;
    if (/^(text|application)\/xml$/.test(type) && !/(rss|feed|atom)/i.test(url)) return;
    seen.add(url);
    out.push({ url, title: plain(attrIn(attrs, 'title'), 160), type: kindOfType(type) });
  });
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
  let v = '';
  eachTag(html, /<meta\b/gi, 4000, (a) => {   // /<meta\b([^>]{0,4000})>/gi
    const k = (attrIn(a, 'property') || attrIn(a, 'name')).toLowerCase();
    if (k !== key) return true;
    v = attrIn(a, 'content');
    return false;
  });
  return v;
}

/** /<title[^>]*>([\s\S]{0,2000}?)<\/title>/i.exec(h)[1], or ''. */
function titleText(h) {
  const open = /<title/gi;
  const gt = gtFinder(h);
  const close = finder(h, /<\/title>/gi);
  let m;
  while ((m = open.exec(h))) {
    const g = gt(open.lastIndex);
    if (g < 0) return '';
    const c = close(g + 1);
    if (!c) return '';
    if (c.index - (g + 1) <= 2000) return h.slice(g + 1, c.index);
  }
  return '';
}

/** og:title / og:image / og:site_name / <title> of a page. */
function pageMeta(html, baseUrl) {
  const h = String(html || '').slice(0, 512 * 1024);
  return {
    title: plain(metaContent(h, 'og:title') || metaContent(h, 'twitter:title') || titleText(h), 300),
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
/**
 * Every /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi
 * body, in order. The opening tag counts when the stretch between "<script" and its ">" holds a
 * `type=application/ld+json`: worked out once per ">" (every <script sharing it shares the answer).
 */
function eachLdScript(html, fn) {
  const open = /<script\b/gi;
  const gt = gtFinder(html);
  const close = finder(html, /<\/script\s*>/gi);
  let tagEnd = -1;
  let lastType = -1;   // where the last type=application/ld+json before tagEnd starts
  let m;
  while ((m = open.exec(html))) {
    const g = gt(open.lastIndex);
    if (g < 0) return;
    if (g !== tagEnd) {
      tagEnd = g;
      lastType = -1;
      const from = html.lastIndexOf('>', g - 1) + 1;
      const seg = html.slice(from, g);
      const re = /type\s*=\s*["']?application\/ld\+json/gi;
      let t;
      while ((t = re.exec(seg))) lastType = from + t.index;
    }
    if (lastType < open.lastIndex) continue;
    const c = close(g + 1);
    if (!c) return;
    open.lastIndex = c.end;
    if (fn(html.slice(g + 1, c.index)) === false) return;
  }
}

function extractJsonLd(html, baseUrl) {
  const items = [];
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
  eachLdScript(String(html || ''), (body) => {
    if (items.length >= MAX_ITEMS) return false;
    const raw = body.trim().replace(/^<!--|-->$/g, '');
    if (raw.length > 512 * 1024) return true;
    let data;
    try { data = JSON.parse(raw); } catch (_) {
      try { data = JSON.parse(decodeEntities(raw)); } catch (__) { return true; }
    }
    visit(data, 0);
    return true;
  });
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
    eachBlock(src, /<sitemap\b/gi, /<\/sitemap\s*>/gi, ({ inner }) => {   // /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap\s*>/gi
      if (index.length >= 200) return false;
      const l = firstBlock(inner, /<loc/gi, /<\/loc\s*>/gi);                 // /<loc[^>]*>([\s\S]*?)<\/loc\s*>/i
      const loc = absUrl(decodeEntities((l ? l.inner : '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()), baseUrl);
      if (loc) index.push(loc);
      return true;
    });
  }
  const news = [];
  eachBlock(src, /<url\b/gi, /<\/url\s*>/gi, ({ inner: b }) => {           // /<url\b[^>]*>([\s\S]*?)<\/url\s*>/gi
    if (news.length >= MAX_ITEMS) return false;
    if (!/<news:news[\s>]/i.test(b)) return true;
    const pick = (tag) => {                                                   // /<tag[^>]*>([\s\S]*?)<\/tag\s*>/i
      const r = firstBlock(b, new RegExp(`<${tag}`, 'gi'), new RegExp(`</${tag}\\s*>`, 'gi'));
      return r ? decodeEntities(replacePairs(r.inner, '<![CDATA[', ']]>', (x) => x)).trim() : '';
    };
    const link = absUrl(pick('loc'), baseUrl);
    const title = plain(pick('news:title'), 300);
    if (!link || !title) return true;
    news.push({ title, link, summary: '', published: isoDate(pick('news:publication_date')), image: absUrl(pick('image:loc'), baseUrl) });
    return true;
  });
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
    const line = dropRobotsComment(rawLine).trim();
    const mm = robotsField(line);
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
  return {
    sitemaps,
    allows(pathAndQuery) {
      const p = String(pathAndQuery || '/');
      let best = null;
      for (const r of rules) {
        if (r.path === '') continue;          // "Disallow:" (empty) allows everything
        if (!robotsRuleMatches(r.path, p)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

/** rawLine.replace(/#.*$/, ''): from the first "#" with no line terminator after it (`.` stops at one). */
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029'];
function dropRobotsComment(line) {
  let t = -1;
  for (const ch of LINE_TERMINATORS) t = Math.max(t, line.lastIndexOf(ch));
  const h = line.indexOf('#', t + 1);
  return h < 0 ? line : line.slice(0, h);
}

/**
 * /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line) as [, key, value], or null. The regex backtracks over the
 * spaces after ":" once per space when a line terminator follows the value, which is quadratic; but
 * only the greedy reading can ever match, so this takes it and checks the terminator once.
 */
function robotsField(line) {
  let i = 0;
  while (i < line.length && /[A-Za-z-]/.test(line[i])) i++;
  if (i === 0) return null;
  let j = skipWs(line, i);
  if (line[j] !== ':') return null;
  j = skipWs(line, j + 1);
  const value = line.slice(j);
  if (/[\n\r\u2028\u2029]/.test(value)) return null;
  return [line, line.slice(0, i), value];
}

/**
 * Does a robots.txt rule match the path? It was new RegExp('^' + rule with `*` → `.*` and a final
 * `$` → end anchor).test(path), and a rule is the site's text: "/*a*a*a*a*a*a*b" against a path of
 * a's backtracks exponentially. Matching the literal pieces in order, each at its first place after
 * the last, is the same answer: a later place for a piece only leaves less room for the rest.
 * (`.` does not match a line terminator; a path from a URL never holds one, but such a path takes
 * the regex, unchanged.)
 */
function robotsRuleMatches(rule, p) {
  if (/[\n\r\u2028\u2029]/.test(p)) {
    let re;
    try {
      re = new RegExp('^' + rule.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$'));
    } catch (_) { return false; }
    return re.test(p);
  }
  const anchored = rule.endsWith('$');
  const parts = (anchored ? rule.slice(0, -1) : rule).split('*');
  if (!p.startsWith(parts[0])) return false;
  let pos = parts[0].length;
  if (parts.length === 1) return !anchored || pos === p.length;
  for (let k = 1; k < parts.length; k++) {
    const part = parts[k];
    if (anchored && k === parts.length - 1) return p.length - part.length >= pos && p.endsWith(part);
    const at = p.indexOf(part, pos);
    if (at < 0) return false;
    pos = at + part.length;
  }
  return true;
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
  const path = trimTrailing(u.pathname, '/');
  if (!path || path.split('/').filter(Boolean).length < 1) return false;
  if (trimTrailing(link.replace(/[#?].*$/, ''), '/') === trimTrailing(String(baseUrl).replace(/[#?].*$/, ''), '/')) return false;
  if (/\/(?:tag|tags|category|categories|author|authors|search|login|signin|subscribe|account|about|contact|privacy|terms|help)(?:\/|$)/i.test(path) && path.split('/').filter(Boolean).length < 3) return false;
  if (/\.(?:jpe?g|png|gif|webp|pdf|mp4|mp3|zip)$/i.test(path)) return false;
  const words = title.split(/\s+/).filter(Boolean).length;
  return title.length >= 20 && words >= 4 && title.length <= 300;
}

function imgIn(block, baseUrl) {
  let a = null;
  eachTag(block, /<img\b/gi, 4000, (attrs) => { a = attrs; return false; });   // /<img\b([^>]{0,4000})>/i
  if (a === null) return '';
  const srcset = attrIn(a, 'data-srcset') || attrIn(a, 'srcset');
  const fromSet = srcset ? srcset.split(',').map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop() : '';
  const src = attrIn(a, 'data-src') || attrIn(a, 'data-lazy-src') || attrIn(a, 'src');
  const pick = (src && !/^data:/.test(src) ? src : '') || fromSet;
  return absUrl(pick, baseUrl);
}

/** <article> blocks first; if that finds too little, links inside (or wrapping) <h1>–<h4>. */
/*
 * The headline patterns below, each as a scan. Two shapes recur:
 *
 *   OPEN [^>]*> \s*(?:<[^>]+>\s*)* NEXT   — after a tag, a run of tags separated by whitespace, then
 *                                         NEXT at one of the run's tags. tagRun() walks that run once.
 *   [\s\S]*? CLOSE                        — up to the first CLOSE: finder(), remembered.
 *
 * When an opener fails, every opener inside its tag run fails too (its run is the tail of the same
 * run, so it has a subset of the same chances), so the next one tried is past the run.
 */

/**
 * The run `\s*(?:<X[^>]*>\s*)*` from `pos`, X being one character that `ok(s, at)` vets (at is the
 * "<"): { tags: [[start, index of its ">"]…], end }.
 */
function tagRun(s, pos, gt, ok) {
  const tags = [];
  pos = skipWs(s, pos);
  while (s.charCodeAt(pos) === 60 && pos + 1 < s.length && ok(s, pos)) {
    const q = gt(pos + 2);
    if (q < 0) break;
    tags.push([pos, q]);
    pos = skipWs(s, q + 1);
  }
  return { tags, end: pos };
}
// X for <[^>]+>, for <(?!\/a)[^>]+> and for <[^a][^>]*>.
const anyTag = (s, i) => s[i + 1] !== '>';
const notCloseA = (s, i) => s[i + 1] !== '>' && !(s[i + 1] === '/' && (s[i + 2] === 'a' || s[i + 2] === 'A'));
const notA = (s, i) => s[i + 1] !== 'a' && s[i + 1] !== 'A';

const HEADING_AT = /<h[1-4]\b/iy;
const isAt = (re, s, i) => { re.lastIndex = i; return re.test(s); };

/**
 * /<a\b([^>]*)>\s*(?:<TAG>\s*)*<h[1-4]\b[^>]*>([\s\S]*?)<\/h[1-4]\s*>/gi, TAG being [^>]+ (or, with
 * notCloseA, (?!\/a)[^>]+): matches in order as fn({ index, attrs, html, end }); false from fn stops.
 * The star is greedy, so the heading is the LAST heading tag of the run that has a </hN> after it.
 */
function eachLinkedHeading(s, skipCloseA, fn) {
  const open = /<a\b/gi;
  const gt = gtFinder(s);
  const close = finder(s, /<\/h[1-4]\s*>/gi);
  const ok = skipCloseA ? notCloseA : anyTag;
  let m;
  while ((m = open.exec(s))) {
    const g = gt(m.index + 2);
    if (g < 0) return;
    const run = tagRun(s, g + 1, gt, ok);
    const heads = run.tags.filter(([at]) => isAt(HEADING_AT, s, at));
    let hit = null;
    if (heads.length) {
      const last = heads[heads.length - 1];
      const c = close(last[1] + 1);
      if (c) hit = { head: last, c };
      else if (heads.length > 1) {
        // No </hN> after the last heading, but an earlier heading may have one inside the run: the
        // latest heading that ends before the run's last </hN> wins, closed by the first after it.
        const closes = [];
        const re = /<\/h[1-4]\s*>/gi;
        const inRun = s.slice(0, last[1] + 1);
        re.lastIndex = heads[0][1] + 1;
        let x;
        while ((x = re.exec(inRun))) closes.push({ index: x.index, end: x.index + x[0].length });
        if (closes.length) {
          let k = heads.length - 2;
          while (k >= 0 && heads[k][1] + 1 > closes[closes.length - 1].index) k--;
          if (k >= 0) hit = { head: heads[k], c: closes.find((cl) => cl.index >= heads[k][1] + 1) };
        }
      }
    }
    if (!hit) { open.lastIndex = run.end; continue; }
    open.lastIndex = hit.c.end;
    if (fn({ index: m.index, attrs: s.slice(m.index + 2, g), html: s.slice(hit.head[1] + 1, hit.c.index), end: hit.c.end }) === false) return;
  }
}

/**
 * /<h[1-4]\b[^>]*>\s*(?:<[^a][^>]*>\s*)*<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi as fn({ index, attrs, html, end }).
 * No tag of the run starts "<a", so the link can only be what follows the whole run.
 */
function eachHeadingLink(s, fn) {
  const open = /<h[1-4]\b/gi;
  const linkAt = /<a\b/iy;
  const gt = gtFinder(s);
  const close = finder(s, /<\/a\s*>/gi);
  let m;
  while ((m = open.exec(s))) {
    const g = gt(m.index + 3);
    if (g < 0) return;
    const run = tagRun(s, g + 1, gt, notA);
    if (!isAt(linkAt, s, run.end)) { open.lastIndex = run.end; continue; }
    const g2 = gt(run.end + 2);
    if (g2 < 0) return;
    const c = close(g2 + 1);
    if (!c) return;
    open.lastIndex = c.end;
    if (fn({ index: m.index, attrs: s.slice(run.end + 2, g2), html: s.slice(g2 + 1, c.index), end: c.end }) === false) return;
  }
}

/**
 * /<h[1-4]\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a\s*>[\s\S]*?<\/h[1-4]\s*>/i.exec(b) as
 * { attrs, html } or null. Every step takes the first thing after the last, and if one is missing it
 * is missing for every later starting point too, so the first heading decides.
 */
function headingWithLink(b) {
  const h = /<h[1-4]\b/gi.exec(b);
  if (!h) return null;
  const g1 = b.indexOf('>', h.index + 3);
  if (g1 < 0) return null;
  const a = /<a\b/gi;
  a.lastIndex = g1 + 1;
  const am = a.exec(b);
  if (!am) return null;
  const g2 = b.indexOf('>', am.index + 2);
  if (g2 < 0) return null;
  const ca = /<\/a\s*>/gi;
  ca.lastIndex = g2 + 1;
  const c = ca.exec(b);
  if (!c) return null;
  const ch = /<\/h[1-4]\s*>/gi;
  ch.lastIndex = c.index + c[0].length;
  if (!ch.exec(b)) return null;
  return { attrs: b.slice(am.index + 2, g2), html: b.slice(g2 + 1, c.index) };
}

function extractHeadlineLinks(html, baseUrl) {
  // Was .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').
  let src = String(html || '').slice(0, 3 * 1024 * 1024);
  src = replaceBlocks(src, /<(script|style|noscript|template|svg)\b/gi, closerByName(src), ' ');
  src = replacePairs(src, '<!--', '-->', () => ' ');
  const items = [];
  const push = (href, titleHtml, block) => {
    const link = absUrl(decodeEntities(href), baseUrl);
    const title = plain(titleHtml, 300);
    if (storyLike(link, title, baseUrl)) items.push({ title, link, summary: '', published: null, image: imgIn(block || '', baseUrl) });
  };

  eachBlock(src, /<article\b/gi, /<\/article\s*>/gi, ({ inner: b }) => {   // /<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi
    if (items.length >= MAX_ITEMS) return false;
    // The headline: a link inside a heading, else a heading inside a link, else the longest link text.
    let h = headingWithLink(b);
    if (!h) eachLinkedHeading(b, false, (x) => { h = x; return false; });
    if (h) { push(attrIn(h.attrs, 'href'), h.html, b); return true; }
    let best = null;
    eachBlock(b, /<a\b/gi, /<\/a\s*>/gi, (l) => {                           // /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi
      const tx = plain(l.inner);
      if (!best || tx.length > best.tx.length) best = { href: attrIn(l.attrs, 'href'), html: l.inner, tx };
    });
    if (best) push(best.href, best.html, b);
    return true;
  });

  if (dedupe(items).length < 3) {
    eachHeadingLink(src, (x) => {
      if (items.length >= MAX_ITEMS * 2) return false;
      push(attrIn(x.attrs, 'href'), x.html, src.slice(Math.max(0, x.index - 1500), x.end + 200));
      return true;
    });
    eachLinkedHeading(src, true, (x) => {
      if (items.length >= MAX_ITEMS * 2) return false;
      push(attrIn(x.attrs, 'href'), x.html, src.slice(x.index, x.end));
      return true;
    });
  }
  return dedupe(items).slice(0, MAX_ITEMS);
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = trimTrailing(String(it.link).replace(/#.*$/, ''), '/');
    if (seen.has(k)) {
      // Keep the first; let a later duplicate fill in what the first lacked (an image, a date).
      const first = out.find((x) => trimTrailing(String(x.link).replace(/#.*$/, ''), '/') === k);
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
  _test: { dropRobotsComment, robotsField, robotsRuleMatches, titleText, eachLdScript, headingWithLink, eachLinkedHeading, eachHeadingLink },
};
