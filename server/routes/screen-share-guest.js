'use strict';
/*
 * 3.0: screen share — the meeting-room (guest) side. No account, by design: a visitor in the room
 * types the code the screen is showing (or scans its QR) on /share and presents their laptop.
 *
 *   POST /api/share/join  { code, name?, audio? }  -> a single-use ticket, exactly like a signed-in start
 *                                                    (plus `legs`/`share_id` when the display has mirrors:
 *                                                    the code shows on them too, and the share reaches them)
 *
 * What stops this being an open door onto every screen (docs/screen-share.md, "Abuse"):
 *   - the code exists only on the screen itself and in this process's memory — no API returns it,
 *     so only someone who can SEE the screen can use it;
 *   - it is 8 characters of a 32-symbol alphabet (40 bits), changes every ten minutes, and is spent
 *     by the first successful join (the screen shows a new one at once);
 *   - joins are rate-limited per address in server.js;
 *   - the screen must have the code switched on by a workspace admin (off by default), the workspace
 *     and the server must allow sharing, and the screen must have a free slot (one, unless an admin
 *     lets several people present at once — each join still spends the code);
 *   - an editor can stop a guest from the dashboard, and every join is in the activity log with the
 *     name the guest gave and their address.
 * A wrong, expired or spent code gets one generic answer, so the endpoint does not say which.
 */
const express = require('express');
const router = express.Router();
router.use(require('../lib/backstop-limiter'));
const { db } = require('../db/database');
const share = require('../lib/screen-share');

router.post('/join', express.json({ limit: '4kb' }), (req, res) => {
  if (!share.featureOn()) return res.status(404).json({ error: 'Screen sharing is not available on this server', reason: 'disabled' });
  const body = req.body || {};
  const deviceId = share.redeemCode(body.code);
  if (!deviceId) return res.status(404).json({ error: 'That code is not valid. Check the code on the screen and try again.', reason: 'invalid_code' });
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId);
  const ws = device && device.workspace_id ? db.prepare('SELECT * FROM workspaces WHERE id = ?').get(device.workspace_id) : null;
  // The code was spent above; whatever happens next, the screen shows a fresh one.
  const answer = (status, payload) => { share.pushCode(deviceId); return res.status(status).json(payload); };
  if (!device || !ws || !device.screen_share_guest) return answer(404, { error: 'That code is not valid. Check the code on the screen and try again.', reason: 'invalid_code' });
  const avail = share.availability(device, ws);
  if (!avail.ok) return answer(409, { error: 'This screen cannot take a share right now', reason: avail.reason });
  // The code is the display's, shown on its mirrors too: whichever of them the guest read it from,
  // the share goes to the display and every mirror that can take it (lib/screen-share.js
  // withMirrors — same workspace only, best-effort, never a reason to refuse).
  const plan = share.withMirrors(device, ws);
  const { out } = share.createDisplayShare(plan, {
    // Nameless guests in a room several people can share to are numbered ("Guest 2"), so the tiles
    // and the owner's list tell them apart.
    sharedBy: share.cleanName(body.name, '') || (share.slotsFor(device.id) > 1 ? share.guestName(device.id) : 'Guest'),
    userId: null, guest: true, ip: req.ip, audio: !!body.audio,
    // What they are showing (their screen, a phone camera, the Android app): for the activity log.
    source: ['screen', 'camera', 'app'].includes(body.source) ? body.source : undefined,
  });
  if (out.error) return answer(409, { error: 'Someone is already sharing to this screen', reason: 'busy' });
  // A guest has no account in the workspace: the legs carry no device ids, and which mirrors were
  // left out (and why) is not theirs to know, nor is the org's TURN login (STUN only, unless the
  // TURN credentials are short-lived). The page keys legs by session id.
  const b = share.displayShareBody(out, [], true);
  b.legs = b.legs.map(({ device_id: _omit, ...leg }) => leg);
  delete b.skipped;
  res.status(201).json(b);
});

module.exports = router;
