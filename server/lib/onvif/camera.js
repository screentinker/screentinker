'use strict';

/*
 * One ONVIF camera, reached through a transport (lib/onvif/transport.js): the server directly, or a
 * screen on the camera's network.
 *
 *   connect()        clock offset, service addresses, device information
 *   profiles()       the camera's streams (main / sub...), each flagged when it can pan/tilt/zoom
 *   streamUri(t)     the RTSP address of a profile, with the credentials put in for the players
 *   snapshot(t)      a JPEG (or whatever the camera sends) of that profile, or null
 *   presets / move / stop / gotoPreset / home   PTZ on a profile that has it
 *
 * Authentication: the WS-Security UsernameToken on every call (the ONVIF way). When the camera
 * answers 401 with an HTTP Digest challenge as well, the call is repeated with both. The token's
 * Created time is the CAMERA's clock: ONVIF cameras refuse a token more than a few seconds off, so
 * connect() reads the camera's clock first (an unauthenticated call) and keeps the difference.
 */

const soap = require('./soap');
const digest = require('./http-digest');

const { OnvifError, body, parseReply } = soap;

/** A service address as the camera gave it, re-aimed at the host we actually reached it on. */
function reaim(serviceUrl, viaUrl) {
  if (!serviceUrl) return null;
  try {
    const s = new URL(serviceUrl);
    const v = new URL(viaUrl);
    // Cameras behind NAT, or with several interfaces, advertise addresses we may not reach. Keep the
    // service's own port and path (some cameras put services on another port), use our host.
    s.hostname = v.hostname;
    if (!s.port && v.port && s.protocol === v.protocol) s.port = v.port;
    return s.toString();
  } catch { return null; }
}

/** A stream/snapshot URI that names an address no screen can use (0.0.0.0, localhost) gets the camera's host. */
function fixLocalHost(uri, viaUrl) {
  try {
    const u = new URL(uri);
    if (['0.0.0.0', '127.0.0.1', 'localhost', '[::]', '[::1]'].includes(u.hostname)) u.hostname = new URL(viaUrl).hostname;
    return u.toString();
  } catch { return uri; }
}

class OnvifCamera {
  /**
   * @param {object} transport  serverTransport() or deviceTransport()
   * @param {object} opts       { xaddr, username, password, services?, timeOffsetMs? }
   */
  constructor(transport, { xaddr, username = '', password = '', services = null, timeOffsetMs = 0 } = {}) {
    let u;
    try { u = new URL(xaddr); } catch { throw new OnvifError('That is not a camera address', 'bad-address'); }
    if (!/^https?:$/.test(u.protocol)) throw new OnvifError('A camera address starts with http:// or https://', 'bad-address');
    this.transport = transport;
    this.xaddr = u.toString();
    this.username = username || '';
    this.password = password || '';
    this.services = services;
    this.timeOffsetMs = Number(timeOffsetMs) || 0;
  }

