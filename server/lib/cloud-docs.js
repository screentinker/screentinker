'use strict';

/*
 * Cloud documents (widget_type 'cloud-doc'): a Google Slides / Docs / Sheets document, or a PowerPoint
 * / Word / Excel file from OneDrive or SharePoint, shown through the provider's own embed page.
 *
 * Nothing is fetched by the server and no credential is involved: the document must be published or
 * shared with "anyone with the link", and the screen loads the provider's embed page itself.
 *
 * ⚠️ WHY THE RENDER DOCUMENT HAS NO SCRIPT, AND WHY THAT MATTERS.
 *
 * Google's embed fails inside an opaque-origin sandbox ("Parts of this slide didn't load"), which is
 * what the web player frames every widget in. So a cloud-doc item is the one widget the web player
 * frames with allow-same-origin (ws/deviceSocket.js refreshWidgetRevs). That is only safe because the
 * document we serve for it runs NOTHING: its CSP is `script-src 'none'`, it contains one iframe whose
 * src is a URL rebuilt here from parsed parts on an allowlisted provider host, and its frame-src
 * permits only those hosts. With no script of ours in it, being same-origin with the player gives
 * nobody anything; the provider's page in the nested frame keeps the provider's own origin.
 * Refresh (for Docs/Sheets, which do not update themselves) is a <meta http-equiv="refresh">.
 */

const GOOGLE_HOST = 'docs.google.com';
// Office for the web embed hosts. *.sharepoint.com covers every tenant (and -my. OneDrive for work).
const OFFICE_HOSTS = ['onedrive.live.com', 'view.officeapps.live.com'];
const OFFICE_SUFFIX = '.sharepoint.com';

const FRAME_SRC = `https://${GOOGLE_HOST} https://onedrive.live.com https://view.officeapps.live.com https://*.sharepoint.com`;

const ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const DEFAULT_DELAY_SEC = 10;

class CloudDocError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** Accept a URL, or a pasted <iframe src="…"> embed snippet, and return the URL in it. */
function extractUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new CloudDocError('Paste the link to the document.');
  if (raw.length > 4000) throw new CloudDocError('That link is too long.');
  const m = /<iframe\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(raw);
  const url = (m ? m[1] : raw).replace(/&amp;/g, '&');
  let u;
  try { u = new URL(url); } catch { throw new CloudDocError('That is not a link (or an embed code) we can read.'); }
  if (u.protocol !== 'https:') throw new CloudDocError('The link must start with https://');
  if (u.username || u.password) throw new CloudDocError('The link must not contain a username or password.');
  return u;
}

const clampDelay = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 3600) : DEFAULT_DELAY_SEC;
};

/*
 * Google: rebuild the embed URL from the document kind and id, never pass the pasted one through.
 *   /presentation/d/<id>/edit|view|preview|present|embed   (shared with "anyone with the link")
 *   /presentation/d/e/<pubId>/pub|embed|pubembed            (File → Share → Publish to web)
 *   /document/…  /spreadsheets/…                            (same two shapes)
 */
function normaliseGoogle(u, { delaySec } = {}) {
  const m = /^\/(presentation|document|spreadsheets)\/d\/(e\/)?([^/]+)(?:\/|$)/.exec(u.pathname);
  if (!m || !ID_RE.test(m[3])) throw new CloudDocError('That Google link does not point at a Slides, Docs or Sheets file.');
  const [, kindPath, published, id] = m;
  const base = `https://${GOOGLE_HOST}/${kindPath}/d/${published ? 'e/' : ''}${id}`;
  if (kindPath === 'presentation') {
    const delay = clampDelay(delaySec);
    return { provider: 'google', kind: 'slides', url: `${base}/embed?start=true&loop=true&delayms=${delay * 1000}&rm=minimal`, delay_sec: delay };
  }
  // A sheet keeps the tab it was shared on.
  const gid = /^\d{1,12}$/.test(u.searchParams.get('gid') || '') ? u.searchParams.get('gid') : null;
  if (kindPath === 'spreadsheets') {
    const url = published
      ? `${base}/pubhtml?widget=true&headers=false${gid ? `&gid=${gid}` : ''}`
      : `${base}/preview${gid ? `?gid=${gid}` : ''}`;
    return { provider: 'google', kind: 'sheet', url };
  }
  return { provider: 'google', kind: 'doc', url: published ? `${base}/pub?embedded=true` : `${base}/preview` };
}

/*
 * Office for the web: an "Embed" link from OneDrive or SharePoint, or the Office viewer for a file at
 * a public URL. These carry opaque tokens (resid, authkey, sourcedoc) we cannot rebuild, so the URL is
 * kept as given — the host is the control, plus the shape of the path.
 */
