'use strict';

/*
 * The screenshot file a screen's frame is kept in (ws/deviceSocket persistScreenshot, code-scanning
 * js/path-injection): `<device id>_latest.jpg`, directly in the screenshots folder. The id is an
 * authenticated screen's own, so this pins the ordinary case unchanged and that an id which is not
 * a plain name can never write anywhere else.
 */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-shot-path-'));
process.env.DATA_DIR = tmp;

const config = require('../config');
const { db } = require('../db/database');
const deviceSocket = require('../ws/deviceSocket');
const { Server } = require('socket.io');
const ioServer = http.createServer();
const io = new Server(ioServer);
deviceSocket(io);

after(() => { io.close(); ioServer.close(); });

const B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');

test('a screen\'s frame is kept as <id>_latest.jpg in the screenshots folder, with its row', () => {
  fs.mkdirSync(config.screenshotsDir, { recursive: true });
  const id = '0b7c1f9e-2d4a-4c55-9f1e-8a3b2c1d0e9f';
  db.prepare("INSERT INTO devices (id, name) VALUES (?, 'Lobby')").run(id);
  assert.equal(deviceSocket.ingestScreenshot(id, B64), true);
  const file = path.join(config.screenshotsDir, `${id}_latest.jpg`);
  assert.deepEqual(fs.readFileSync(file), Buffer.from(B64, 'base64'));
  assert.equal(db.prepare('SELECT filepath FROM screenshots WHERE device_id = ?').get(id).filepath, `${id}_latest.jpg`);
});

test('⚠️ an id with a path in it writes nothing, inside the folder or out of it', () => {
  fs.mkdirSync(config.screenshotsDir, { recursive: true });
  const before = fs.readdirSync(config.screenshotsDir).sort();
  for (const id of ['../escape', '../../escape2', 'sub/dir']) {
    deviceSocket.ingestScreenshot(id, B64);
  }
  assert.ok(!fs.existsSync(path.join(config.uploadsDir, 'escape_latest.jpg')));
  assert.ok(!fs.existsSync(path.join(tmp, 'escape2_latest.jpg')));
  assert.ok(!fs.existsSync(path.join(config.screenshotsDir, 'sub')));
  assert.deepEqual(fs.readdirSync(config.screenshotsDir).sort(), before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM screenshots WHERE device_id IN ('../escape', '../../escape2', 'sub/dir')").get().n, 0);
});
