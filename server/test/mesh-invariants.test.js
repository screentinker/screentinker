'use strict';

/*
 * The mesh hard invariants, one named test each.
 *
 * ⚠️ THESE ARE NOT UNIT TESTS OF A FEATURE. They are the enforcement of architectural decisions that
 * cannot be inferred from reading any single file — which is exactly the kind of rule that erodes
 * when outside contributors and bot PRs are landing. Every one of them is listed in ARCHITECTURE.md
 * with the name of the test that holds it up, so a reviewer can check the rule is still guarded
 * without reading the implementation.
 *
 * Several are deliberately SOURCE-LEVEL assertions rather than behavioural ones. A behavioural test
 * can only prove that a downward command handler did not fire in the cases it thought to try; a
 * source assertion proves there is no handler to fire. For invariants whose whole value is absence,
 * absence is the thing to test.
 *
 * See docs/mesh-directive.md.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MESH_DIR = path.join(__dirname, '..', 'lib', 'mesh');
const grants = require('../lib/mesh/grants');
const capabilities = require('../lib/mesh/capabilities');
const envelope = require('../lib/mesh/envelope');
const identity = require('../lib/mesh/node-identity');

const meshSources = () =>
  fs.readdirSync(MESH_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(MESH_DIR, f), 'utf8') }));

// ===== I2 — upward only =====

test('test_downward_handlers_are_an_allowlist (I2)', () => {
  /*
   * ⚠️ THIS WAS A NAME BLOCKLIST AND IT DID NOT GUARD WHAT IT CLAIMED.
   *
   * The old regex forbade mesh:(command|exec|reboot|push|apply|set). It did NOT match `mesh:write`,
   * `mesh:content` or `mesh:mutate` — so the invariant named in ARCHITECTURE.md could have been
   * removed by anyone who picked a different verb, and the guard would have stayed green. It also
   * read only lib/mesh/, never ws/meshSocket.js, which is the file that actually emits downward.
   *
   * A blocklist of names cannot express "no downward control": it expresses "not these six words".
   * So it is now an ALLOWLIST. Every downward handler must be named here, and adding one is a
   * deliberate edit to this list with a reason — which is exactly the review the invariant wants.
   *
   * I2 itself has moved twice and the honest statement is no longer "upward only":
   *   - reads (Phase 3) made the parent able to ASK. See lib/mesh/read-proxy.js.
   *   - writes (Phase 5) make it able to ASK for a change.
   * What must remain true, and what this test now protects, is that EVERY downward message is
   * answered by an allowlist on the child, keyed to a grant the child's own operator chose. The
   * parent may ask; it may never tell.
   */
  /*
   * ⚠️ EDITING THIS LIST IS THE REVIEW. Each entry is a thing a parent may cause to happen on a
   * child, and each one must be answered by a grant check on the child:
   *
   *   mesh:hello  — the parent announces its batching limits. Carries no request and changes
   *                 nothing; the child may ignore it entirely and does when there is no overlap.
   *   mesh:read   — "may I see X?" Answered by lib/mesh/read-proxy.js: segment-exact allowlist,
   *                 method pinned to GET, per-rule grant, workspace scope applied on the child.
   *   mesh:write  — "may I change X?" Answered by lib/mesh/write-proxy.js + node-write.js: its own
   *                 allowlist with the method pinned per rule, a write grant the CHILD's operator
   *                 set (never one that arrived over the wire), and the target's workspace resolved
   *                 from the child's own rows rather than taken from the request.
   *
   *   mesh:content-offer — "may I send you these files?" Answered by lib/mesh/content-receive.js.
   *                 The message carries a DESCRIPTION and a one-time ticket per file; it carries no
   *                 bytes and no location. The child then decides, against its own rows and its own
   *                 disk, in this order: does the content-push grant cover the named workspace
   *                 (grants.writeAllows, refusing an empty scope as firmly as an empty grant); does
   *                 it actually need any of it (checking the DISK, not just its content rows); does
   *                 the operator's byte allowance and the real free space both permit it — all
   *                 before a single byte is requested.
   *
   *                 ⚠️ The URL it fetches from is the child's OWN stored peer_url, never anything
   *                 in the message. A parent able to name the host would be a parent able to point
   *                 this node at anything on its network and have it download the result, and it
   *                 would look exactly like an ordinary content push (I7).
   *
   *                 ⚠️ Every arrived file is verified before it is visible: size from statSync, the
   *                 digest, and a re-sniff of the type — a parent is an authenticated remote writer
   *                 running a version we do not control.
   *
   *   mesh:content-purge — "please forget what I sent you." The ONLY downward message that removes
   *                 anything, and the narrowest one here. Answered by lib/mesh/relay.js: the ids
   *                 are matched against provenance rows for THIS edge's peer, so a parent can reach
   *                 what it sent and nothing else — not what the child uploaded, not what another
   *                 parent sent. Anything a playlist here still uses is REFUSED and reported,
   *                 because a file pulled out from under a published playlist is a blank slot on a
   *                 wall decided by a server nobody at that site controls.
   *
   *   Scale-out C2 adds NO downward verb, but it adds two things a parent can cause on a child, and
   *   they are accounted for here because this is the review:
   *
   *   mesh:write { type: 'player-event' | 'player-provision' } — "a screen attached to me reported
   *                 X" / "a screen paired to me; mint it a row". Answered by lib/mesh/node-write.js
   *                 applyPlayerOp: refused unless the CHILD's operator set the `player-events` write
   *                 grant on that edge (validateGrant refuses it over the wire; only the operator
   *                 consent route stores it), the device's workspace resolved from the child's own
   *                 rows and required to be inside the grant's scope, and the same idempotency
   *                 record as every other write. Applied by the very function the child's own
   *                 socket handler calls. The op types are a reviewed list: nodeWrite.PLAYER_OP_TYPES
   *                 (test/scale-out-c2.test.js).
   *
   *   command-relay (UPWARD, child -> parent) — the one upward payload a parent ACTS on rather than
   *                 stores: "deliver this to a screen attached to you". Permitted because the
   *                 parent's operator declared `terminates-players` for the edge; the parent
   *                 (lib/mesh/player-termination.js deliverRelay) delivers only to a socket it
   *                 holds, only for a device whose workspace it copies from THAT child (or one it
   *                 provisioned through it), and only player-facing events. Never stored, never
   *                 relayed further.
   */
  const ALLOWED_DOWNWARD = ['mesh:read', 'mesh:write', 'mesh:hello', 'mesh:content-offer',
                            'mesh:content-purge'];

  /*
   * Direction matters, and scanning both files for handlers gets it wrong: `mesh:envelope` is
   * handled ON THE PARENT and carries telemetry UPWARD, which is the direction the mesh is built
   * for. So the two halves of "downward" are checked where each actually lives:
   *   - a handler in lib/mesh/  -> something a PARENT can cause to run on a CHILD
   *   - an emit in ws/meshSocket.js -> something the PARENT says DOWN the socket
   */
  const childHandlerRe = /\.on\s*\(\s*['"](mesh:[a-z0-9:_-]+)['"]/gi;
  for (const { file, src } of meshSources()) {
    for (const m of src.matchAll(childHandlerRe)) {
      assert.ok(ALLOWED_DOWNWARD.includes(m[1]),
        `lib/mesh/${file} handles "${m[1]}" — a message a parent can make this node act on — and it ` +
        `is not in the reviewed downward allowlist [${ALLOWED_DOWNWARD.join(', ')}]. Adding one means ` +
        'editing that list and saying why: every downward message must be answered by a grant check ' +
        'on the child (I2).');
    }
  }

  const socketSrc = fs.readFileSync(path.join(__dirname, '..', 'ws', 'meshSocket.js'), 'utf8');
  const emitRe = /\.emit\s*\(\s*['"](mesh:[a-z0-9:_-]+)['"]/gi;
  for (const m of socketSrc.matchAll(emitRe)) {
    assert.ok(ALLOWED_DOWNWARD.includes(m[1]),
      `ws/meshSocket.js emits "${m[1]}" downward, which is not in the reviewed allowlist ` +
      `[${ALLOWED_DOWNWARD.join(', ')}]. This file is where the parent speaks to the child, and it ` +
      'was outside the old guard entirely — a downward verb added here used to pass unnoticed.');
  }
});

test('a write grant can never arrive over the wire (I2/I10)', () => {
  /*
   * ⚠️ REPLACES "write grants are modelled but refused". That test asserted a PLACEHOLDER — that
   * nothing could grant write at all — and deleting it when write landed would have removed the
   * only thing standing between a parent and its own permissions. What it is replaced with is the
   * PROPERTY that has to survive: a write category may be chosen by the node being written to, and
   * by nothing else.
   *
   * validateGrant is the function every wire path uses. It must refuse write, forever.
   */
  assert.ok(grants.ALL_WRITE.length > 0, 'write categories should exist in the model');
  for (const w of grants.ALL_WRITE) {
    const v = grants.validateGrant([w]);
    assert.equal(v.ok, false, `${w} must never be grantable over the wire`);
    assert.match(v.reason, /chosen by the node being written to|never over the wire/i,
      'the refusal must say WHERE a write grant comes from, not merely that this one is refused');
  }

  /*
   * ...and the consent-side door accepts the ones this server can actually act on, and no read
   * category.
   *
   * ⚠️ "Every write category is grantable by the owner" was too strong, and it hid a real problem
   * rather than protecting anything: device-command is defined and described but NO rule in
   * write-proxy.WRITABLE requires it, so an operator could read its consequence, tick it, and grant
   * a permanent no-op. It is now marked unavailable and refused at the consent door. The invariant
   * being protected here is that the door takes write categories and only the owner may use it —
   * not that every category in the catalogue is currently implemented.
   */
  const implemented = grants.ALL_WRITE.filter((w) => grants.WRITE_CATEGORIES[w].available !== false);
  assert.ok(implemented.length > 0, 'at least one write category must actually be grantable');
  for (const w of implemented) {
    assert.equal(grants.validateWriteConsent([w]).ok, true, `${w} must be grantable by the owner`);
  }
  for (const w of grants.ALL_WRITE.filter((x) => !implemented.includes(x))) {
    assert.equal(grants.validateWriteConsent([w]).ok, false,
      `${w} has no enforcement rule, so granting it would promise something that cannot happen`);
  }
  for (const r of grants.ALL_READ) {
    assert.equal(grants.validateWriteConsent([r]).ok, false,
      `${r} is a read category and must not be settable through the write-consent door`);
  }
});

test('a write is denied unless BOTH the category and the workspace were granted (I10)', () => {
  // Scope is not decoration. A grant that named categories but no workspaces would be a grant over
  // the whole node, which is precisely the "grants must be scopeable below the top" gap that the
  // industry survey found in the closest prior art.
  assert.equal(grants.writeAllows(['content-push'], ['w1'], 'content-push', 'w1'), true);
  assert.equal(grants.writeAllows(['content-push'], ['w1'], 'content-push', 'w2'), false,
    'a workspace outside the scope must be refused');
  assert.equal(grants.writeAllows(['content-push'], [], 'content-push', 'w1'), false,
    'an EMPTY scope means nothing, never everything');
  assert.equal(grants.writeAllows(['content-push'], null, 'content-push', 'w1'), false,
    'an ABSENT scope means nothing, never everything');
  assert.equal(grants.writeAllows(['device-command'], ['w1'], 'content-push', 'w1'), false,
    'holding one write category must not confer another');
  assert.equal(grants.writeAllows(null, ['w1'], 'content-push', 'w1'), false);
});

/*
 * ⚠️ REPLACES "content redistribution is refused until Phase 5". That test asserted a PLACEHOLDER —
 * that the capability could not be declared at all — and deleting it when relaying landed would
 * have removed the only thing watching this. What replaces it is the property that has to survive:
 * declaring the capability is a RESOURCE decision and never an authority.
 *
 * Three parties must agree before a byte travels a second hop, and no one of them can substitute
 * for another:
 *   the content's owner  — `relayable` on the provenance row, set from the manifest when they
 *                          pushed it. Their file, their call.
 *   the relay's operator — this capability. "I am willing to spend disk holding things for onward
 *                          use", which says what the node CAN do and never what it MAY.
 *   each server below    — its own write grant, checked on arrival like any other push.
 *
 * A single flag would have collapsed those into whoever runs the middle node — the party that
 * benefits from caching rather than the one giving something up.
 */
test('declaring redistributes-content grants no authority over anyone (I2/I10)', () => {
  const v = capabilities.validateCapabilities(['redistributes-content'], { acceptEnrollment: true });
  assert.equal(v.ok, true, 'a node may now declare it is willing to hold content for onward use');
  assert.ok(capabilities.AVAILABLE_NOW.includes('redistributes-content'));

  // ⚠️ And it must remain a capability, not a grant: it appears in neither grant vocabulary, so it
  // can never be mistaken for permission to do anything to anybody.
  assert.ok(!grants.ALL_READ.includes('redistributes-content'));
  assert.ok(!grants.ALL_WRITE.includes('redistributes-content'));
  assert.equal(grants.validateGrant(['redistributes-content']).ok, false);
  assert.equal(grants.validateWriteConsent(['redistributes-content']).ok, false);

  // Still gated on the node accepting enrollment at all — a node that hosts nobody relays nothing.
  assert.equal(capabilities.validateCapabilities(['redistributes-content'], { acceptEnrollment: false }).ok, false);
});

// ===== I3 — no cycles =====

test('test_cycle_refused_by_reachability_not_prefix (I3)', () => {
  /*
   * ⚠️ Multi-parent is permitted, so the graph is a DAG and a path-prefix check is wrong: under
   * multi-parent a legitimate message routinely arrives whose ancestry is not a prefix of anything
   * local, and prefix matching would refuse it. Membership in the recorded ancestry is the test.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 1,
    ancestry: ['node-a', 'node-b'], originTs: 1000, body: {},
  });
  assert.equal(envelope.wouldLoop(env, 'node-b'), true, 'a node already in the ancestry is a loop');
  assert.equal(envelope.wouldLoop(env, 'node-c'), false, 'an unrelated node is not a loop');

  // The DAG case: a second parent whose id is nowhere in this path must be accepted.
  const viaOtherParent = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 1,
    ancestry: ['node-a', 'node-x'], originTs: 1000, body: {},
  });
  assert.equal(envelope.wouldLoop(viaOtherParent, 'node-b'), false,
    'multi-parent delivery must not be mistaken for a cycle');
});

// ===== I4 — identity is position-independent =====

test('test_node_id_encodes_no_position (I4)', () => {
  const id = identity.newNodeId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'a node id must be a plain v4 UUID — no path, parent or role encoded in it');
  assert.notEqual(identity.newNodeId(), id, 'ids must not be derived from anything stable');
});

// ===== I5 — opaque relay =====

test('test_unknown_payload_is_relayed_not_dropped (I5)', () => {
  /*
   * An intermediate node forwards what it cannot parse. Refusing unknown types would mean every node
   * on a path had to be upgraded before any new payload could travel — the coupling the
   * envelope/body split exists to prevent.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'something-invented-in-2027', bodyVersion: 9,
    ancestry: ['node-a'], originTs: 1000, body: { opaque: true },
  });
  const v = envelope.validateEnvelope(env, { thisNodeId: 'node-b' });
  assert.equal(v.ok, true, 'an unknown payload type must not be an error');
  assert.equal(v.relayOnly, true, 'and must be marked relay-only rather than stored');
});

test('a newer version of a KNOWN payload is also relay-only, not misread (I5)', () => {
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'node-health', bodyVersion: 99,
    ancestry: ['node-a'], originTs: 1000, body: {},
  });
  const v = envelope.validateEnvelope(env, { thisNodeId: 'node-b' });
  assert.equal(v.relayOnly, true, 'a body newer than we understand must not be parsed as if it were ours');
});

// ===== I7 — no phone home =====

test('test_no_phone_home (I7)', () => {
  /*
   * No license check, no activation, no usage beacon, no central registry. Air-gapped is a
   * first-class install, and it cannot be if identity or enrollment needs the internet.
   *
   * ⚠️ LOOPBACK IS THE ONE EXCEPTION, AND IT IS ASSERTED RATHER THAN WAIVED. local-apply.js calls
   * this server's own HTTP API over 127.0.0.1 so that a mesh write passes exactly the guards a
   * local request passes — the alternative was a second write implementation, which would drift.
   * A call to yourself is not phoning home: it needs no internet, works air-gapped, and reaches
   * nothing the operator does not already run.
   *
   * So the guard is now STRICTER, not looser: any URL appearing in lib/mesh must be a loopback
   * address. A hardcoded external host still fails, and now so does a loopback call that someone
   * later edits into a real one.
   */
  const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:|\/|$)/;
  for (const { file, src } of meshSources()) {
    for (const m of src.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      assert.match(m[0], LOOPBACK,
        `${file} contains the URL ${m[0]} — mesh identity and pairing are local, and the only ` +
        'address that may appear here is this server\'s own loopback (I7)');
    }
    /*
     * A network call is only acceptable next to a loopback URL. A file that fetches without one
     * has taken its address from somewhere, and "somewhere" is what I9 exists to prevent.
     */
    if (/fetch\s*\(/.test(src)) {
      assert.match(src, LOOPBACK.source ? /https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)/ : /$^/,
        `${file} makes a network call but names no loopback address — where is it dialling? (I7)`);
    }
  }
});

// ===== I9 — no built-in relay address, no automatic fallback =====

test('test_no_builtin_relay_address (I9)', () => {
  /*
   * ⚠️ This is how a peer architecture quietly becomes hub-and-spoke, and it always arrives as a bug
   * fix: a connection fails, someone adds a "sensible default" relay, and now every deployment
   * depends on a host the vendor operates. There is never a compiled-in address.
   */
  const HOSTNAME = /(screentinker\.com|relay\.|\.amazonaws\.|\.cloudfront\.|stun:|turn:)/i;
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, HOSTNAME,
      `${file} names a host — a relay address must always come from the operator (I9)`);
  }
});