function normaliseOffice(u, { delaySec } = {}) {
  const host = u.hostname.toLowerCase();
  if (host === 'onedrive.live.com') {
    if (u.pathname.toLowerCase() !== '/embed') throw new CloudDocError('Use the OneDrive "Embed" link (File → Share → Embed), not a sharing or edit link.');
  } else if (host === 'view.officeapps.live.com') {
    if (!/^\/op\/(embed|view)\.aspx$/i.test(u.pathname) || !u.searchParams.get('src')) throw new CloudDocError('That Office viewer link has no document in it.');
    u.pathname = '/op/embed.aspx';
  } else {
    // SharePoint / OneDrive for work: Doc.aspx or embed.aspx under _layouts/15, shown as embedview.
    if (!/\/_layouts\/15\/(Doc|embed|WopiFrame)\.aspx$/i.test(u.pathname)) {
      throw new CloudDocError('Use the SharePoint "Embed" link (File → Share → Embed), not a sharing link. For a whole folder, use a SharePoint folder sync instead.');
    }
    if (/\/Doc\.aspx$/i.test(u.pathname)) u.searchParams.set('action', 'embedview');
  }
  const ext = (u.searchParams.get('file') || u.searchParams.get('src') || '').toLowerCase();
  const kind = /\.(pptx?|ppsx?)\b/.test(ext) || u.searchParams.get('em') === '2' ? 'slides'
    : /\.xlsx?\b/.test(ext) ? 'sheet' : /\.docx?\b/.test(ext) ? 'doc' : 'office';
  const out = { provider: 'microsoft', kind, url: u.toString() };
  if (kind === 'slides') out.delay_sec = clampDelay(delaySec);
  return out;
}

const isOfficeHost = (h) => OFFICE_HOSTS.includes(h) || (h.endsWith(OFFICE_SUFFIX) && /^[a-z0-9-]+(-my)?\.sharepoint\.com$/.test(h));

/**
 * Normalise what an editor pasted into what we store. Throws CloudDocError (status 400) with a reason
 * a person can act on. `opts.delaySec` sets the Slides advance; `opts.refreshMin` reloads Docs/Sheets.
 */
function normaliseCloudDoc(input, opts = {}) {
  const u = extractUrl(input);
  const host = u.hostname.toLowerCase();
  let out;
  if (host === GOOGLE_HOST) out = normaliseGoogle(u, opts);
  else if (isOfficeHost(host)) out = normaliseOffice(u, opts);
  else throw new CloudDocError('Only Google Docs/Slides/Sheets (docs.google.com) and OneDrive/SharePoint embed links are supported here. For any other site, use a web page widget.');
  const refresh = Math.round(Number(opts.refreshMin));
  out.refresh_min = Number.isFinite(refresh) && refresh > 0 ? Math.min(refresh, 1440) : (out.kind === 'slides' ? 0 : 5);
  return out;
}

/** Re-validate a stored config (it may predate a rule, or have been written by an import). */
function safeConfig(config) {
  try {
    const c = config || {};
    const n = normaliseCloudDoc(c.url, { delaySec: c.delay_sec, refreshMin: c.refresh_min });
    return { ...n, zoom: Math.min(Math.max(Number(c.zoom) || 100, 25), 400), background: /^#[0-9a-f]{3,8}$/i.test(c.background || '') ? c.background : '#000000' };
  } catch { return null; }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The CSP the render route sends with renderCloudDoc. No script of any kind; frames only to providers. */
const RENDER_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; frame-src ${FRAME_SRC}; base-uri 'none'; form-action 'none'`;

function renderCloudDoc(config) {
  const c = safeConfig(config);
  if (!c) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#bbb;font:24px sans-serif}</style></head><body>This document link is not valid any more. Edit the widget.</body></html>';
  }
  const z = c.zoom / 100;
  const inv = 100 / z;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${c.refresh_min > 0 ? `<meta http-equiv="refresh" content="${c.refresh_min * 60}">` : ''}
<meta name="referrer" content="strict-origin-when-cross-origin">
<style>*{margin:0}html,body{height:100%;overflow:hidden;background:${c.background}}iframe{border:0;width:${inv}%;height:${inv}%;transform:scale(${z});transform-origin:0 0}</style>
</head><body><iframe src="${esc(c.url)}" allow="autoplay; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" title="Document"></iframe></body></html>`;
}

module.exports = { normaliseCloudDoc, safeConfig, renderCloudDoc, RENDER_CSP, CloudDocError, FRAME_SRC };
