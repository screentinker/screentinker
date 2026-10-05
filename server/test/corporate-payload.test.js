'use strict';

/*
 * The device payload of a screen head office's playlist plays on — spec §3.2 (origin tag), §3.3,
 * D6, critique H1/R5.
 *
 *   - corporate items resolve `play_when` data sources and custom shaders in HEAD OFFICE's
 *     workspace: a store data source with the same slug must never gate a corporate item;
 *   - the internal origin tag never leaves the server;
 *   - default_content is null on a mandated screen (a dark mandate is really dark);
 *   - a non-corporate payload is exactly what it was.
 *
 * MUTATION CHECK (verified once): make assemblePayload ignore __origin_ws (attachDataSourceBag on
 * the device workspace only) -> "⚠️ a store data source with head office's slug ..." goes red.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-corp-payload-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');

let build, assemble;
const ORG = 'org-p'; const HQ = 'ws-hq'; const STORE = 'ws-store';
const P = 'pl-corp'; const OWN = 'pl-own';
const DEV = 'dev-m'; const PLAIN = 'dev-plain'; const C = 'c-1';

before(() => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  assemble = setupDeviceSocket.assemblePayload;
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u', 'u@x.test', 'u', 'user')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id, corporate_enabled) VALUES (?, 'Acme', 'u', 1)").run(ORG);
  db.prepare("INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, 'HQ'), (?, ?, 'Store')").run(HQ, ORG, STORE, ORG);
  db.prepare('UPDATE organizations SET hq_workspace_id = ? WHERE id = ?').run(HQ, ORG);
  db.prepare("INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size) VALUES (?, 'u', ?, 'a.png', 'a.png', 'image/png', 1)").run(C, HQ);
  const item = { content_id: C, filename: 'a.png', mime_type: 'image/png', filepath: 'a.png', duration_sec: 10, sort_order: 0,
    play_when: { type: 'ds', slug: 'weather', path: 'sunny', op: 'truthy', value: null } };
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot, corporate) VALUES (?, 'u', ?, 'Brand', 'published', ?, 1)")
    .run(P, HQ, JSON.stringify([item]));
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES (?, 'u', ?, 'Own', 'published', ?)")
    .run(OWN, STORE, JSON.stringify([item]));
  for (const [ws, data] of [[HQ, { sunny: true, who: 'hq' }], [STORE, { sunny: false, who: 'store' }]]) {
    db.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config, cached_data) VALUES (?, ?, 'weather', 'w', 'json_api', '{}', ?)")
      .run(crypto.randomUUID(), ws, JSON.stringify(data));
  }
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, default_content_id) VALUES (?, 'u', ?, 'm', 'pc1', ?, 'device', ?)")
    .run(DEV, STORE, OWN, C);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, default_content_id) VALUES (?, 'u', ?, 'p', 'pc2', ?, 'device', ?)")
    .run(PLAIN, STORE, OWN, C);
});

test('an unmandated screen: its own playlist, its own data source, its default content — as before', () => {
  const p = build(PLAIN);
  assert.equal(p.assignments[0]._ds.who, 'store');
  assert.equal(p.default_content.content_id, C);
  assert.ok(!JSON.stringify(p).includes('__origin_ws'));
});

test('⚠️ a store data source with head office\'s slug cannot gate a corporate item; no origin tag leaks; no store default content', () => {
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, playlist_id, target_kind, target_id) VALUES ('m1', ?, ?, 'device', ?)").run(ORG, P, DEV);
  try {
    const p = build(DEV);
    assert.equal(p.assignments.length, 1);
    assert.equal(p.assignments[0]._ds.who, 'hq', 'the corporate item must read HEAD OFFICE\'s data source');
    assert.ok(!JSON.stringify(p).includes('__origin_ws'), 'the origin tag is internal');
    assert.equal(p.default_content, null, 'never store content on a mandated screen');
    // the unmandated neighbour is untouched
    assert.equal(build(PLAIN).assignments[0]._ds.who, 'store');
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('a dark mandate: no items, no default content', () => {
  db.prepare("INSERT INTO corporate_mandates (id, organization_id, dark, target_kind, target_id) VALUES ('m2', ?, 1, 'device', ?)").run(ORG, DEV);
  try {
    const p = build(DEV);
    assert.deepEqual(p.assignments, []);
    assert.equal(p.default_content, null);
  } finally { db.prepare('DELETE FROM corporate_mandates').run(); }
});

test('assemblePayload: head office\'s custom shader runs on a store screen; a store shader of the same id does not replace it', () => {
  const ins = db.prepare("INSERT INTO custom_shaders (id, workspace_id, shader_id, name, source, params, created_at) VALUES (?, ?, 'custom-wipe', 'w', ?, '[]', 0)");
  ins.run(crypto.randomUUID(), HQ, 'HQ-GLSL');
  ins.run(crypto.randomUUID(), STORE, 'STORE-GLSL');
  const items = [{ content_id: C, transition: { effects: [{ shader: 'custom-wipe' }], durationMs: 500 }, __origin_ws: HQ }];
  const p = assemble({ assignments: items, workspace_id: STORE });
  assert.equal(p.custom_shaders['custom-wipe'], 'HQ-GLSL');
  assert.ok(!('__origin_ws' in p.assignments[0]));
  // Untagged (every non-corporate payload): the device's workspace, exactly as before.
  const q = assemble({ assignments: [{ content_id: C, transition: { effects: [{ shader: 'custom-wipe' }], durationMs: 500 } }], workspace_id: STORE });
  assert.equal(q.custom_shaders['custom-wipe'], 'STORE-GLSL');
});
