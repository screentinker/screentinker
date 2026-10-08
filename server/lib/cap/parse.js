'use strict';

/*
 * CAP (Common Alerting Protocol) feed parsing. Pure: text in, normalised alerts out.
 *
 * What arrives in the wild, all handled here:
 *   - a single CAP 1.1 / 1.2 <alert> document;
 *   - an Atom <feed> whose entries carry the CAP fields inline (cap:event, cap:severity, … — the
 *     US National Weather Service and MeteoAlarm index feeds), or embed a whole <alert>;
 *   - an Atom or RSS index whose entries only LINK to CAP documents (returned as `links` for the
 *     poller to fetch, bounded);
 *   - the National Weather Service's GeoJSON (api.weather.gov/alerts/active), whose feature
 *     properties are the same CAP fields in camelCase.
 *
 * ⚠️ EVERY FIELD IS UNTRUSTED TEXT FROM A THIRD PARTY. This module only extracts and decodes; it
 * never produces markup. Rendering (lib/cap/card.js) escapes everything.
 *
 * No XML library: the server has none, and the RSS data source already parses by hand
 * (lib/data-sources/rss-resolver.js). CAP is a small fixed vocabulary, namespace prefixes vary
 * (cap:, none, ns2:), so prefixes are stripped and elements are found by local name.
 */

