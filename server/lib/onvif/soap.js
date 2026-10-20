'use strict';

/*
 * ONVIF over SOAP: the messages and the parsing, and nothing that touches a network.
 *
 * Everything here is a pure function so the same code serves both ways a camera is reached
 * (lib/onvif/transport.js): from this server directly, or through a screen on the camera's own
 * network acting as a narrow relay. A camera never talks to anything but these functions' output,
 * and every reply is read back through them.
 *
 * Parsing is by LOCAL NAME, never by prefix: cameras disagree on prefixes (tt:, onvif:, ns2:...) and
 * even on which namespace a response element sits in, so `el(doc, 'Uri')` matches any `*:Uri`.
 *
 * Spec references: ONVIF Core (device service, WS-Discovery, WS-UsernameToken), Media (ver10),
 * Media2 (ver20), PTZ (ver20). Only the operations ScreenTinker uses are here.
 */

const crypto = require('crypto');

const NS = Object.freeze({
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  wsa: 'http://schemas.xmlsoap.org/ws/2004/08/addressing',
  wsd: 'http://schemas.xmlsoap.org/ws/2005/04/discovery',
  dn: 'http://www.onvif.org/ver10/network/wsdl',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  trt: 'http://www.onvif.org/ver10/media/wsdl',
  tr2: 'http://www.onvif.org/ver20/media/wsdl',
  tptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  tt: 'http://www.onvif.org/ver10/schema',
});

const PASSWORD_DIGEST = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';
const BASE64_BINARY = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/** The largest SOAP reply we will parse. Real ones are a few KB; GetProfiles on a 16-channel NVR ~200 KB. */
const MAX_REPLY_BYTES = 1024 * 1024;

function xmlEscape(v) {
  return String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// ─── WS-Security UsernameToken ────────────────────────────────────────────────

/** Base64(SHA1(nonce + created + password)), the PasswordDigest of the UsernameToken profile. */
function passwordDigest(nonce, created, password) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(nonce), Buffer.from(String(created), 'utf8'), Buffer.from(String(password), 'utf8')]))
    .digest('base64');
}

/**
 * The <Security> header. `created` must be the CAMERA's clock (ONVIF cameras refuse a token more
 * than a few seconds off), which is why callers pass the offset learned from GetSystemDateAndTime.
 */
function securityHeader({ username, password, nonce = crypto.randomBytes(16), created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') }) {
  if (!username) return '';
  return `<Security s:mustUnderstand="1" xmlns="${NS.wsse}"><UsernameToken>`
    + `<Username>${xmlEscape(username)}</Username>`
    + `<Password Type="${PASSWORD_DIGEST}">${passwordDigest(nonce, created, password || '')}</Password>`
    + `<Nonce EncodingType="${BASE64_BINARY}">${Buffer.from(nonce).toString('base64')}</Nonce>`
    + `<Created xmlns="${NS.wsu}">${created}</Created>`
    + '</UsernameToken></Security>';
}

/** A SOAP 1.2 envelope around `body`, with a UsernameToken when credentials are given. */
function envelope(body, auth = null) {
  const header = auth && auth.username ? `<s:Header>${securityHeader(auth)}</s:Header>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.soap}">${header}<s:Body>${body}</s:Body></s:Envelope>`;
}

// ─── Request bodies ───────────────────────────────────────────────────────────

const body = Object.freeze({
  getSystemDateAndTime: () => `<GetSystemDateAndTime xmlns="${NS.tds}"/>`,
  getServices: () => `<GetServices xmlns="${NS.tds}"><IncludeCapability>false</IncludeCapability></GetServices>`,
  getCapabilities: () => `<GetCapabilities xmlns="${NS.tds}"><Category>All</Category></GetCapabilities>`,
  getDeviceInformation: () => `<GetDeviceInformation xmlns="${NS.tds}"/>`,
  getProfiles: (media2) => (media2
    ? `<GetProfiles xmlns="${NS.tr2}"><Type>All</Type></GetProfiles>`
    : `<GetProfiles xmlns="${NS.trt}"/>`),
  getStreamUri: (media2, token) => (media2
    ? `<GetStreamUri xmlns="${NS.tr2}"><Protocol>RTSP</Protocol><ProfileToken>${xmlEscape(token)}</ProfileToken></GetStreamUri>`
    : `<GetStreamUri xmlns="${NS.trt}"><StreamSetup><Stream xmlns="${NS.tt}">RTP-Unicast</Stream>`
      + `<Transport xmlns="${NS.tt}"><Protocol>RTSP</Protocol></Transport></StreamSetup>`
      + `<ProfileToken>${xmlEscape(token)}</ProfileToken></GetStreamUri>`),
  getSnapshotUri: (media2, token) => `<GetSnapshotUri xmlns="${media2 ? NS.tr2 : NS.trt}"><ProfileToken>${xmlEscape(token)}</ProfileToken></GetSnapshotUri>`,
  /** Speeds are -1..1 (pan, tilt, zoom); a timeout makes the camera stop by itself if Stop is lost. */
  continuousMove: (token, { pan = 0, tilt = 0, zoom = 0 } = {}, timeoutSec = 1) => `<ContinuousMove xmlns="${NS.tptz}"><ProfileToken>${xmlEscape(token)}</ProfileToken>`
    + `<Velocity><PanTilt x="${clamp1(pan)}" y="${clamp1(tilt)}" xmlns="${NS.tt}"/><Zoom x="${clamp1(zoom)}" xmlns="${NS.tt}"/></Velocity>`
    + `<Timeout>PT${Math.max(0.1, Math.min(10, Number(timeoutSec) || 1))}S</Timeout></ContinuousMove>`,
  stop: (token) => `<Stop xmlns="${NS.tptz}"><ProfileToken>${xmlEscape(token)}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`,
  getPresets: (token) => `<GetPresets xmlns="${NS.tptz}"><ProfileToken>${xmlEscape(token)}</ProfileToken></GetPresets>`,
  gotoPreset: (token, preset) => `<GotoPreset xmlns="${NS.tptz}"><ProfileToken>${xmlEscape(token)}</ProfileToken><PresetToken>${xmlEscape(preset)}</PresetToken></GotoPreset>`,
  gotoHomePosition: (token) => `<GotoHomePosition xmlns="${NS.tptz}"><ProfileToken>${xmlEscape(token)}</ProfileToken></GotoHomePosition>`,
});

function clamp1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(-1, Math.min(1, n)) * 1000) / 1000;
}