test('test_no_automatic_relay_fallback (I9)', () => {
  for (const { file, src } of meshSources()) {
    assert.doesNotMatch(src, /fallback\s*(to)?\s*relay|relayFallback|autoRelay/i,
      `${file} suggests an automatic reroute — a failed direct connection must fail visibly (I9)`);
  }
});

// ===== I10 — enforcement lives with the data owner =====

test('test_grant_defaults_to_denied (I10)', () => {
  // An empty grant is valid and yields nothing. There is no wildcard, so a category added in a later
  // version cannot retroactively widen an edge that was agreed before it existed.
  assert.equal(grants.grantAllows([], 'health'), false);
  assert.equal(grants.grantAllows(['health'], 'proof-of-play'), false);
  assert.equal(grants.grantAllows(['health'], 'health'), true);
  for (const wildcard of ['*', 'all', 'any']) {
    assert.equal(grants.grantAllows([wildcard], 'health'), false,
      `"${wildcard}" must not act as a wildcard`);
  }
});

test('the public WAN address is separately deniable from the LAN address (I10)', () => {
  /*
   * Phase −1 found devices.ip_address populated for 509 of 509 production devices with PUBLIC
   * addresses, which locate a client's premises. A health-only grant that still shipped them would
   * fail the security review this vocabulary exists for.
   */
  assert.ok(grants.ALL_READ.includes('network-lan'));
  assert.ok(grants.ALL_READ.includes('network-wan'));
  assert.equal(grants.grantAllows(['network-lan'], 'network-wan'), false,
    'granting LAN visibility must not imply the public address');
});

