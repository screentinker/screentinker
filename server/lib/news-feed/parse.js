'use strict';

/*
 * News feed parsing: RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed → one item shape
 *
 *   { title, link, summary, published, image }
 *
 * title/summary are PLAIN TEXT (tags stripped, entities decoded, whitespace collapsed), link/image
 * are absolute http(s) URLs or '', published is an ISO string or null.
 *
 * ⚠️ NOT AN XML PARSER, ON PURPOSE, like lib/data-sources/rss-resolver.js: bounded regular
 * expressions over a size-capped string. No DTD processing, no external entities, no entity
 * expansion beyond the XML five, numeric references and a fixed table of HTML names — so XXE and
 * "billion laughs" have nothing to act on. Real-world feeds are often not well-formed XML (a bare
 * `&` in a title, an HTML entity XML does not define), and a strict parser would refuse exactly the
 * feeds people paste most; this reads them.
 *
 * Everything here is pure: no I/O. lib/news-feed/index.js fetches and caches.
 */

const MAX_INPUT = 4 * 1024 * 1024;
const MAX_ITEMS = 100;
const TITLE_MAX = 300;
const SUMMARY_MAX = 400;

/* ───────────── bytes → text ───────────── */

/**
 * Decode a response body. The charset comes from (in order) a BOM, the Content-Type header, the
 * XML declaration, an HTML <meta charset>; UTF-8 otherwise. A label TextDecoder does not know
 * falls back to UTF-8 rather than failing the feed.
 */
function decodeBody(buf, contentType = '') {
  if (typeof buf === 'string') return buf;
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return decodeAs(buf.subarray(2), 'utf-16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return decodeAs(buf.subarray(2), 'utf-16be');
  let label = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(String(contentType)) || [])[1];
  if (!label) {
    const head = buf.subarray(0, 2048).toString('latin1');
    label = (/^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) || [])[1]
      || (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || [])[1];
  }
  return decodeAs(buf, label || 'utf-8');
}
function decodeAs(buf, label) {
  let dec;
  try { dec = new TextDecoder(String(label).toLowerCase()); } catch (_) { return buf.toString('utf8'); }
  // windows-1252 (which the Encoding Standard also uses for latin1, iso-8859-1 and us-ascii) is
  // decoded by hand. Node 22.14, the floor, decodes it as ISO-8859-1, so 0x80-0x9F (curly quotes,
  // dashes, the euro sign) came out as C1 control characters.
  if (dec.encoding === 'windows-1252') return decodeCp1252(buf);
  return dec.decode(buf);
}
// 0x80-0x9F in windows-1252. The five undefined bytes map to the matching C1 code point, as the
// Encoding Standard does.
const CP1252_C1 = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
function decodeCp1252(buf) {
  const s = buf.toString('latin1');
  return /[\x80-\x9f]/.test(s) ? s.replace(/[\x80-\x9f]/g, (c) => CP1252_C1[c.charCodeAt(0) - 0x80]) : s;
}

/* ───────────── entities ───────────── */

// The HTML names that actually turn up in feeds. Anything else is left as written.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', sbquo: '‚', bdquo: '„', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', prime: '′',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½',
  frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', para: '¶', sect: '§', cent: '¢',
  pound: '£', euro: '€', yen: '¥', iexcl: '¡', iquest: '¿', shy: '',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};

