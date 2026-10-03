'use strict';

const { logActivity } = require('../../services/activity');

/*
 * WHAT ANOTHER SERVER DID TO THIS ONE — written where the child can read it.
 *
 * The customer's question is the simplest one in the whole feature and it had no answer: *what has
 * this hub actually done to my screens?* mesh_write_ops looks like it should answer it and cannot —
 * it is an idempotency ledger (edge, op id, target, outcome) with no path, no method, no actor and
 * no record of the request, and nothing reads it. So a customer could grant write access and then
 * have no way to find out what was done with it.
 *
 * ⚠️ REFUSALS ARE RECORDED TOO, and they are the more important half. "Somebody tried to change my
 * screens and was told no" is exactly what an operator wants to see after they narrow a grant, and
 * the auto-logger cannot supply it: it only fires on 2xx, and a mesh refusal never reaches Express
 * at all. An audit that shows only what succeeded describes a relationship as it was permitted, not
 * as it was attempted.
 *
 * ⚠️ THE ACTOR IS AN UNVERIFIABLE CLAIM AND IS LABELLED AS ONE. The hub says which of its people
 * asked; this node cannot check that and must never act on it. It is recorded because "your MSP
 * changed this" is much less useful than "Priya at your MSP changed this" when somebody is trying
 * to work out what happened — but it is written as a claim so nobody later mistakes it for an
 * authenticated identity. Anything a peer sends about itself is evidence, not proof.
 *
 * ⚠️ acting_user_id STAYS NULL. It is `TEXT REFERENCES users(id)`, and a person on another server
 * has no row in this one — the foreign key would reject the insert and the audit row would be lost
 * entirely. That is precisely how a break-glass session went unrecorded for months here. The flag
 * `was_acting_as` still says somebody else was behind it, and the identity goes in the text.
 */

/** Trim and bound anything a peer sent about itself before it is stored or displayed. */
function claim(v, max = 120) {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[\r\n\t]+/g, ' ');
  return s ? s.slice(0, max) : null;
}

/**
 * Describe the peer, in the form an operator reads on their own page.
 *
 * Prefers the name they chose at pairing over the node id — an operator recognises "Acme HQ", not
 * a uuid — but always carries enough of the id to tell two links apart.
 */
function describePeer(edge) {
  const name = claim(edge && edge.peer_name);
  const id = String((edge && edge.peer_node_id) || 'unknown');
  return name ? `${name} (${id.slice(0, 8)})` : `server ${id.slice(0, 8)}`;
}

function describeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  const who = claim(actor.name) || claim(actor.email);
  return who || null;
}

/**
 * Record one thing a peer asked this node to do.
 *
 * @param {object} db
 * @param {object} edge      the edge it arrived on — the ONLY trustworthy identity here
 * @param {object} entry
 * @param {string} entry.action   short verb, e.g. 'mesh:write' / 'mesh:content-push'
 * @param {string} [entry.path]
 * @param {string} [entry.method]
 * @param {boolean} entry.ok
 * @param {string} [entry.reason] why it was refused, when it was
 * @param {object} [entry.actor]  the peer's CLAIM about which of its people asked
 * @param {string} [entry.workspaceId]
 * @param {string} [entry.userId] the local principal the change was applied as
 */
function recordPeerAction(db, edge, entry = {}) {
  const peer = describePeer(edge);
  const who = describeActor(entry.actor);
  const verb = entry.ok ? 'applied' : 'refused';

  const parts = [`${peer} — ${verb}`];
  if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`);
  // ⚠️ "reported by that server" is not decoration. It is the difference between an audit line a
  // reader can rely on and one they might mistake for something this node verified.
  if (who) parts.push(`asked by ${who} (reported by that server, not verified here)`);
  if (!entry.ok && entry.reason) parts.push(`reason: ${claim(entry.reason, 200)}`);

  try {
    logActivity(
      entry.userId || null,
      entry.action || 'mesh:write',
      parts.join(' · '),
      null,
      // No IP: the request arrived over an established socket, not an HTTP connection, and putting
      // the socket's address here would describe the transport rather than the caller.
      null,
      entry.workspaceId || null,
    );
    /*
     * The impersonation flag, set on the row we just wrote. logActivity does not take it — it is
     * about a shape it was never built for — and adding a parameter for one caller would push a
     * mesh concept into the generic audit writer. The row is ours and was written a moment ago.
     */
    db.prepare(`UPDATE activity_log SET was_acting_as = 1
                 WHERE id = (SELECT MAX(id) FROM activity_log)
                   AND action = ?`).run(entry.action || 'mesh:write');
  } catch (e) {
    // Deliberately not rethrown: failing to WRITE the audit must not fail the operation it audits,
    // and logActivity is already loud about its own failures.
  }
}

module.exports = { recordPeerAction, describePeer, describeActor };
