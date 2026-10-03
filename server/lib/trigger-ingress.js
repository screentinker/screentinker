'use strict';

/*
 * Server-side LAN trigger ingress — the door for players that cannot open one themselves.
 *
 * ⚠️ WHY THIS EXISTS. Triggers are deliberately player-side: a datagram hits the panel directly, so
 * an alarm works with the WAN down. That requires the player to bind a socket, which requires a
 * Node context — and on BrightSign's server-on-a-player build the widget is created WITHOUT
 * nodejs_enabled (brightsign/server/autorun.brs, and for good reasons documented there). The player
 * runs in an iframe with no `require`, so `dgram` and raw `http` both throw and the listeners never
 * start. Measured on an XT245: trigger ports closed, fires impossible, and nothing but an info-level
 * log to say so. Enabling triggers on such a device did nothing at all.
 *
 * The server on that same box IS real Node. It can hold the door open and hand what arrives to the
 * player over the socket they already share. On a server-on-a-player that keeps the offline
 * guarantee completely intact — server and player are the same board, so there is no network
 * between them to lose. It also helps any site where the control system can reach the server but
 * not each panel.
 *
 * ⚠️ THE PLAYER STILL DECIDES. This module resolves only WHICH DEVICE a payload is addressed to,
 * by its secret, and forwards the wire text verbatim. The accept/reject decision stays in the one
 * resolver both sides already share, so there is no second implementation of "may this fire" to
 * drift from the first. That is the same "one decision, two doors" rule trigger-resolve.js states —
 * this is simply a third door onto the same decision.
 *
 * ⚠️ AND IT IS OFF UNLESS ASKED FOR. Opening an unauthenticated LAN port on the SERVER is a
 * different security posture from opening one on a panel, so it is opt-in per instance and still
 * gated per device by the same accept_http / accept_udp flags an operator already sets.
 */

const TR = require('./trigger-resolve');

/**
 * Which device is this payload for?
 *
 * @param {string} text      the raw wire line (`ST1 <secret> <token>`)
 * @param {Array}  devices   rows with { id, trigger_secret, triggers_accept_http, triggers_accept_udp }
 * @param {string} source    'http' | 'udp'
 * @returns {{ok: true, deviceId: string} | {ok: false, reason: string}}
 */
function resolveTarget(text, devices, source) {
  const parsed = TR.parseWire(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason || 'malformed' };

  /*
   * ⚠️ EVERY CANDIDATE IS COMPARED, AND THE LOOP DOES NOT BREAK EARLY.
   *
   * Returning as soon as a secret matches makes the reply time depend on where the device sits in
   * the list, which leaks list position to anyone who can time it. The comparison itself is already
   * constant-time (TR.secretMatches); finishing the sweep keeps the whole operation that way. A
   * fleet is small enough that the cost is nothing.
   */
  let hit = null;
  for (const d of devices || []) {
    if (!d || !d.trigger_secret) continue;
    const accepts = source === 'udp' ? d.triggers_accept_udp : d.triggers_accept_http;
    if (!accepts) continue;
    if (TR.secretMatches(parsed.secret, String(d.trigger_secret))) {
      if (!hit) hit = d.id;
    }
  }

  /*
   * ⚠️ ONE REJECTION REASON FOR "no such device". Distinguishing "no device has that secret" from
   * "that device does not accept this transport" would turn the door into an oracle for enumerating
   * both secrets and configuration. The caller answers identically either way.
   */
  if (!hit) return { ok: false, reason: 'bad_secret' };
  return { ok: true, deviceId: hit };
}

/**
 * Accept the shapes a control system can actually emit.
 *
 * ⚠️ THE SAME FOUR AS THE PLAYER'S OWN DOOR (docs/triggers-design.md §11), because an integrator
 * should not have to know which kind of box is behind the address. AMX cannot set a header;
 * Extron's Global Scripter cannot open a socket at all but can build a URL. A POST-JSON-only
 * endpoint is unreachable from both.
 */
function extractWire(req) {
  const q = req.query || {};
  if (typeof q.m === 'string' && q.m) return q.m;
  if (typeof q.secret === 'string' && typeof q.token === 'string') {
    return `${TR.MAGIC} ${q.secret} ${q.token}`;
  }
  const b = req.body;
  if (typeof b === 'string' && b.trim()) return b;
  if (b && typeof b === 'object') {
    if (typeof b.secret === 'string' && typeof b.token === 'string') {
      return `${TR.MAGIC} ${b.secret} ${b.token}`;
    }
  }
  return '';
}

module.exports = { resolveTarget, extractWire };