test('screenshots are separately deniable from display state (I10)', () => {
  assert.equal(grants.grantAllows(['display'], 'display-capture'), false,
    'knowing the video mode must not imply permission to see the screen contents');
});

// ===== the dropped field must not reappear as a grant category =====

test('wifi_ssid is not a grant category (Phase −1)', () => {
  // 94% of its production values were not SSIDs, and the remainder were geolocatable customer
  // network names. It is being dropped, so it must never acquire a category to be granted through.
  for (const c of [...grants.ALL_READ, ...grants.ALL_WRITE]) {
    assert.doesNotMatch(c, /ssid/i, `${c} reintroduces the dropped Wi-Fi SSID field`);
  }
});

// ===== schema =====

test('every existing install becomes a node with zero edges (migration is a no-op)', () => {
  /*
   * The guarantee that Phase 0 cannot break anyone on 1.9.x: the tables exist and are empty, and
   * with both feature flags off nothing reads them.
   *
   * ⚠️ Runs in a CHILD PROCESS. config.js resolves DATA_DIR once at module load, so setting the env
   * var from inside an already-running suite is read too late and the schema lands in the developer's
   * real data directory instead of a throwaway one.
   */
  const { execFileSync } = require('node:child_process');
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-schema-'));
  try {
    const probe = `
      require('./db/database.js');
      const { Database } = require('./db/sqlite-driver');
      const db = new Database(require('path').join(process.env.DATA_DIR, 'db', 'remote_display.db'));
      const tables = db.prepare("select name from sqlite_master where type='table' and name like 'mesh%'")
        .all().map(r => r.name).sort();
      const edgeCols = db.prepare("select name from pragma_table_info('mesh_edges')").all().map(r => r.name);
      const edges = db.prepare('select count(*) c from mesh_edges').get().c;
      const mirrorCounts = {};
      for (const t of ['mesh_mirror_nodes','mesh_mirror_devices','mesh_mirror_alerts','mesh_mirror_play_logs','mesh_node_paths']) {
        mirrorCounts[t] = db.prepare('select count(*) c from ' + t).get().c;
      }
      db.close();
      console.log('MESH_PROBE=' + JSON.stringify({ tables, edgeCols, edges, mirrorCounts }));
    `;
    const out = execFileSync(process.execPath, ['-e', probe], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', NODE_ENV: 'test' },
    });
    const line = out.split('\n').find((l) => l.startsWith('MESH_PROBE='));
    assert.ok(line, `probe produced no result:\n${out.slice(-500)}`);
    const { tables, edgeCols, edges, mirrorCounts } = JSON.parse(line.slice('MESH_PROBE='.length));

    /*
     * ⚠️ An EXACT list, not a subset check. It exists to notice a table appearing, which is how this
     * assertion earned its keep — the four mesh_mirror_* tables tripped it the moment Phase 2's
     * storage landed. A `.includes()` check would have accepted them silently, and a new table that
     * nobody reviewed is precisely the thing worth a failing test.
     */
    assert.deepEqual(tables, [
      /*
       * ⚠️ SORTED. The query returns them in name order, so a new table goes in its alphabetical
       * place — appending it to the end fails with a diff that looks like every table moved.
       *
       * Phase 5 added three, all empty on every install until somebody actually pushes:
       *   mesh_content_provenance — maps a peer's content id to the local row. This is what makes a
       *     re-push idempotent: without it the child mints a fresh content id every time, and since
       *     content_id and filepath are both in the player's structural fingerprint, every screen
       *     on the site restarts at item 1 on every push.
       *   mesh_pull_tickets — short-lived, single-asset, stored hashed, bound to a filepath.
       *   mesh_write_ops — a retried write returns its first outcome instead of applying twice.
       */
      /*
       * Scale-out C1 added one, empty on every install and written by NO application code:
       *   mesh_change_log — filled only by triggers that exist while an up edge carries the
       *     workspace-replication grant (lib/mesh/replication.js). Its emptiness here is also what
       *     test_change_log_triggers_absent_without_replication_grant checks from the outside.
       */
      /*
       * Scale-out C2 added two, both REPLICA-side and empty on every install that terminates no
       * players:
       *   mesh_player_events   — the durable, ordered outbox of player events for a primary
       *     (lib/mesh/player-termination.js). Proof-of-play is never thinned here.
       *   mesh_player_verdicts — "the primary said yes to this device + token HASH", so a screen
       *     with a prior session can reconnect while the primary is unreachable. Never the token.
       */
      'mesh_change_log', 'mesh_client_access', 'mesh_clients', 'mesh_content_provenance', 'mesh_edges',
      'mesh_mirror_alerts', 'mesh_mirror_devices', 'mesh_mirror_nodes', 'mesh_mirror_play_logs',
      'mesh_mirror_workspaces', 'mesh_node', 'mesh_node_paths', 'mesh_pairing_codes',
      'mesh_player_events', 'mesh_player_verdicts', 'mesh_pull_tickets', 'mesh_tombstones', 'mesh_write_ops',
    ]);

    /*
     * mesh_node_paths — how far away a node is and by which route, LEARNED from the ancestry a
     * relayed payload carries rather than declared by anybody. A node cannot tell this hub where it
     * sits (that is a relationship it is not a party to), but a payload that genuinely travelled
     * A<-B<-C proves the shape by having taken it, and the receiver already refuses any item whose
     * ancestry does not include the node that handed it over. Empty until something is relayed.
     */
    assert.equal(
      mirrorCounts.mesh_node_paths === undefined ? 0 : mirrorCounts.mesh_node_paths, 0,
      'a fresh install knows no paths — the shape is learned, never assumed',
    );

    // Still empty on a fresh install: tables exist, nothing is mirrored until something is paired.
    for (const t of ['mesh_mirror_nodes', 'mesh_mirror_devices', 'mesh_mirror_alerts',
                     'mesh_mirror_play_logs']) {
      assert.equal(mirrorCounts[t], 0, `${t} must be empty on an install that has never paired`);
    }
    assert.equal(edges, 0,
      'a fresh install must have zero edges — pairing is the only thing that creates one');
    // ⚠️ Edges are a table precisely so that multi-parent stays possible.
    assert.ok(!edgeCols.includes('parent_id'), 'a parent pointer forecloses multi-parent (see design)');
    for (const required of ['peer_node_id', 'role_capabilities', 'grant_categories',
                            'transport_direction', 'tls_verify', 'client_id']) {
      assert.ok(edgeCols.includes(required), `mesh_edges is missing ${required}`);
    }
  } finally {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

// ===== I1 — autonomy / invisibility =====

test('test_mesh_off_by_default (I1)', () => {
  /*
   * With both flags off there is no new UI, no new route, no background work. A user who never sets
   * them must not be able to tell the mesh exists — and a node is fully functional with no parent, so
   * a parent is an observer and never a dependency.
   *
   * Read in a child process with a scrubbed environment: this developer machine, or a CI job, could
   * have either variable set for other reasons, and a default that only holds when nobody looked is
   * not a default.
   */
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.MESH_ACCEPT_ENROLLMENT;
  delete env.MESH_ALLOW_UPLINK;
  delete env.MESH_MAX_DEPTH;
  delete env.MESH_MIN_NODE_VERSION;

  const out = execFileSync(process.execPath,
    ['-e', "const c=require('./config');console.log(JSON.stringify({a:c.meshAcceptEnrollment,u:c.meshAllowUplink,d:c.meshMaxDepth,v:c.meshMinNodeVersion}))"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000, env });
  const cfg = JSON.parse(out.trim().split('\n').pop());

  assert.equal(cfg.a, false, 'MESH_ACCEPT_ENROLLMENT must default OFF');
  assert.equal(cfg.u, false, 'MESH_ALLOW_UPLINK must default OFF');
  assert.equal(cfg.d, 2, 'depth stays capped at 2 until Phase 4');
  assert.equal(cfg.v, '2.0.0-0', 'the version floor must be stated, not absent');
});

test('a capability requiring enrollment is refused while the flag is off (I1)', () => {
  const v = capabilities.validateCapabilities(['accepts-enrollment'], { acceptEnrollment: false });
  assert.equal(v.ok, false);
  assert.match(v.reason, /MESH_ACCEPT_ENROLLMENT/,
    'the refusal must name the flag an operator has to set, not just decline');
});

// ===== version floor =====

test('a node below the version floor is refused with a readable reason', () => {
  assert.equal(identity.versionAcceptable('2.0.0'), true);
  assert.equal(identity.versionAcceptable('2.1.3'), true);
  assert.equal(identity.versionAcceptable('1.9.39'), false, '1.9.x cannot speak mesh at all');
  // ⚠️ An unparseable version is refused, not waved through: a peer that cannot state its version
  // cannot be held to a contract, and "unknown" is what a broken or hostile peer reports.
  assert.equal(identity.versionAcceptable('garbage'), false);
  assert.match(identity.versionRefusalReason('1.9.39'), /requires 2\.0\.0-0 or newer/);
  assert.match(identity.versionRefusalReason('garbage'), /not a version this node can compare/);
});

test('a duplicate node id on a second edge is refused, not merged', () => {
  /*
   * Cloning a VM is routine MSP practice and the clone carries its parent's node id. Two machines
   * reporting one identity interleave their histories permanently, with no field left to separate
   * them. Refusing the SECOND keeps the node that was already reporting alive while the operator
   * fixes the clone.
   */
  const existing = { edge_id: 'edge-1' };
  const same = identity.checkDuplicateNodeId('node-a', () => existing, 'edge-1');
  assert.equal(same.ok, true, 'the same edge re-presenting its own id is not a duplicate');

  const clone = identity.checkDuplicateNodeId('node-a', () => existing, 'edge-2');
  assert.equal(clone.ok, false);
  assert.equal(clone.duplicate, true);
  assert.match(clone.reason, /cloned VM|disk image/i,
    'the reason must tell the operator what actually happened, not just "duplicate"');
});

// ===== clock =====

test('skew is measured and surfaced rather than silently reordering history', () => {
  /*
   * Never order events by a single clock: the nodes are other people's machines. A site server two
   * hours ahead would silently interleave its alerts into the middle of yesterday in a hub's inbox,
   * with nothing on screen explaining why the story does not add up.
   */
  const env = envelope.createEnvelope({
    originNodeId: 'node-a', type: 'alert-event', bodyVersion: 1,
    ancestry: ['node-a'], originTs: 1_000_000, body: {},
  });
  assert.equal(envelope.clockSkewMs(env), null, 'no receipt yet — skew is unknown, not zero');

  const stamped = envelope.stampReceipt(env, 'node-b', 1_000_500);
  assert.equal(envelope.clockSkewMs(stamped), -500, 'origin behind receiver reads negative');
  assert.equal(envelope.skewIsNotable(stamped), false, 'half a second is transit, not a story');

  const skewed = envelope.stampReceipt(env, 'node-b', 1_000_000 + 3 * 60 * 60 * 1000);
  assert.equal(envelope.skewIsNotable(skewed), true, 'three hours must be surfaced to an operator');

  // ⚠️ Receipts append. Overwriting the first would destroy the only evidence of where a delay or a
  // skew was introduced — which is the question being asked when anyone looks at this.
  const twoHops = envelope.stampReceipt(stamped, 'node-c', 1_001_000);
  assert.equal(twoHops.receipts.length, 2);
  assert.equal(twoHops.receipts[0].node_id, 'node-b');
});