const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
const MAX_TEXT = 4000;

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function safeChar(n) {
  if (!Number.isFinite(n) || n < 9 || (n > 13 && n < 32) || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/** Strip namespace prefixes from element names: <cap:event> -> <event>, </ns2:info> -> </info>. */
function stripPrefixes(xml) {
  return String(xml).replace(/<(\/?)[A-Za-z_][\w.-]*:([A-Za-z_][\w.-]*)/g, '<$1$2');
}

/** Inner text of every <name>…</name> (not nested in another of the same name). */
function blocks(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function text(xml, name) {
  const b = blocks(xml, name)[0];
  if (b == null) return '';
  return clean(decodeEntities(b.replace(/<(?!!\[CDATA\[)[^>]+>/g, ' ')));
}
function clean(s) {
  return String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}
function iso(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function severityOf(s) {
  const k = String(s || '').trim();
  const hit = Object.keys(SEVERITY_RANK).find((x) => x.toLowerCase() === k.toLowerCase());
  return hit || 'Unknown';
}
function cap1(s) { const v = String(s || '').trim(); return v ? v[0].toUpperCase() + v.slice(1).toLowerCase() : ''; }

function normalise(a) {
  const info = a.info || {};
  return {
    identifier: String(a.identifier || '').trim().slice(0, 500),
    sender: String(a.sender || '').trim().slice(0, 500),
    sent: iso(a.sent),
    status: cap1(a.status) || 'Actual',
    msgType: cap1(a.msgType) || 'Alert',
    references: (a.references || []).map((r) => String(r).trim()).filter(Boolean).slice(0, 100),
    event: clean(info.event).slice(0, 200),
    severity: severityOf(info.severity),
    urgency: cap1(info.urgency) || 'Unknown',
    certainty: cap1(info.certainty) || 'Unknown',
    headline: clean(info.headline).slice(0, 500),
    description: clean(info.description),
    instruction: clean(info.instruction),
    senderName: clean(info.senderName).slice(0, 200),
    areaDesc: clean(info.areaDesc).slice(0, 1000),
    geocodes: (info.geocodes || []).slice(0, 500),
    effective: iso(info.effective) || iso(a.sent),
    onset: iso(info.onset),
    expires: iso(info.expires),
    // When the HAZARD ends (NWS `ends`), as opposed to when this message expires. Shown on the card;
    // liveness still follows `expires`, as CAP defines it.
    ends: iso(info.ends),
    language: String(info.language || '').trim().slice(0, 20),
  };
}

/** CAP references: "sender,identifier,sent" triples separated by whitespace. */
function splitReferences(s) {
  return String(s || '').trim().split(/\s+/).filter((x) => x.includes(','));
}

/** Pick the <info> block to show: the first in `lang` if any, else the first. */
function pickInfo(infos, lang) {
  if (!infos.length) return null;
  if (lang) {
    const l = lang.toLowerCase();
    const hit = infos.find((i) => text(i, 'language').toLowerCase().startsWith(l));
    if (hit) return hit;
  }
  return infos[0];
}

function infoFields(infoXml, areaScope) {
  const areas = blocks(areaScope || infoXml, 'area');
  const areaDesc = areas.map((a) => text(a, 'areaDesc')).filter(Boolean).join('; ') || text(infoXml, 'areaDesc');
  const geocodes = [];
  for (const g of [...blocks(areaScope || infoXml, 'geocode')]) {
    const valueName = text(g, 'valueName');
    const value = text(g, 'value');
    if (value) for (const v of value.split(/\s+/)) geocodes.push({ valueName, value: v });
  }
  return {
    language: text(infoXml, 'language'),
    event: text(infoXml, 'event'),
    severity: text(infoXml, 'severity'),
    urgency: text(infoXml, 'urgency'),
    certainty: text(infoXml, 'certainty'),
    headline: text(infoXml, 'headline'),
    description: text(infoXml, 'description'),
    instruction: text(infoXml, 'instruction'),
    senderName: text(infoXml, 'senderName'),
    effective: text(infoXml, 'effective'),
    onset: text(infoXml, 'onset'),
    expires: text(infoXml, 'expires'),
    areaDesc,
    geocodes,
  };
}

function parseAlertXml(alertXml, lang) {
  const infoXml = pickInfo(blocks(alertXml, 'info'), lang);
  // The message-level fields live before the first <info>; searching only there keeps an info's
  // own <description> or <parameter> from ever being read as the alert's identifier.
  const header = alertXml.replace(/<info[\s>][\s\S]*$/i, '');
  return normalise({
    identifier: text(header, 'identifier'),
    sender: text(header, 'sender'),
    sent: text(header, 'sent'),
    status: text(header, 'status'),
    msgType: text(header, 'msgType'),
    references: splitReferences(text(header, 'references')),
    info: infoXml ? infoFields(infoXml) : {},
  });
}

/** An Atom entry / RSS item carrying CAP fields inline (NWS, MeteoAlarm indexes). */
function parseInlineEntry(entry) {
  const id = text(entry, 'identifier') || text(entry, 'id') || text(entry, 'guid');
  return normalise({
    identifier: id,
    sender: text(entry, 'sender') || text(entry, 'name'),
    sent: text(entry, 'sent') || text(entry, 'published') || text(entry, 'updated'),
    status: text(entry, 'status'),
    msgType: text(entry, 'msgType') || text(entry, 'messageType'),
    references: splitReferences(text(entry, 'references')),
    info: {
      ...infoFields(entry, entry),
      headline: text(entry, 'headline') || text(entry, 'title'),
      description: text(entry, 'description') || text(entry, 'summary'),
    },
  });
}

function capLinks(entry) {
  const out = [];
  const re = /<link\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(entry))) {
    const attrs = m[1];
    const href = (/href\s*=\s*"([^"]+)"/i.exec(attrs) || /href\s*=\s*'([^']+)'/i.exec(attrs) || [])[1];
    const type = (/type\s*=\s*"([^"]+)"/i.exec(attrs) || [])[1] || '';
    if (href && (/cap/i.test(type) || /\.cap(\?|$)|\/cap\b|cap\.xml/i.test(href))) out.push(decodeEntities(href));
  }
  if (!out.length) {
    const l = text(entry, 'link');   // RSS <link>url</link>
    if (l && /\.cap(\?|$)|cap\.xml|\/cap\b/i.test(l)) out.push(l);
  }
  return out;
}

function parseGeoJson(obj) {
  const feats = Array.isArray(obj.features) ? obj.features : (obj.properties ? [obj] : []);
  return feats.map((f) => {
    const p = (f && f.properties) || {};
    const geocodes = [];
    for (const [valueName, vals] of Object.entries(p.geocode || {})) for (const v of (Array.isArray(vals) ? vals : [vals])) geocodes.push({ valueName, value: String(v) });
    return normalise({
      identifier: p.id || p.identifier || f.id,
      sender: p.sender,
      sent: p.sent,
      status: p.status,
      msgType: p.messageType || p.msgType,
      references: (Array.isArray(p.references) ? p.references : []).map((r) => `${r.sender || ''},${r.identifier || r['@id'] || ''},${r.sent || ''}`),
      info: {
        event: p.event, severity: p.severity, urgency: p.urgency, certainty: p.certainty,
        headline: p.headline, description: p.description, instruction: p.instruction,
        senderName: p.senderName, areaDesc: p.areaDesc, geocodes,
        effective: p.effective, onset: p.onset, expires: p.expires || p.ends, ends: p.ends,
        language: p.language,
      },
    });
  });
}

/**
 * Parse a feed body. Returns { kind, alerts: [normalised], links: [CAP document URLs to fetch] }.
 * Throws an Error with a message for the operator when the body is not a feed at all.
 */
function parseFeed(body, { lang = 'en' } = {}) {
  const raw = String(body || '');
  const head = raw.slice(0, 4096).trimStart();
  if (head.startsWith('{') || head.startsWith('[')) {
    let obj;
    try { obj = JSON.parse(raw); } catch { throw new Error('The feed returned JSON that could not be read.'); }
    if (obj && (obj.features || obj.properties)) return { kind: 'geojson', alerts: parseGeoJson(obj), links: [] };
    throw new Error('The feed returned JSON, but not a CAP / GeoJSON alert feed.');
  }
  const xml = stripPrefixes(raw);
  if (/^\s*<(?:!doctype html|html)/i.test(head)) throw new Error('That address is a web page, not an alert feed.');
  // Atom / RSS index first: a feed can embed whole <alert> documents inside its entries.
  const entries = blocks(xml, 'entry').concat(blocks(xml, 'item'));
  if (/<(?:feed|rss)[\s>]/i.test(xml.slice(0, 4096)) || entries.length) {
    const alerts = [];
    const links = [];
    for (const e of entries) {
      const inner = blocks(e, 'alert')[0];
      if (inner) { alerts.push(parseAlertXml(inner, lang)); continue; }
      const hasCapFields = /<(?:event|severity|urgency)[\s>]/i.test(e);
      if (hasCapFields) { alerts.push(parseInlineEntry(e)); continue; }
      links.push(...capLinks(e));
    }
    return { kind: 'index', alerts, links: [...new Set(links)] };
  }
  const alertBlocks = blocks(xml, 'alert');
  if (alertBlocks.length) return { kind: 'cap', alerts: alertBlocks.map((a) => parseAlertXml(a, lang)), links: [] };
  throw new Error('That address did not return a CAP alert, an Atom/RSS alert feed or alert GeoJSON.');
}

/** A stable key for an alert: CAP identifies a message by sender + identifier. */
function alertKey(a) { return `${a.sender}|${a.identifier}`; }
/** The keys a CAP reference triple ("sender,identifier,sent") names. */
function referenceKey(ref) {
  const [sender, identifier] = String(ref).split(',');
  return `${(sender || '').trim()}|${(identifier || '').trim()}`;
}

module.exports = { parseFeed, alertKey, referenceKey, SEVERITY_RANK, severityOf, _internal: { stripPrefixes, decodeEntities } };
