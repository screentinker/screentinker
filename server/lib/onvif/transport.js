'use strict';

/*
 * How the server's ONVIF code (camera.js) reaches a camera. Two transports, one interface:
 *
 *   post(url, xml, headers)      -> { status, headers, body }      a SOAP request
 *   get(url, headers, maxBytes)  -> { status, headers, buffer }    a snapshot image
 *   probe({ host, timeoutMs })   -> [ { from, xml } ]               WS-Discovery replies
 *
 * serverTransport()  this server, directly. Every address goes through the outbound guard
 *                    (lib/ssrf-guard.js), so it only works where the operator opened private
 *                    networks (OUTBOUND_ALLOW_PRIVATE / OUTBOUND_ALLOW_HOSTS): a self-hosted server
 *                    on the cameras' network.
 * deviceTransport()  a screen on the cameras' network, through lib/onvif/relay.js.
 */

const dgram = require('dgram');
const dns = require('dns').promises;
const net = require('net');
const { guardedRequest, GuardedRequestError, SsrfError, isBlockedFor, privateNetworkAccess, privateAddressHint } = require('../ssrf-guard');
const { OnvifError, MAX_REPLY_BYTES } = require('./soap');
const relay = require('./relay');

const SOAP_TYPE = 'application/soap+xml; charset=utf-8';
const DISCOVERY_ADDR = '239.255.255.250';
const DISCOVERY_PORT = 3702;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function lower(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}

function mapGuardError(e) {
  if (e instanceof OnvifError) return e;
  if (e && (e instanceof SsrfError || e.name === 'SsrfError')) {
    return new OnvifError(`This server can't reach that camera. ${privateAddressHint()}`, 'server-blocked');
  }
  if (e && e.code === 'timeout') return new OnvifError('The camera did not answer in time', 'unreachable');
  if (e && e.code === 'size-limit') return new OnvifError('The camera sent a reply too large to read', 'too-large');
  if (e instanceof GuardedRequestError) return new OnvifError(`Couldn't reach the camera: ${e.message}`, 'unreachable');
  return new OnvifError(`Couldn't reach the camera: ${e && e.message ? e.message : e}`, 'unreachable');
}

function serverTransport() {
  return {
    via: 'server',
    async post(url, xml, headers = {}) {
      try {
        const r = await guardedRequest(url, {
          method: 'POST', body: xml, headers: { 'content-type': SOAP_TYPE, ...headers },
          timeoutMs: 8000, maxBytes: MAX_REPLY_BYTES, responseType: 'text', acceptAnyStatus: true, maxRedirects: 0,
        });
        return { status: r.statusCode, headers: lower(r.headers), body: r.text || '' };
      } catch (e) { throw mapGuardError(e); }
    },
    async get(url, headers = {}, maxBytes = MAX_SNAPSHOT_BYTES) {
      try {
        const r = await guardedRequest(url, {
          method: 'GET', headers, timeoutMs: 8000, maxBytes, responseType: 'buffer', acceptAnyStatus: true, maxRedirects: 2,
        });
        return { status: r.statusCode, headers: lower(r.headers), buffer: r.buffer || Buffer.alloc(0) };
      } catch (e) { throw mapGuardError(e); }
    },
    async probe({ host = null, timeoutMs = 3000, port = DISCOVERY_PORT } = {}) {
      let target = DISCOVERY_ADDR;
      if (host) {
        const addr = net.isIP(host) ? host : (await dns.lookup(host).catch(() => null) || {}).address;
        if (!addr) throw new OnvifError(`Couldn't find "${host}" on the network`, 'unreachable');
        if (isBlockedFor(addr, host)) throw new OnvifError(`This server can't reach that camera. ${privateAddressHint()}`, 'server-blocked');
        target = addr;
      } else if (privateNetworkAccess() !== true) {
        throw new OnvifError(`This server can't search its network for cameras. ${privateAddressHint()}`, 'server-blocked');
      }
      return udpProbe(target, timeoutMs, port);
    },
  };
}

/** Send the Probe to `target`:3702 and collect every reply until the deadline. */
function udpProbe(target, timeoutMs, port = DISCOVERY_PORT) {
  const { probeMessage } = require('./soap');
  return new Promise((resolve) => {
    const replies = [];
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch { /* closed */ } resolve(replies); };
    sock.on('message', (msg, rinfo) => {
      if (replies.length < 64 && msg.length <= 64 * 1024) replies.push({ from: rinfo.address, xml: msg.toString('utf8') });
    });
    sock.on('error', finish);
    sock.bind(0, () => {
      try { if (target === DISCOVERY_ADDR) sock.setMulticastTTL(1); } catch { /* not fatal */ }
      const buf = Buffer.from(probeMessage(), 'utf8');
      // Twice, a moment apart: UDP is lossy and many cameras answer a second Probe more reliably.
      sock.send(buf, port, target, () => {});
      setTimeout(() => { if (!done) sock.send(buf, port, target, () => {}); }, 300);
    });
    setTimeout(finish, Math.max(500, Math.min(10000, timeoutMs)));
  });
}

/** `deviceNs` is the /device socket namespace; `device` the screen's row. */
function deviceTransport(deviceNs, device) {
  const fail = (r, what) => {
    throw new OnvifError(r.error ? `${what}: ${r.error}` : what, 'unreachable');
  };
  return {
    via: device.id,
    async post(url, xml, headers = {}) {
      const r = await relay.request(deviceNs, device, { op: 'soap', url, body: xml, headers: { 'content-type': SOAP_TYPE, ...headers } });
      if (!r.ok && !Number.isInteger(r.status)) fail(r, `The screen couldn't reach the camera`);
      return { status: r.status, headers: r.headers || {}, body: r.body || '' };
    },
    async get(url, headers = {}) {
      const r = await relay.request(deviceNs, device, { op: 'get', url, headers });
      if (!r.ok && !Number.isInteger(r.status)) fail(r, `The screen couldn't fetch the snapshot`);
      return { status: r.status, headers: r.headers || {}, buffer: r.body_b64 ? Buffer.from(r.body_b64, 'base64') : Buffer.alloc(0) };
    },
    async probe({ host = null, timeoutMs = 3000 } = {}) {
      const r = await relay.request(deviceNs, device, { op: 'probe', ...(host ? { host } : {}) }, timeoutMs);
      if (!r.ok && !r.replies) fail(r, `The screen couldn't search its network`);
      return r.replies || [];
    },
  };
}

module.exports = { serverTransport, deviceTransport, udpProbe, MAX_SNAPSHOT_BYTES, DISCOVERY_PORT };
