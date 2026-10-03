'use strict';

/*
 * Who may grant a write, and where that decision is stored.
 *
 * ⚠️ THE DEFECT THIS EXISTS TO PREVENT: `mesh_edges.grant_categories` is authored by the PARENT.
 * It mints a pairing code naming what the code grants, and the child stores that answer verbatim.
 * For reads that is defensible — every read category is read-only by construction. Carried to
 * writes it inverts the model completely: the parent writes its own permission into the child's
 * database, and the child then enforces it faithfully. That is worse than no enforcement, because
 * the child's own consent view would look correct while being false.
 *
 * So write lives in its own columns, written by exactly one route, which is authenticated on the
 * node whose screens would change.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-meshwrite-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const grants = require('../lib/mesh/grants');
const { consentView } = require('../lib/mesh/edge-status');

const id = () => crypto.randomUUID();
let wsA, wsB;

before(() => {
  const u = id(); const org = id();
  db.prepare('INSERT INTO users (id,email,name,password_hash) VALUES (?,?,?,?)').run(u, `w-${u}@e.com`, 'W', 'x');
  db.prepare(`INSERT INTO organizations (id,name,owner_user_id,created_at,updated_at)
              VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(org, 'Org', u);
  wsA = id(); wsB = id();
  for (const [w, n] of [[wsA, 'A'], [wsB, 'B']]) {
    db.prepare(`INSERT INTO workspaces (id,organization_id,name,created_at,updated_at)
                VALUES (?,?,?,strftime('%s','now'),strftime('%s','now'))`).run(w, org, n);
  }
});

const mkEdge = (cols = {}) => {
  const e = id();
  db.prepare(`INSERT INTO mesh_edges (id, peer_node_id, direction, role_capabilities, grant_categories,
              transport_direction, tls_verify, created_at, write_grant, write_scope)
              VALUES (?,?,'up','[]',?, 'we-dial',1,strftime('%s','now'),?,?)`)
    .run(e, id(), JSON.stringify(cols.grant || ['health']),
         cols.write_grant === undefined ? null : JSON.stringify(cols.write_grant),
         cols.write_scope === undefined ? null : JSON.stringify(cols.write_scope));
  return db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(e);
};

test('⚠️ an edge that already exists has NO write — an upgrade changes nothing', () => {
  // The migration rule: everything already linked keeps working exactly as it does today, which
  // means read-only. Write is never acquired by upgrading; only by somebody here saying yes.
  const edge = mkEdge({ grant: ['health', 'identity'] });
  assert.equal(edge.write_grant, null, 'a pre-existing edge must have no write grant');
  assert.equal(edge.write_scope, null);

  const view = consentView({ ...edge, grant_categories: ['health', 'identity'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
  assert.deepEqual(view.writeGrant, []);
});

test('⚠️ the consent view REPORTS a granted write instead of asserting false', () => {
  /*
   * parentCanControlThisNode was the literal `false`. Once a write can be granted, a hardcoded
   * false assures an operator that nobody can touch their screens — on the very page where they
   * granted exactly that. A consent view that cannot report what it exists to report is worse than
   * none, because it is believed.
   */
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [wsA] });
  const view = consentView({ ...edge, grant_categories: ['health'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, true);
  assert.deepEqual(view.writeGrant, ['content-push']);
  assert.deepEqual(view.writeWorkspaces, [wsA]);
  assert.match(view.writeGrantExplained.join(' '), /change what plays/i,
    'the consequence must be in words the operator can evaluate, not a category name');
});

test('a malformed write column reads as NO write, never as unrestricted', () => {
  const edge = mkEdge();
  db.prepare('UPDATE mesh_edges SET write_grant = ?, write_scope = ? WHERE id = ?')
    .run('{not json', 'also not json', edge.id);
  const row = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
  const view = consentView({ ...row, grant_categories: [] }, Date.now());
  assert.deepEqual(view.writeGrant, [], 'garbage must fail closed');
  assert.equal(view.parentCanControlThisNode, false);
});