  auth() {
    if (!this.username) return null;
    const created = new Date(Date.now() + this.timeOffsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return { username: this.username, password: this.password, created };
  }

  /** POST one operation and return the reply XML (faults are thrown by the parse step). */
  async call(url, opBody, { anonymous = false } = {}) {
    const send = (headers) => this.transport.post(url, soap.envelope(opBody, anonymous ? null : this.auth()), headers);
    let r = await send({});
    if (r.status === 401 && !anonymous && this.username) {
      const challenge = digest.parseChallenge(r.headers['www-authenticate']);
      if (challenge) {
        const path = (() => { try { const u = new URL(url); return u.pathname + u.search; } catch { return '/'; } })();
        r = await send({ authorization: digest.authorization(challenge, { username: this.username, password: this.password, method: 'POST', uri: path }) });
      }
    }
    if (r.status === 401 || r.status === 403) throw new OnvifError('The camera refused the username or password', 'not-authorized');
    if (!r.body) throw new OnvifError(`The camera answered with HTTP ${r.status} and nothing else`, 'no-reply');
    return r.body;
  }

  /** Clock, services and identity. Returns what the dashboard shows about the camera. */
  async connect() {
    try {
      const camTime = parseReply.systemDateAndTime(await this.call(this.xaddr, body.getSystemDateAndTime(), { anonymous: true }));
      if (camTime) this.timeOffsetMs = camTime.getTime() - Date.now();
    } catch (e) {
      if (e.code === 'unreachable' || e.code === 'server-blocked' || /^screen-/.test(e.code || '')) throw e;
      // Some cameras demand authentication even for the clock: carry on with ours.
    }
    if (!this.services) {
      let s = null;
      try { s = parseReply.services(await this.call(this.xaddr, body.getServices())); } catch (e) { if (e.code === 'not-authorized') throw e; }
      if (!s || (!s.media && !s.media2)) s = parseReply.capabilities(await this.call(this.xaddr, body.getCapabilities()));
      this.services = {
        media: reaim(s.media, this.xaddr),
        media2: reaim(s.media2, this.xaddr),
        ptz: reaim(s.ptz, this.xaddr),
      };
      if (!this.services.media && !this.services.media2) throw new OnvifError('The camera has no media service, so it has no streams to offer', 'no-media');
    }
    let info = {};
    try { info = parseReply.deviceInformation(await this.call(this.xaddr, body.getDeviceInformation())); } catch (e) { if (e.code === 'not-authorized') throw e; }
    return { ...info, services: this.services, time_offset_ms: this.timeOffsetMs };
  }

  get media2() { return !this.services.media && !!this.services.media2; }
  get mediaUrl() { return this.services.media || this.services.media2; }

  async profiles() {
    const list = parseReply.profiles(await this.call(this.mediaUrl, body.getProfiles(this.media2)));
    if (!list.length) throw new OnvifError('The camera has no stream profiles', 'no-profiles');
    // A PTZ flag only means something when the camera has a PTZ service.
    return list.map((p) => ({ ...p, ptz: p.ptz && !!this.services.ptz }));
  }

  /** The RTSP address of a profile, with the username and password in it for the players. */
  async streamUri(token) {
    const uri = fixLocalHost(parseReply.uri(await this.call(this.mediaUrl, body.getStreamUri(this.media2, token))), this.xaddr);
    if (!/^rtsps?:\/\//i.test(uri)) throw new OnvifError('The camera offered a stream that is not RTSP', 'not-rtsp');
    return soap.withCredentials(uri, this.username, this.password);
  }

  async snapshotUri(token) {
    return fixLocalHost(parseReply.uri(await this.call(this.mediaUrl, body.getSnapshotUri(this.media2, token))), this.xaddr);
  }

  /**
   * The profile's snapshot as { buffer, type }, or null when the camera has none. Snapshot
   * addresses are plain HTTP and want Digest or Basic, depending on the camera.
   */
  async snapshot(token) {
    let uri;
    try { uri = await this.snapshotUri(token); } catch (e) { if (e.code === 'not-authorized') throw e; return null; }
    if (!/^https?:\/\//i.test(uri)) return null;
    let r = await this.transport.get(uri, {});
    if (r.status === 401 && this.username) {
      const challenge = digest.parseChallenge(r.headers['www-authenticate']);
      const u = new URL(uri);
      const authz = challenge
        ? digest.authorization(challenge, { username: this.username, password: this.password, method: 'GET', uri: u.pathname + u.search })
        : `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
      r = await this.transport.get(uri, { authorization: authz });
    }
    if (r.status !== 200 || !r.buffer || !r.buffer.length) return null;
    const type = String((r.headers || {})['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(type) && !isJpeg(r.buffer)) return null;
    return { buffer: r.buffer, type: /^image\//.test(type) ? type : 'image/jpeg' };
  }

  requirePtz() {
    if (!this.services.ptz) throw new OnvifError('This camera cannot pan, tilt or zoom', 'no-ptz');
    return this.services.ptz;
  }

  async presets(token) { return parseReply.presets(await this.call(this.requirePtz(), body.getPresets(token))); }
  async move(token, velocity, timeoutSec = 1) { return parseReply.ok(await this.call(this.requirePtz(), body.continuousMove(token, velocity, timeoutSec))); }
  async stop(token) { return parseReply.ok(await this.call(this.requirePtz(), body.stop(token))); }
  async gotoPreset(token, preset) { return parseReply.ok(await this.call(this.requirePtz(), body.gotoPreset(token, preset))); }
  async home(token) { return parseReply.ok(await this.call(this.requirePtz(), body.gotoHomePosition(token))); }
}

function isJpeg(buf) { return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff; }

/**
 * Cameras that answered a WS-Discovery Probe, one entry per camera (several replies or several
 * addresses for the same camera are merged). Each: { xaddr, xaddrs, name, hardware, location, from }.
 * IPv4 addresses are preferred: the IPv6 link-local ones cameras also advertise are rarely usable.
 */
async function discover(transport, { host = null, timeoutMs = 3000, port } = {}) {
  const replies = await transport.probe({ host, timeoutMs, ...(port ? { port } : {}) });
  const byKey = new Map();
  for (const r of replies) {
    for (const m of parseReply.probeMatches(r.xml)) {
      const key = m.endpoint || m.xaddrs[0];
      const prev = byKey.get(key);
      const xaddrs = [...new Set([...(prev ? prev.xaddrs : []), ...m.xaddrs])];
      byKey.set(key, { ...m, ...(prev || {}), xaddrs, from: (prev && prev.from) || r.from });
    }
  }
  return [...byKey.values()].map((m) => {
    const v4 = m.xaddrs.find((x) => { try { return /^\d+\.\d+\.\d+\.\d+$/.test(new URL(x).hostname); } catch { return false; } });
    return { xaddr: v4 || m.xaddrs[0], xaddrs: m.xaddrs, name: m.name, hardware: m.hardware, location: m.location, from: m.from };
  }).sort((a, b) => (a.name || a.xaddr).localeCompare(b.name || b.xaddr));
}

/**
 * What a person types ("192.168.1.20", "cam.local:8080", or a full device_service URL) as the
 * device service address most cameras use. The dashboard also offers WS-Discovery for the host.
 */
function xaddrFrom(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); if (u.pathname === '/' || !u.pathname) u.pathname = '/onvif/device_service'; return u.toString(); } catch { return null; }
  }
  if (!/^[a-z0-9.\-:[\]]+$/i.test(s)) return null;
  try { return new URL(`http://${s}/onvif/device_service`).toString(); } catch { return null; }
}

module.exports = { OnvifCamera, discover, xaddrFrom, reaim, fixLocalHost };
