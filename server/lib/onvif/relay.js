'use strict';

/*
 * A screen as the ONVIF bridge for cameras on its own network (the hosted server can't reach a
 * customer's LAN, the screen can).
 *
 * The server keeps ALL the ONVIF logic (lib/onvif/soap.js, camera.js). The screen is a narrow relay
 * that does exactly three things on its LAN and returns the bytes:
 *
 *   probe  send the fixed WS-Discovery Probe (multicast, or one host's :3702) and collect replies;
 *   soap   POST a SOAP envelope to a private-network http(s) address;
 *   get    GET an image (a snapshot) from a private-network http(s) address.
 *
 * The players enforce the same limits independently (private addresses only, size caps, timeouts),
 * so a server can never use a screen as a general web proxy. `onvif_relay` is NOT in the REST
 * command allowlist: only this module sends it, never queued, never to an offline screen.
 *
 * Request -> reply: deliverCommand() emits `device:command {type:'onvif_relay', payload:{id,...}}`;
 * the screen answers `device:onvif-result {id, ...}` (ws/deviceSocket.js), handled by handleResult.
 */

const crypto = require('crypto');
const { OnvifError } = require('./soap');

const pending = new Map();   // id -> { deviceId, resolve, reject, timer }

/** Limits a screen's reply is held to here too, whatever the screen itself enforced. */
const MAX_TEXT = 1024 * 1024;                 // a SOAP reply
const MAX_IMAGE_B64 = Math.ceil((2 * 1024 * 1024) * 4 / 3) + 8;   // a 2 MB snapshot, like a screenshot
const MAX_PROBE_REPLIES = 64;

/**
 * Ask `device` to do one relay operation and wait for its answer.
 * @returns {Promise<object>} the screen's result: {ok, status?, headers?, body?, body_b64?, replies?, error?}
 */
function request(deviceNs, device, op, timeoutMs = 10000) {
  const { deliverCommand } = require('../device-command');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new OnvifError(`The screen "${device.name || device.id}" did not answer in time`, 'screen-timeout'));
    }, timeoutMs + 2000);   // the screen's own deadline is timeoutMs; allow for the round trip
    pending.set(id, { deviceId: device.id, resolve, reject, timer });
    let r;
    try {
      r = deliverCommand(deviceNs, device, 'onvif_relay', { ...op, id, timeout_ms: timeoutMs });
    } catch (e) {
      r = { status: 'error', error: e.message };
    }
    if (r.status === 'sent') return;
    clearTimeout(timer);
    pending.delete(id);
    const name = device.name || device.id;
    if (r.status === 'unsupported') reject(new OnvifError(`The screen "${name}" can't search for cameras (it needs a newer player)`, 'screen-unsupported'));
    else if (r.status === 'relayed') reject(new OnvifError(`The screen "${name}" is connected to another server node; try again in a moment`, 'screen-elsewhere'));
    else if (r.status === 'refused') reject(new OnvifError(r.error || 'Not allowed on this screen', 'screen-refused'));
    else reject(new OnvifError(`The screen "${name}" is offline`, 'screen-offline'));
  });
}

/** A screen's `device:onvif-result`. Ignored unless it answers a request made to THAT screen. */
function handleResult(deviceId, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return false;
  const p = pending.get(msg.id);
  if (!p || p.deviceId !== deviceId) return false;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  const out = { ok: msg.ok === true };
  if (Number.isInteger(msg.status)) out.status = msg.status;
  if (msg.headers && typeof msg.headers === 'object') {
    out.headers = {};
    for (const k of ['www-authenticate', 'content-type']) {
      const v = msg.headers[k];
      if (typeof v === 'string') out.headers[k] = v.slice(0, 2048);
      else if (Array.isArray(v)) out.headers[k] = v.filter((x) => typeof x === 'string').slice(0, 4).map((x) => x.slice(0, 2048));
    }
  }
  if (typeof msg.body === 'string') out.body = msg.body.slice(0, MAX_TEXT);
  if (typeof msg.body_b64 === 'string' && msg.body_b64.length <= MAX_IMAGE_B64) out.body_b64 = msg.body_b64;
  if (Array.isArray(msg.replies)) {
    out.replies = msg.replies.filter((x) => x && typeof x.xml === 'string')
      .slice(0, MAX_PROBE_REPLIES).map((x) => ({ from: String(x.from || '').slice(0, 64), xml: x.xml.slice(0, 64 * 1024) }));
  }
  if (typeof msg.error === 'string') out.error = msg.error.slice(0, 300);
  p.resolve(out);
  return true;
}

/** For tests and shutdown. */
function _pendingCount() { return pending.size; }

module.exports = { request, handleResult, _pendingCount };