test('⚠️ a write category offered over the wire is REFUSED, and says where one comes from', () => {
  for (const w of grants.ALL_WRITE) {
    const v = grants.validateGrant([w]);
    assert.equal(v.ok, false);
    assert.match(v.reason, /chosen by the node being written to/i);
    assert.match(v.reason, /never over the wire/i);
  }
});

test('the consent door takes writes and refuses reads; the wire door is the mirror image', () => {
  assert.equal(grants.validateWriteConsent(['content-push']).ok, true);
  assert.equal(grants.validateWriteConsent(['content-push', 'device-command']).ok, true);
  assert.equal(grants.validateWriteConsent(['health']).ok, false,
    'a read category set through the write door would let one route widen the other column');
  assert.equal(grants.validateGrant(['health']).ok, true);
});

test('⚠️ scope is required, and an empty scope means NOTHING', () => {
  // Deliberately opposite to shared_workspaces, where NULL means "all". A write permission that
  // becomes total by being unset is the failure mode this whole design is built against.
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', wsA), true);
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', wsB), false);
  assert.equal(grants.writeAllows(['content-push'], [], 'content-push', wsA), false);
  assert.equal(grants.writeAllows(['content-push'], null, 'content-push', wsA), false);
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'content-push', null), false);
});

test('holding one write category never confers the other', () => {
  assert.equal(grants.writeAllows(['content-push'], [wsA], 'device-command', wsA), false);
  assert.equal(grants.writeAllows(['device-command'], [wsA], 'content-push', wsA), false);
});

test('revoking write leaves the connection and its reporting intact', () => {
  const edge = mkEdge({ grant: ['health', 'identity'], write_grant: ['content-push'], write_scope: [wsA] });
  // What the consent route does on an empty category list.
  db.prepare('UPDATE mesh_edges SET write_grant = NULL, write_scope = NULL WHERE id = ?').run(edge.id);
  const row = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);

  assert.equal(row.revoked_at, null, 'revoking WRITE must not sever the edge');
  assert.equal(JSON.parse(row.grant_categories).length, 2, 'the read grant is untouched');
  const view = consentView({ ...row, grant_categories: ['health', 'identity'] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
  assert.equal(view.canRevoke, true);
});

/*
 * ─── The byte budget ───────────────────────────────────────────────────────────────────────
 *
 * ⚠️ Scope answers "whose screens". The budget answers "how much of my disk". An operator is only
 * ever asked the first question, so unless the second is asked out loud it gets answered by
 * default — and the default would be "all of it". A full disk on a signage server is a
 * cross-tenant outage, and it is the customer's disk.
 */
const GB = 1024 ** 3;

test('⚠️ an absent budget denies — NULL is not "unlimited"', () => {
  // Deliberately the same rule as write_scope. A permission that becomes total by being left blank
  // is the failure this whole design is built against.
  assert.equal(grants.budgetAllows(null, 0, 1), false);
  assert.equal(grants.budgetAllows(undefined, 0, 1), false);
  assert.equal(grants.budgetAllows(0, 0, 1), false);
  assert.equal(grants.budgetAllows(-1, 0, 1), false);
});

test('the budget is checked against what is ALREADY used, not just the incoming size', () => {
  assert.equal(grants.budgetAllows(20 * GB, 5 * GB, 1 * GB), true);
  assert.equal(grants.budgetAllows(20 * GB, 19 * GB, 2 * GB), false, 'used + incoming must fit');
  assert.equal(grants.budgetAllows(20 * GB, 19 * GB, 1 * GB), true, 'exactly at the limit is allowed');
});

test('a malformed used/incoming value cannot widen the budget', () => {
  assert.equal(grants.budgetAllows(10, NaN, 5), true, 'NaN used counts as zero, not as negative');
  assert.equal(grants.budgetAllows(10, -100, 5), true, 'a negative used must not buy extra room');
  assert.equal(grants.budgetAllows(10, 8, NaN), true);
  assert.equal(grants.budgetAllows(NaN, 0, 1), false, 'a NaN budget denies');
});

test('⚠️ the consent view shows used and remaining, not just the limit', () => {
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [wsA] });
  db.prepare('UPDATE mesh_edges SET write_bytes_budget = ?, write_bytes_used = ? WHERE id = ?')
    .run(20 * GB, 19 * GB, edge.id);
  const row = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
  const view = consentView({ ...row, grant_categories: ['health'] }, Date.now());

  assert.equal(view.writeBytesBudget, 20 * GB);
  assert.equal(view.writeBytesUsed, 19 * GB);
  assert.equal(view.writeBytesRemaining, 1 * GB,
    'an operator who granted 20GB months ago has no other way to learn they are nearly full');
});

