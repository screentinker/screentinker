'use strict';

/*
 * #660: what colour a screen is told to paint (ws/deviceSocket.js), in process.
 *
 *   - the playlist's PUBLISHED colour wins over the device's own while that playlist plays
 *   - a draft colour does not reach screens until it is published
 *   - no playlist colour: the device's, exactly as #325 always did; neither: null (the player's black)
 *   - an override playlist brings its own colour, and the screen's comes back when it ends
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-plbgpay-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Server } = require('socket.io');
const { db } = require('../db/database');
const setupDeviceSocket = require('../ws/deviceSocket');
const overrides = require('../lib/automation/overrides');

const O = 'o-bg', WS = 'ws-bg', U = 'u-bg', PL = 'pl-bg', PROMO = 'pl-bg-promo';
const D = 'd-bg', D_OWN = 'd-bg-own';
let build;
let NOW = Math.floor(Date.now() / 1000);

before(() => {
  setupDeviceSocket(new Server(http.createServer()));
  build = setupDeviceSocket.buildPlaylistPayloadUnchecked;
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'bg@t.local', 'x', 'user')").run(U);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  const snap = JSON.stringify([{ content_id: null, widget_id: null, filename: 'x.png', mime_type: 'image/png', filepath: 'x.png', duration_sec: 10, sort_order: 0 }]);
  db.prepare("INSERT INTO playlists (id, user_id, workspace_id, name, status, published_snapshot) VALUES (?, ?, ?, 'Main', 'published', ?), (?, ?, ?, 'Promo', 'published', ?)")
    .run(PL, U, WS, snap, PROMO, U, WS, snap);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source, background_color) VALUES (?, ?, ?, ?, ?, ?, 'device', '#ff0000')")
    .run(D, U, WS, 'Lobby', 'bg0001', PL);
  db.prepare("INSERT INTO devices (id, user_id, workspace_id, name, pairing_code, playlist_id, playlist_source) VALUES (?, ?, ?, ?, ?, ?, 'device')")
    .run(D_OWN, U, WS, 'Plain', 'bg0002', PL);
  overrides._setClock(() => NOW);
});

const colourOf = (d) => build(d).background_color;

test('#660: with no playlist colour the device\'s own is sent, or none at all', () => {
  assert.equal(colourOf(D), '#ff0000');
  assert.equal(colourOf(D_OWN), null);
});

test('#660: a draft colour stays off screens; the published one wins over the device\'s', () => {
  db.prepare("UPDATE playlists SET background_color = '#ffffff' WHERE id = ?").run(PL);
  assert.equal(colourOf(D), '#ff0000', 'not published yet');
  db.prepare('UPDATE playlists SET published_background_color = background_color WHERE id = ?').run(PL);
  assert.equal(colourOf(D), '#ffffff');
  assert.equal(colourOf(D_OWN), '#ffffff');
});

test('#660: an override playlist brings its colour, and the screen\'s returns when it ends', () => {
  db.prepare("UPDATE playlists SET published_background_color = '#000080' WHERE id = ?").run(PROMO);
  db.prepare("INSERT INTO automation_overrides (id, workspace_id, scope_kind, scope_id, playlist_id, starts_at, ends_at) VALUES (?, ?, 'device', ?, ?, ?, ?)")
    .run('ov-bg', WS, D, PROMO, NOW - 1, NOW + 600);
  assert.equal(colourOf(D), '#000080');
  NOW += 601;
  overrides.tick(db);
  assert.equal(colourOf(D), '#ffffff', 'back to its own playlist\'s colour');
});

test('#660: clearing the playlist colour hands the screen back its own', () => {
  db.prepare('UPDATE playlists SET background_color = NULL, published_background_color = NULL WHERE id = ?').run(PL);
  assert.equal(colourOf(D), '#ff0000');
  assert.equal(colourOf(D_OWN), null);
});