function safeChar(cp) {
  if (!Number.isFinite(cp) || cp < 9 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
  return String.fromCodePoint(cp);
}

/** One pass of entity decoding: numeric references and the names above. */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, e) => {
    if (e[0] === '#') return safeChar(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}

/* ───────────── element access ───────────── */

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Raw inner text of the first <tag>…</tag> in block ('' when absent). Tag names are literal (media:content). */
function rawOf(block, tag) {
  // (?<!/) — a self-closing <link href="…"/> has no content and must not swallow the next </link>.
  const re = new RegExp(`<${esc(tag)}(?:\\s[^>]{0,2000})?(?<!/)>([\\s\\S]{0,200000}?)</${esc(tag)}\\s*>`, 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

/**
 * Element content as the author meant it: CDATA sections taken verbatim, everything between them
 * entity-decoded once. What comes out may itself be HTML (an escaped <description>), which plain()
 * then strips.
 */
function unwrap(s) {
  let out = '';
  let last = 0;
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  while ((m = re.exec(s))) {
    out += decodeEntities(s.slice(last, m.index)) + m[1];
    last = re.lastIndex;
  }
  return out + decodeEntities(s.slice(last));
}

const textOf = (block, tag) => unwrap(rawOf(block, tag));

/** Attribute `attr` of the first <tag …> in block whose attribute string passes filter. */
function attrOf(block, tag, attr, filter) {
  const re = new RegExp(`<${esc(tag)}\\s([^>]{0,4000}?)/?>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1];
    if (filter && !filter(attrs)) continue;
    const v = attrIn(attrs, attr);
    if (v) return v;
  }
  return '';
}
function attrIn(attrs, attr) {
  const a = new RegExp(`(?:^|\\s)${esc(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return a ? decodeEntities(a[1] !== undefined ? a[1] : (a[2] !== undefined ? a[2] : a[3])).trim() : '';
}

/* ───────────── values ───────────── */

/** HTML or text → one line of plain text, clipped at a word boundary. */
function plain(html, max) {
  let s = String(html == null ? '' : html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Block boundaries become spaces; inline tags (<b>, <a>, <span>) vanish, so "in <b>x</b>." stays "in x.".
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|table|section|article|blockquote|figure|figcaption|header|footer|hr|img)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** An absolute http(s) URL, resolved against base, or ''. */
function absUrl(raw, base) {
  const v = String(raw || '').trim();
  if (!v || v.length > 2000) return '';
  try {
    const u = base ? new URL(v, base) : new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.toString();
  } catch (_) { return ''; }
}

/** RFC 822 / ISO 8601 → ISO, or null. */
function isoDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let d = new Date(v);
  // "Wed, 14 Oct 2026 20:44:21 EDT"-style zones Date handles; "CEST" and friends it does not.
  if (Number.isNaN(d.getTime())) d = new Date(v.replace(/\s+[A-Z]{3,5}$/, ' GMT'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;

function firstImgSrc(html, base) {
  const m = /<img\b[^>]*?\s(?:data-src|src)\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(String(html || ''));
  return m ? absUrl(decodeEntities(m[1] || m[2]), base) : '';
}

/* ───────────── formats ───────────── */

/** Which format this text is, or null when it is not a feed. */
function detectFormat(text) {
  const head = String(text || '').slice(0, 8192).replace(/^\uFEFF/, '');
  if (/^\s*\{/.test(head)) {
    return /"version"\s*:\s*"https?:\/\/jsonfeed\.org\/version\//i.test(String(text).slice(0, 65536)) ? 'json' : null;
  }
  const body = head.replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/i, '');
  if (/<rss[\s>]/i.test(body)) return 'rss';
  if (/<rdf:RDF[\s>]/i.test(body)) return 'rdf';
  if (/<feed[\s>]/i.test(body)) return 'atom';
  return null;
}

function itemImage(b, summaryHtml, base) {
  const notAv = (a) => !/medium\s*=\s*["'](?:video|audio)/i.test(a) && !/type\s*=\s*["'](?:video|audio)\//i.test(a);
  return absUrl(attrOf(b, 'media:content', 'url', (a) => notAv(a) && (/medium\s*=\s*["']image/i.test(a) || /type\s*=\s*["']image\//i.test(a) || IMAGE_EXT.test(attrIn(a, 'url')))), base)
    || absUrl(attrOf(b, 'media:thumbnail', 'url'), base)
    || absUrl(attrOf(b, 'enclosure', 'url', (a) => /type\s*=\s*["']image\//i.test(a) || IMAGE_EXT.test(attrIn(a, 'url'))), base)
    || absUrl(attrOf(b, 'itunes:image', 'href'), base)
    || absUrl(textOf(textOf(b, 'image'), 'url') || (/^\s*https?:\/\//.test(textOf(b, 'image')) ? textOf(b, 'image') : ''), base)
    || firstImgSrc(summaryHtml, base);
}

function finishItem(it) {
  let title = plain(it.title, TITLE_MAX);
  const summary = plain(it.summaryHtml, SUMMARY_MAX);
  if (!title && summary) title = plain(summary, 120);
  return { title, link: it.link || '', summary: summary === title ? '' : summary, published: it.published || null, image: it.image || '' };
}

function parseXmlFeed(raw, format, base) {
  // Comments first: one that mentions a tag (an <image> in a note) would otherwise be read as one.
  const src = raw.replace(/<!--[\s\S]*?-->/g, '');
  const atom = format === 'atom';
  const itemTag = atom ? 'entry' : 'item';
  const firstItem = src.search(new RegExp(`<${itemTag}[\\s>]`, 'i'));
  let channel = firstItem >= 0 ? src.slice(0, firstItem) : src;
  // RSS 2.0's <image> carries its own <title>/<link>: drop it before reading the channel's.
  channel = channel.replace(/<image[\s>][\s\S]*?<\/image\s*>/gi, '');
  const feedTitle = plain(textOf(channel, 'title'), 200);
  const feedLink = atom
    ? absUrl(attrOf(channel, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)), base)
    : absUrl(textOf(channel.replace(/<atom:link[^>]*>/gi, ''), 'link'), base);

  const items = [];
  const re = new RegExp(`<${itemTag}(?:\\s[^>]{0,2000})?>([\\s\\S]*?)</${itemTag}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(src)) && items.length < MAX_ITEMS) {
    const b = m[1];
    let summaryHtml, link, published;
    if (atom) {
      summaryHtml = textOf(b, 'summary') || textOf(b, 'content') || textOf(b, 'media:description');
      link = absUrl(attrOf(b, 'link', 'href', (a) => !/rel\s*=\s*["'](?!alternate)/i.test(a)), base);
      published = isoDate(textOf(b, 'published') || textOf(b, 'updated') || textOf(b, 'issued'));
    } else {
      summaryHtml = textOf(b, 'description') || textOf(b, 'content:encoded') || textOf(b, 'media:description');
      const guid = rawOf(b, 'guid') ? textOf(b, 'guid') : '';
      const guidIsLink = /^\s*https?:\/\//i.test(guid) && !/isPermaLink\s*=\s*["']false/i.test((/<guid(\s[^>]*)?>/i.exec(b) || [])[1] || '');
      link = absUrl(textOf(b, 'link'), base) || absUrl(attrOf(b, 'link', 'href'), base) || (guidIsLink ? absUrl(guid, base) : '')
        || (format === 'rdf' ? absUrl(attrOf(`<x ${(/<item(\s[^>]*)>/i.exec(m[0]) || [])[1] || ''}>`, 'x', 'rdf:about'), base) : '');
      published = isoDate(textOf(b, 'pubDate') || textOf(b, 'dc:date') || textOf(b, 'published') || textOf(b, 'updated'));
    }
    items.push(finishItem({
      title: textOf(b, 'title') || textOf(b, 'media:title'),
      summaryHtml, link, published, image: itemImage(b, summaryHtml, base),
    }));
  }
  return { format, title: feedTitle, link: feedLink, items: items.filter((i) => i.title) };
}

function parseJsonFeed(text, base) {
  let j;
  try { j = JSON.parse(text); } catch (_) { return null; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.items)) return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  const items = j.items.slice(0, MAX_ITEMS).filter((x) => x && typeof x === 'object').map((x) => finishItem({
    title: str(x.title),
    summaryHtml: str(x.summary) || str(x.content_text) || str(x.content_html),
    link: absUrl(str(x.url) || str(x.external_url), base),
    published: isoDate(str(x.date_published) || str(x.date_modified)),
    image: absUrl(str(x.image) || str(x.banner_image), base) || firstImgSrc(str(x.content_html), base),
  })).filter((i) => i.title);
  return { format: 'json', title: plain(str(j.title), 200), link: absUrl(str(j.home_page_url), base), items };
}

/**
 * Parse a feed. `base` is the feed's own URL, for relative links. Returns
 * { format, title, link, items } or null when the text is not a feed.
 */
function parseFeed(text, base = '') {
  const src = String(text == null ? '' : text).slice(0, MAX_INPUT).replace(/^\uFEFF/, '');
  const format = detectFormat(src);
  if (!format) return null;
  if (format === 'json') return parseJsonFeed(src, base);
  return parseXmlFeed(src, format, base);
}

module.exports = {
  parseFeed, detectFormat, decodeBody, decodeEntities, plain, absUrl, isoDate, attrIn, unwrap, firstImgSrc,
  MAX_ITEMS, TITLE_MAX,
};