test('an edge with no budget reports no headroom rather than infinite', () => {
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [wsA] });
  const view = consentView({ ...edge, grant_categories: [] }, Date.now());
  assert.equal(view.writeBytesBudget, null);
  assert.equal(view.writeBytesRemaining, 0, 'no budget must never read as unlimited headroom');
});

test('the content-push consequence mentions storage, not only the screens', () => {
  const said = grants.describeGrant(['content-push']).join(' ');
  assert.match(said, /change what plays/i);
  assert.match(said, /store files|storage/i,
    'sending content means storing it — an operator finding that out via a full disk is too late');
});

test('bytes are described in units an operator reads without counting zeroes', () => {
  assert.equal(grants.describeBytes(20 * GB), '20 GB');
  assert.equal(grants.describeBytes(0), 'nothing');
  assert.equal(grants.describeBytes(null), 'nothing');
});

/*
 * ⚠️ SEVERING MUST TAKE THE WRITE GRANT WITH IT.
 *
 * Severing used to null only the token, leaving write_grant, write_scope and write_bytes_budget on
 * the row — and the enrolment upsert sets revoked_at = NULL on conflict. So re-pairing the same
 * peer silently RESTORED write access to workspaces chosen months earlier, while the response
 * reported writeGrant: [] and "the connection was made read-only". An operator told to "re-pair to
 * fix the stale token" handed write access back without being asked.
 */
test('⚠️ severing clears the write grant, so re-pairing cannot resurrect it', () => {
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [wsA], budget: 20 * GB });
  db.prepare(`UPDATE mesh_edges SET revoked_at = strftime('%s','now'), up_token = NULL,
              write_grant = NULL, write_scope = NULL, write_bytes_budget = NULL
              WHERE id = ?`).run(edge.id);

  const after = db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id);
  assert.equal(after.write_grant, null);
  assert.equal(after.write_scope, null);
  assert.equal(after.write_bytes_budget, null);

  db.prepare('UPDATE mesh_edges SET revoked_at = NULL WHERE id = ?').run(edge.id);
  const view = consentView({ ...db.prepare('SELECT * FROM mesh_edges WHERE id = ?').get(edge.id),
                             grant_categories: [] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
  assert.deepEqual(view.writeGrant, []);
});

test('⚠️ a grant with categories but no workspaces does not claim the parent can control this node', () => {
  /*
   * Enforcement refuses an empty scope exactly as firmly as an empty category list, so such a row
   * permits nothing — but the consent view reported that the parent COULD control the node. It
   * failed in the safe direction and was still a lie, on the one screen whose whole purpose is to
   * tell an operator the truth about who can change their screens.
   */
  const edge = mkEdge({ write_grant: ['content-push'], write_scope: [] });
  const view = consentView({ ...edge, grant_categories: [] }, Date.now());
  assert.equal(view.parentCanControlThisNode, false);
});

