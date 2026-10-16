'use strict';
/*
 * ⚠️ CAMERA PASSWORDS NEVER LEAVE THE SERVER EXCEPT TO THE SCREEN THAT OPENS THE STREAM.
 *
 * An rtsp(s) item's URL may carry the camera's username and password (lib/remote-url.js). Every
 * JSON response is passed through maskStreamCredentials, which replaces the password with
 * CREDENTIAL_MASK wherever an rtsp/rtsps URL appears: content rows, playlist items, device
 * assignments, previews, search, MCP tool results (JSON inside a string), /view payloads.
 *
 * The one exception is a request authenticated by a DEVICE token (req.device, set by
 * middleware/deviceTokenAuth.js or routes/embedded.js): that is the screen itself, which needs the
 * real URL to connect. Players otherwise get their playlist over the device socket, which never
 * goes through here.
 *
 * Cheap when there is nothing to do: the body is serialized once (as res.json would) and only
 * rewritten when it contains "rtsp".
 */
const { maskStreamCredentials } = require('../lib/remote-url');

function maskStreamCredentialsMiddleware(req, res, next) {
  const json = res.json;
  res.json = function maskedJson(body) {
    if (req.device) return json.call(this, body);
    const app = req.app;
    const replacer = app ? app.get('json replacer') : undefined;
    const spaces = app ? app.get('json spaces') : undefined;
    let text;
    try { text = JSON.stringify(body, replacer, spaces); } catch (_) { return json.call(this, body); }
    if (text === undefined || !/rtsps?:\/\//i.test(text)) return json.call(this, body);
    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json; charset=utf-8');
    return this.send(maskStreamCredentials(text));
  };
  next();
}

module.exports = { maskStreamCredentialsMiddleware };
