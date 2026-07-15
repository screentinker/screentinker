'use strict';

// #184 — YouTube Shorts aspect. Verifies the ingest side of Option A: a Short is
// detected (from the /shorts/ URL form OR portrait oEmbed dims) and persisted as
// st_aspect=vertical on the stored embed URL, which every player reads to render
// 9:16. A normal landscape video is left untagged.

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-yt-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const contentRouter = require('../routes/content');

db.pragma('foreign_keys = OFF'); // skip user/workspace FK setup for this unit

// Mock oEmbed. Capture the real fetch first so test HTTP calls still hit the server.
let oembedResponse = { title: 'Vid', height: 270, width: 480 };
let oembedOk = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => ({ ok: oembedOk, json: async () => oembedResponse });

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 'u1' }; req.workspaceId = 'ws1'; next(); });
app.use('/api/content', contentRouter);
const server = app.listen(0);
let base;
before(async () => { await new Promise(r => server.listening ? r() : server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); globalThis.fetch = realFetch; });

const addYoutube = async (url) => {
  const r = await realFetch(`${base}/api/content/youtube`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  return { status: r.status, body: await r.json() };
};

test('/shorts/ URL is tagged st_aspect=vertical', async () => {
  oembedResponse = { title: 'A Short', height: 200, width: 113 };
  const { status, body } = await addYoutube('https://www.youtube.com/shorts/3HiJYYIupd4');
  assert.equal(status, 201);
  assert.ok(/\/embed\/3HiJYYIupd4\?/.test(body.remote_url), 'embed URL built with the extracted id');
  assert.ok(/st_aspect=vertical/.test(body.remote_url), 'Short tagged vertical');
});

test('watch URL with portrait oEmbed dims is tagged vertical', async () => {
  oembedResponse = { title: 'Vertical watch', height: 1920, width: 1080 };
  const { body } = await addYoutube('https://www.youtube.com/watch?v=3HiJYYIupd4');
  assert.ok(/st_aspect=vertical/.test(body.remote_url), 'portrait dims -> vertical');
});

test('normal landscape watch URL is NOT tagged', async () => {
  oembedResponse = { title: 'Normal', height: 270, width: 480 };
  const { body } = await addYoutube('https://www.youtube.com/watch?v=abcdefghijk');
  assert.ok(!/st_aspect=vertical/.test(body.remote_url), 'landscape stays untagged');
});

test('/shorts/ URL is tagged even when oEmbed fails', async () => {
  oembedOk = false;
  const { body } = await addYoutube('https://www.youtube.com/shorts/zzzzzzzzzzz');
  assert.ok(/st_aspect=vertical/.test(body.remote_url), 'the /shorts/ form alone is sufficient');
  oembedOk = true;
});
