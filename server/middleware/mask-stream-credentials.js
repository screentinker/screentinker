'use strict';
/*
 * ⚠️ CAMERA SECRETS NEVER LEAVE THE SERVER EXCEPT TO THE SCREEN THAT OPENS THE STREAM.
 *
 * An rtsp(s) item's URL may carry the camera's password, or a share token in its path (UniFi
 * Protect), see lib/remote-url.js. Every JSON response is passed through maskStreamCredentials,
 * which replaces them with CREDENTIAL_MASK wherever an rtsp/rtsps URL appears: content rows, playlist
 * items, device assignments, previews, search, MCP tool results (JSON inside a string), /view
 * payloads.
 *
 * The one exception is a request authenticated by a DEVICE token (req.device, set by
 * middleware/deviceTokenAuth.js or routes/embedded.js): that is the screen itself, which needs the
 * real URL to connect. Players otherwise get their playlist over the device socket, which never
 * goes through here.
 *
 * Masking works on each string VALUE, never on the serialized JSON: a URL is stored as typed, so a
 * password can hold a quote or a space, and in JSON text those are escaped apart from the URL. A
 * string that is itself JSON (an MCP tool result) is parsed and walked the same way.
 *
 * An ONVIF camera's password (content.onvif_secret, encrypted) is DROPPED from every response,
 * device-token ones included: nothing outside the server needs it, not even the screen.
 *
 * Cheap when there is nothing to do: the body is serialized once (as res.json would) and only
 * walked when it contains "rtsp" or an onvif_secret key.
 */
const { maskStreamCredentials } = require('../lib/remote-url');

const HAS_RTSP = /rtsps?:\/\//i;
const SECRET_KEYS = new Set(['onvif_secret']);
const HAS_SECRET_KEY = /"onvif_secret"/;

function maskString(s) {
  if (!HAS_RTSP.test(s)) return s;
  const t = s.trim();
  if (t[0] === '{' || t[0] === '[') {
    let inner;
    try { inner = JSON.parse(t); } catch (_) { inner = undefined; }
    if (inner !== undefined && inner !== null && typeof inner === 'object') return JSON.stringify(maskDeep(inner));
  }
  return maskStreamCredentials(s);
}

// `v` is plain parsed JSON (the body after the app's replacer and toJSON), so it has no cycles.
function maskDeep(v) {
  if (typeof v === 'string') return maskString(v);
  if (Array.isArray(v)) return v.map(maskDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (!SECRET_KEYS.has(k)) out[k] = maskDeep(v[k]);
    return out;
  }
  return v;
}

function dropSecrets(v) {
  if (Array.isArray(v)) return v.map(dropSecrets);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (!SECRET_KEYS.has(k)) out[k] = dropSecrets(v[k]);
    return out;
  }
  return v;
}

function maskStreamCredentialsMiddleware(req, res, next) {
  const json = res.json;
  res.json = function maskedJson(body) {
    const app = req.app;
    const replacer = app ? app.get('json replacer') : undefined;
    const spaces = app ? app.get('json spaces') : undefined;
    let text;
    try { text = JSON.stringify(body, replacer, spaces); } catch (_) { return json.call(this, body); }
    if (text === undefined) return json.call(this, body);
    const secret = HAS_SECRET_KEY.test(text);
    if (req.device ? !secret : (!secret && !HAS_RTSP.test(text))) return json.call(this, body);
    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json; charset=utf-8');
    // A screen gets its real camera URLs; only the ONVIF secret is taken out of what it receives.
    const out = req.device ? dropSecrets(JSON.parse(text)) : maskDeep(JSON.parse(text));
    return this.send(JSON.stringify(out, null, spaces));
  };
  next();
}

module.exports = { maskStreamCredentialsMiddleware, maskDeep };