/** A WS-Discovery Probe for ONVIF video transmitters, sent to 239.255.255.250:3702 (or one host's :3702). */
function probeMessage(messageId = `uuid:${crypto.randomUUID()}`) {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="${NS.soap}" xmlns:a="${NS.wsa}">`
    + `<s:Header><a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>`
    + `<a:MessageID>${xmlEscape(messageId)}</a:MessageID>`
    + '<a:ReplyTo><a:Address>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>'
    + '<a:To s:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To></s:Header>'
    + `<s:Body><Probe xmlns="${NS.wsd}"><Types xmlns:dn="${NS.dn}">dn:NetworkVideoTransmitter</Types></Probe></s:Body></s:Envelope>`;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

class OnvifError extends Error {
  constructor(message, code = 'onvif', extra = {}) {
    super(message);
    this.name = 'OnvifError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function parse(xml) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  if (text.length > MAX_REPLY_BYTES) throw new OnvifError('The camera sent a reply too large to read', 'too-large');
  if (!/<[^>]*Envelope[\s>]/.test(text)) throw new OnvifError('The camera did not answer with ONVIF (SOAP)', 'not-soap');
  let doc;
  const errors = [];
  // Loaded here, not at the top: building a message (probeMessage, envelope) needs no XML parser,
  // so the players' tests can compare their Probe with this module's in a checkout without npm deps.
  const { DOMParser } = require('@xmldom/xmldom');
  try {
    doc = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(text, 'text/xml');
  } catch (e) {
    throw new OnvifError('The camera sent a reply that is not valid XML', 'bad-xml');
  }
  if (!doc || !doc.documentElement || errors.length) throw new OnvifError('The camera sent a reply that is not valid XML', 'bad-xml');
  return doc;
}

/** Elements anywhere under `node` with this local name, whatever their prefix or namespace. */
function els(node, local) {
  return node ? Array.from(node.getElementsByTagNameNS('*', local)) : [];
}
function el(node, local) { return els(node, local)[0] || null; }
function txt(node, local) {
  const e = local ? el(node, local) : node;
  return e && e.textContent != null ? e.textContent.trim() : '';
}
/** A direct child by local name (for profiles, where nested configs reuse names like Name). */
function child(node, local) {
  if (!node) return null;
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && c.localName === local) return c;
  return null;
}

/**
 * A SOAP Fault becomes an OnvifError, so every caller sees one shape. NotAuthorized (wrong
 * password, or a clock too far off for the token) gets its own code: the dashboard asks for the
 * password again on that one.
 */
function assertNoFault(doc) {
  const fault = el(doc, 'Fault');
  if (!fault) return;
  const codes = els(fault, 'Value').map((e) => e.textContent.trim());
  const reason = txt(fault, 'Text') || txt(fault, 'faultstring') || codes.join(' ') || 'SOAP fault';
  const notAuth = codes.some((c) => /NotAuthorized|FailedAuthentication|InvalidSecurity/i.test(c)) || /not ?authori[sz]ed|authentication/i.test(reason);
  throw new OnvifError(notAuth ? 'The camera refused the username or password' : `The camera said: ${reason}`, notAuth ? 'not-authorized' : 'fault', { faultCodes: codes });
}

/** Parse an ONVIF reply: throws on a fault, else returns the document. */
function reply(xml) {
  const doc = parse(xml);
  assertNoFault(doc);
  return doc;
}

const parseReply = Object.freeze({
  /** The camera's UTC clock, or null when it doesn't say. */
  systemDateAndTime(xml) {
    const doc = reply(xml);
    const utc = el(doc, 'UTCDateTime');
    if (!utc) return null;
    const n = (name) => Number(txt(utc, name));
    const [Y, M, D, h, m, s] = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(n);
    if (![Y, M, D, h, m, s].every(Number.isFinite)) return null;
    return new Date(Date.UTC(Y, M - 1, D, h, m, s));
  },

  /** GetServices: namespace -> XAddr. */
  services(xml) {
    const doc = reply(xml);
    const out = {};
    for (const s of els(doc, 'Service')) {
      const ns = txt(s, 'Namespace');
      const x = txt(s, 'XAddr');
      if (ns && x) out[ns] = x;
    }
    return {
      media: out[NS.trt] || null,
      media2: out[NS.tr2] || null,
      ptz: out[NS.tptz] || null,
    };
  },

  /** GetCapabilities (older cameras without GetServices): the same three addresses. */
  capabilities(xml) {
    const doc = reply(xml);
    const x = (local) => { const e = el(doc, local); return e ? txt(e, 'XAddr') || null : null; };
    return { media: x('Media'), media2: null, ptz: x('PTZ') };
  },

  deviceInformation(xml) {
    const doc = reply(xml);
    return {
      manufacturer: txt(doc, 'Manufacturer'),
      model: txt(doc, 'Model'),
      firmware: txt(doc, 'FirmwareVersion'),
      serial: txt(doc, 'SerialNumber'),
      hardware: txt(doc, 'HardwareId'),
    };
  },

  /**
   * Profiles, Media (ver10) or Media2 (ver20). Each: token, name, encoding, width, height, and
   * whether it has a PTZ configuration (the PTZ calls need a profile that does).
   */
  profiles(xml) {
    const doc = reply(xml);
    return els(doc, 'Profiles').map((p) => {
      const enc = child(p, 'VideoEncoderConfiguration') || el(p, 'VideoEncoder') || el(p, 'VideoEncoderConfiguration');
      const res = enc ? el(enc, 'Resolution') : null;
      const configs = child(p, 'Configurations');   // Media2 nests them one level down
      const ptz = child(p, 'PTZConfiguration') || (configs && child(configs, 'PTZ'));
      return {
        token: p.getAttribute('token') || '',
        name: txt(child(p, 'Name')) || p.getAttribute('token') || '',
        encoding: enc ? txt(enc, 'Encoding') : '',
        width: res ? Number(txt(res, 'Width')) || null : null,
        height: res ? Number(txt(res, 'Height')) || null : null,
        ptz: !!ptz,
      };
    }).filter((p) => p.token);
  },

  /** GetStreamUri / GetSnapshotUri: the URI, whichever Media version answered. */
  uri(xml) {
    const doc = reply(xml);
    const u = txt(doc, 'Uri');
    if (!u) throw new OnvifError('The camera did not give an address', 'no-uri');
    return u;
  },

  presets(xml) {
    const doc = reply(xml);
    return els(doc, 'Preset').map((p) => ({ token: p.getAttribute('token') || '', name: txt(child(p, 'Name')) || p.getAttribute('token') || '' }))
      .filter((p) => p.token);
  },

  /** Any reply that only has to not be a fault (PTZ moves, Stop, GotoPreset). */
  ok(xml) { reply(xml); return true; },

  /**
   * WS-Discovery ProbeMatches: one entry per camera that answered. xaddrs are its device service
   * addresses (often several: IPv4, IPv6, hostname); scopes carry its name and hardware.
   */
  probeMatches(xml) {
    let doc;
    try { doc = parse(xml); } catch { return []; }
    return els(doc, 'ProbeMatch').map((m) => {
      const scopes = txt(m, 'Scopes').split(/\s+/).filter(Boolean);
      const scope = (kind) => {
        const s = scopes.find((x) => x.toLowerCase().startsWith(`onvif://www.onvif.org/${kind}/`));
        if (!s) return '';
        try { return decodeURIComponent(s.slice(`onvif://www.onvif.org/${kind}/`.length)); } catch { return s; }
      };
      return {
        endpoint: txt(m, 'Address'),
        xaddrs: txt(m, 'XAddrs').split(/\s+/).filter((u) => /^https?:\/\//i.test(u)),
        name: scope('name'),
        hardware: scope('hardware'),
        location: scope('location'),
      };
    }).filter((m) => m.xaddrs.length);
  },
});

/**
 * A stream URI with the camera's username and password put in, which is how every player opens an
 * authenticated RTSP stream. The stored URL is masked in every response like any other camera URL
 * (middleware/mask-stream-credentials.js).
 */
function withCredentials(uri, username, password) {
  if (!username) return uri;
  let u;
  try { u = new URL(uri); } catch { return uri; }
  if (!/^rtsps?:$/i.test(u.protocol)) return uri;
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(password || '');
  return u.toString();
}

module.exports = {
  NS, MAX_REPLY_BYTES, OnvifError,
  passwordDigest, securityHeader, envelope, body, probeMessage, parseReply, withCredentials, xmlEscape,
};
