'use strict';

/*
 * A Markdown rendition of one of our own HTML pages, for agents that ask for it.
 *
 * Why generate rather than keep .md files beside the .html: two copies of the same prose drift, and
 * the one nobody looks at is the one that goes stale. The HTML is what we publish and what a person
 * reads, so it stays the source and the Markdown is derived from it on request.
 *
 * ⚠️ THIS IS NOT A GENERAL HTML-TO-MARKDOWN CONVERTER, and it must not become one. It handles the
 * tags our own SEO pages actually use, and it is fed only files from frontendDir — never anything a
 * user supplied. A general converter would be a much larger surface for a much smaller benefit.
 */

// Block-level elements whose boundaries become blank lines. Everything else is inline.
const BLOCK = 'p|div|section|article|header|footer|main|h[1-6]|ul|ol|li|table|tr|blockquote|pre';

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&rarr;/g, '→').replace(/&larr;/g, '←')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&hellip;/g, '…').replace(/&times;/g, '×')
    // ⚠️ The named entities THIS SITE uses. A page that reads "Open source &middot; Free plan" in a
    // Markdown rendition is worse than one that reads it in HTML: the HTML at least renders.
    .replace(/&middot;/g, '·').replace(/&bull;/g, '•')
    .replace(/&copy;/g, '©').replace(/&reg;/g, '®').replace(/&trade;/g, '™')
    .replace(/&deg;/g, '°').replace(/&plusmn;/g, '±')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&sect;/g, '§').replace(/&para;/g, '¶')
    .replace(/&darr;/g, '↓').replace(/&uarr;/g, '↑')
    .replace(/&harr;/g, '↔').replace(/&ne;/g, '≠')
    .replace(/&le;/g, '≤').replace(/&ge;/g, '≥')
    .replace(/&#10003;/g, '✓').replace(/&#10007;/g, '✗')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    // Ampersand LAST, or "&amp;lt;" decodes twice and becomes a tag.
    .replace(/&amp;/g, '&');
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/* Absolute URLs. A Markdown rendition is read away from the page it came from — often by something
 * that will never issue a second request to resolve a relative path — so a bare "/guides/x.html" is
 * a dead link the moment it leaves the response. */
function absolutise(href, origin) {
  if (!href) return href;
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href;
  if (href.startsWith('#')) return href;
  if (!origin) return href;
  return origin.replace(/\/+$/, '') + (href.startsWith('/') ? href : '/' + href);
}

/*
 * ⚠️ TWO STAGES, AND THE ORDER IS THE BUG. `inlineMarkup` rewrites <a>/<code>/<strong> into Markdown
 * and leaves everything else alone; `inline` then flattens what is left to a single line. The first
 * version only had the flattening one and called it after stripping tags, so every link inside a
 * paragraph silently became bare text with a stray space where the anchor had been — the document
 * read fine and had no links in it, which is the failure mode nobody notices in review.
 */
function inlineMarkup(html, origin) {
  let s = String(html);
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  // Links first: their text may itself contain <strong>/<code>.
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const label = stripTags(text);
    if (!label) return '';
    return `[${label}](${absolutise(decodeEntities(href), origin)})`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => '`' + stripTags(t) + '`');
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t2) => {
    const inner = stripTags(t2);
    return inner ? `**${inner}**` : '';
  });
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, t2) => {
    const inner = stripTags(t2);
    return inner ? `*${inner}*` : '';
  });
  s = s.replace(/<kbd\b[^>]*>([\s\S]*?)<\/kbd>/gi, (_m, t) => '`' + stripTags(t) + '`');
  return s;
}

// Flatten to one line. Used for a table cell or a list item, where a newline would break the shape.
function inline(html, origin) {
  return decodeEntities(inlineMarkup(html, origin).replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ').trim();
}

function tableToMarkdown(html, origin) {
  const rows = [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2], origin).replace(/\|/g, '\\|'))
  ).filter((r) => r.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => r.concat(Array(width - r.length).fill(''));
  const out = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) out.push(`| ${pad(r).join(' | ')} |`);
  return out.join('\n');
}

/*
 * The readable part of the document.
 *
 * Nav and footer are the same on every page; repeating them in every rendition is pure noise to
 * whatever is reading, and on a long site it is most of the bytes. Scripts, styles and inline SVG are
 * removed outright — an agent asked for the text.
 */
function body(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '');
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '');
  const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) return main[1];
  const bodyTag = s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyTag ? bodyTag[1] : s;
}

function frontMatter(html, url) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || [])[1];
  const lines = [];
  if (title) lines.push(`# ${decodeEntities(title).replace(/\s*\|\s*ScreenTinker\s*$/, '').trim()}`);
  if (desc) lines.push('', `> ${decodeEntities(desc).trim()}`);
  if (url) lines.push('', `Source: ${url}`);
  return lines.join('\n');
}

/*
 * Convert one of our pages. `url` is the canonical address of the HTML original, included so a
 * rendition that has been copied somewhere still says where it came from.
 */
function toMarkdown(html, { url = null, origin = null } = {}) {
  let s = body(html);

  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, t) => {
    const text = inline(t, origin);
    return text ? `\n\n${'#'.repeat(Math.min(6, Number(lvl) + 1))} ${text}\n\n` : '\n\n';
  });
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (m) => `\n\n${tableToMarkdown(m, origin)}\n\n`);
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) =>
    `\n\n\`\`\`\n${decodeEntities(String(t).replace(/<[^>]*>/g, '')).trim()}\n\`\`\`\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => {
    const text = inline(t, origin);
    return text ? `\n- ${text}` : '';
  });
  s = s.replace(new RegExp(`</(${BLOCK})>`, 'gi'), '\n\n');

  // Convert the inline markup FIRST, so links survive; only then drop whatever tags are left.
  let out = decodeEntities(inlineMarkup(s, origin).replace(/<[^>]*>/g, ' '));
  out = out.replace(/[ \t]+/g, ' ');
  // inline() collapses runs of spaces but leaves the newlines the block rules inserted; normalise the
  // blank lines so the result reads like a document rather than a transcript.
  out = out.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const head = frontMatter(html, url);
  return `${head}\n\n${out}\n`.replace(/\n{3,}/g, '\n\n');
}

module.exports = { toMarkdown, toMarkdownText: stripTags, decodeEntities };
