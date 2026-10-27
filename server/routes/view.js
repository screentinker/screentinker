'use strict';

/*
 * View-only display access — the public side (lib/view-access.js has the rules).
 *
 *   GET /view/<token>                       the web player, in viewer mode, for the display the token names
 *   GET /view/screen/<display-id>           the same, without a token, only from the display's networks
 *   GET /api/view/t/<token>/payload         what that viewer polls
 *   GET /api/view/d/<display-id>/payload    ditto for the network path
 *
 * GET only, no session, nothing written: a viewer never becomes a device row, never counts toward a
 * plan, never appears in a list, never receives a command and never sends anything back. Every
 * answer is no-store, so turning access off or regenerating the link is felt on the very next poll.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db/database');
const viewAccess = require('../lib/view-access');
const nowPlaying = require('../lib/now-playing');

// One payload build per display per CACHE_MS, however many viewers poll it. Access is still decided
// on every request — only the expensive build is shared. Bounded: entries expire and are swept.
const CACHE_MS = 2000;
const cache = new Map();
function payloadFor(deviceId) {
  const now = Date.now();
  const hit = cache.get(deviceId);
  if (hit && now - hit.at < CACHE_MS) return hit;
  if (cache.size > 500) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  // The GATED builder, as the screen gets it: a suspended screen shows its suspended card here too.
  const { buildPlaylistPayload } = require('../ws/deviceSocket');
  const payload = viewAccess.sanitizeForViewer(buildPlaylistPayload(deviceId));
  const entry = { at: now, payload, rev: viewAccess.revOf(payload) };
  cache.set(deviceId, entry);
  return entry;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  // The token is in the URL; media and widget requests must not carry it to anyone in a Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

const UNAVAILABLE_HTML = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>View not available</title></head><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;'
  + 'background:#111827;color:#e5e7eb;font:18px sans-serif;text-align:center;padding:24px;box-sizing:border-box">'
  + '<div>This view is not available.</div></body></html>';

module.exports = function viewRoutes({ sendPlayer }) {
  const router = express.Router();

  function page(req, res, by, payloadPath) {
    noStore(res);
    const r = viewAccess.resolve(db, req, by);
    if (!r.device) return res.status(r.status).type('html').send(UNAVAILABLE_HTML);
    // ?legacy=1 serves the ES5 build for old browsers, exactly as /player/legacy does for screens.
    const file = req.query.legacy === '1' ? 'legacy.html' : 'index.html';
    sendPlayer(res, file, { viewer: { payload_url: payloadPath, poll_ms: viewAccess.POLL_MS } });
  }

  function payload(req, res, by) {
    noStore(res);
    const r = viewAccess.resolve(db, req, by);
    if (!r.device) return res.status(r.status).json({ error: 'This view is no longer available', available: false });
    const { payload: body, rev } = payloadFor(r.device.id);
    // Visitor audio sync: enrich each now_playing entry with the language tracks offered for the item
    // currently on screen, so a visitor's phone can pick a language and play it in sync. Viewer-only:
    // this never touches the player payload, so it cannot change the structural player fingerprint.
    const audioTracks = require('../lib/content-audio-tracks');
    const now_playing = nowPlaying.forDevice(r.device.id).map((e) => {
      const tracks = e && e.content_id ? audioTracks.tracksForViewer(e.content_id) : [];
      return tracks.length ? { ...e, audio_tracks: tracks } : e;
    });
    const out = { rev, server_ms: Date.now(), now_playing, poll_ms: viewAccess.POLL_MS };
    if (req.query.rev === rev) out.unchanged = true;
    else out.payload = body;
    res.json(out);
  }

  router.get('/view/screen/:id', (req, res) => page(req, res, { deviceId: req.params.id }, `/api/view/d/${encodeURIComponent(req.params.id)}/payload`));
  router.get('/view/:key', (req, res) => page(req, res, { token: req.params.key }, `/api/view/t/${encodeURIComponent(req.params.key)}/payload`));
  router.get('/api/view/:kind/:key/payload', (req, res) => {
    if (req.params.kind === 't') return payload(req, res, { token: req.params.key });
    if (req.params.kind === 'd') return payload(req, res, { deviceId: req.params.key });
    noStore(res);
    return res.status(404).json({ error: 'Not found' });
  });

  // Visitor audio guide: an audio-only page that plays the per-language narration for whatever is on
  // this screen, in sync, via the same poll the viewer player uses. Gated like /view; the page holds
  // no secrets (its token stays in the URL and the payload endpoint re-checks it on every poll).
  function listen(req, res, by) {
    noStore(res);
    const r = viewAccess.resolve(db, req, by);
    if (!r.device) return res.status(r.status).type('html').send(UNAVAILABLE_HTML);
    fs.readFile(path.join(__dirname, '..', 'listen', 'index.html'), (err, html) => {
      if (err) return res.status(500).type('text/plain').send('audio guide unavailable');
      res.type('html').send(html);
    });
  }
  router.get('/listen/screen/:id', (req, res) => listen(req, res, { deviceId: req.params.id }));
  router.get('/listen/:key', (req, res) => listen(req, res, { token: req.params.key }));

  return router;
};

module.exports.__resetCache = () => cache.clear();