/*
 * ⚠️ EVERY ADVERTISED CATEGORY MUST HAVE SOMETHING BEHIND IT.
 *
 * This replaces two tests that asserted device-command was *unavailable*. That was true and is no
 * longer: it now maps to the device and group command routes. But the reason it was marked
 * unavailable is the thing worth keeping — it was defined, described to the customer, and enforced
 * by nothing, so ticking it granted a permanent no-op while the consent screen said otherwise.
 *
 * So the guard is now the general form rather than a fact about one category: anything the consent
 * screen offers must be required by at least one rule. A category added later with no rule behind
 * it fails here instead of shipping as a promise the product does not keep.
 */
test('⚠️ every write category the consent screen offers is enforced by a rule', () => {
  const writeProxy = require('../lib/mesh/write-proxy');
  const enforced = new Set(writeProxy.WRITABLE.map((r) => r.grant));
  /*
   * Scale-out C2: `player-events` is enforced by lib/mesh/node-write.js applyPlayerOp (the
   * player-event / player-provision op types) and by read-proxy's verify-device rule — not by an
   * HTTP-path rule in WRITABLE, because a player event is not an HTTP request. The source is
   * checked so the category cannot drift back to "offered and enforced by nothing".
   */
  const nodeWrite = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'node-write.js'), 'utf8');
  assert.match(nodeWrite, /writeGrant\.includes\('player-events'\)/, 'player-events must gate applyPlayerOp');
  const readProxySrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mesh', 'read-proxy.js'), 'utf8');
  assert.match(readProxySrc, /writeGrant: 'player-events'/, 'player-events must gate verify-device');
  enforced.add('player-events');
  for (const name of grants.ALL_WRITE) {
    const meta = grants.WRITE_CATEGORIES[name];
    if (meta && meta.available === false) {
      // Still explicitly unavailable: it must be refused at the door rather than silently stored.
      assert.equal(grants.validateWriteConsent([name]).ok, false,
        `${name} is marked unavailable, so granting it must be refused`);
      continue;
    }
    assert.ok(enforced.has(name),
      `${name} is offered to the customer and no rule in WRITABLE requires it — granting it would ` +
      'permit nothing while the consent screen said it permitted something');
    assert.equal(grants.validateWriteConsent([name]).ok, true);
  }
});

/*
 * ⚠️ AND WHAT A HUB MAY COMMAND IS NARROWER THAN WHAT AN OPERATOR MAY.
 *
 * The command routes accept `shell` and `install_apk` — remote code execution and remote software
 * installation — which are legitimate for somebody acting on their own fleet from their own
 * dashboard. The consent sentence a customer reads is "Reboot, reload, change settings on screens",
 * and it must bound what the grant permits. A path rule cannot express that difference, because the
 * same URL carries every command; the body check is what does.
 */
test('⚠️ a hub cannot reach shell or install_apk through the command grant', () => {
  const { ALLOWED_COMMANDS, MESH_COMMANDS, isMeshCommand } = require('../lib/device-command');
  for (const forbidden of ['shell', 'install_apk', 'kiosk_lock', 'block_uninstall', 'power_menu', 'update']) {
    assert.ok(ALLOWED_COMMANDS.includes(forbidden), `${forbidden} is still an operator command`);
    assert.equal(isMeshCommand(forbidden), false, `${forbidden} must never be reachable from a hub`);
  }
  assert.ok(MESH_COMMANDS.length > 0);
  for (const allowed of MESH_COMMANDS) {
    assert.ok(ALLOWED_COMMANDS.includes(allowed),
      `${allowed} is offered to a hub but is not a command this server accepts at all`);
  }
});

test('⚠️ the consent sentence names what it permits, and excludes what it does not', () => {
  // The sentence IS the boundary — if the subset grows and this does not, the screen starts lying.
  const said = grants.describeGrant(['device-command']).join(' ').toLowerCase();
  assert.match(said, /restart/);
  assert.match(said, /volume|brightness/);
  assert.match(said, /not be able to run commands|install software/,
    'the exclusions are the half a customer cannot infer, so they must be stated');
});

