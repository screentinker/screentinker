'use strict';

// Visitor audio sync: per-content multilingual narration tracks (audio + optional WebVTT caption).
// Mirrors content-subtitles.test.js. Risky paths:
//   1. POST /:id/audio-tracks stores the audio (+ caption) and records a row per (content, lang).
//   2. the viewer shape (tracksForViewer) exposes public URLs, first track is default, delete unlinks.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'st-atracks-'));
process.env.DATA_DIR = TMP;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { db } = require('../db/database');
const audioTracks = require('../lib/content-audio-tracks');

const uid = (p) => p + '-' + crypto.randomBytes(4).toString('hex');
const USER = 'u-atracks';

let server, base;

before(async () => {
  fs.mkdirSync(require('../config').contentDir, { recursive: true });
  db.prepare("INSERT INTO users (id, email, password_hash, plan_id) VALUES (?, ?, 'x', 'free')").run(USER, USER + '@t.local');
  const app = express();
  app.use((req, _res, next) => { req.workspaceId = 'ws-atracks'; req.user = { id: USER, role: 'platform_admin' }; next(); });
  app.use('/', require('../routes/content'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

// Build a multipart body from a list of { name, filename?, contentType?, value }.
function multipart(parts) {
  const boundary = '----st' + crypto.randomBytes(6).toString('hex');
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head), Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

function postForm(url, parts) {
  const { boundary, body } = multipart(parts);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (r) => { let o = ''; r.on('data', (d) => (o += d)); r.on('end', () => resolve({ status: r.statusCode, json: safeParse(o) })); });
    req.on('error', reject);
    req.end(body);
  });
}

function reqJson(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (r) => { let o = ''; r.on('data', (d) => (o += d)); r.on('end', () => resolve({ status: r.statusCode, json: safeParse(o) })); });
    req.on('error', reject);
    req.end();
  });
}

test('POST stores an audio track + caption, first track is default, files land on disk', async () => {
  const c = uid('vid');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);

  const res = await postForm(`${base}/${c}/audio-tracks`, [
    { name: 'lang', value: 'en' },
    { name: 'label', value: 'English' },
    { name: 'audio', filename: 'track.m4a', contentType: 'audio/mp4', value: Buffer.from('FAKE-AUDIO-BYTES') },
    { name: 'caption', filename: 'cap.vtt', contentType: 'text/vtt', value: 'WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n' },
  ]);
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const t = res.json.tracks.find((x) => x.lang === 'en');
  assert.ok(t, 'track listed');
  assert.equal(t.is_default, 1, 'first track becomes default');
  assert.match(t.audio_url, /^\/uploads\/content\/.+\.m4a$/);
  assert.match(t.caption_url, /^\/uploads\/content\/.+\.vtt$/);

  // files physically exist
  assert.ok(fs.existsSync(path.join(require('../config').contentDir, path.basename(t.audio_url))));
  assert.ok(fs.existsSync(path.join(require('../config').contentDir, path.basename(t.caption_url))));

  // viewer shape exposes public URLs only, no internal keys
  const viewer = audioTracks.tracksForViewer(c);
  assert.equal(viewer.length, 1);
  assert.equal(viewer[0].lang, 'en');
  assert.ok(viewer[0].audio_url.startsWith('/uploads/content/'));
  assert.equal(viewer[0].audio_key, undefined);
});

test('a second language is added without stealing default; GET lists both', async () => {
  const c = uid('vid');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);
  await postForm(`${base}/${c}/audio-tracks`, [
    { name: 'lang', value: 'en' },
    { name: 'audio', filename: 'a.m4a', contentType: 'audio/mp4', value: Buffer.from('EN') },
  ]);
  await postForm(`${base}/${c}/audio-tracks`, [
    { name: 'lang', value: 'fr' },
    { name: 'audio', filename: 'b.m4a', contentType: 'audio/mp4', value: Buffer.from('FR') },
  ]);
  const list = await reqJson('GET', `${base}/${c}/audio-tracks`);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  assert.equal(list.json.find((x) => x.lang === 'en').is_default, 1);
  assert.equal(list.json.find((x) => x.lang === 'fr').is_default, 0);
});

test('a non-audio upload is rejected', async () => {
  const c = uid('vid');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);
  const res = await postForm(`${base}/${c}/audio-tracks`, [
    { name: 'lang', value: 'en' },
    { name: 'audio', filename: 'notaudio.txt', contentType: 'text/plain', value: 'nope' },
  ]);
  assert.notEqual(res.status, 200);
});

test('DELETE removes the track row and unlinks its audio file', async () => {
  const c = uid('vid');
  db.prepare("INSERT INTO content (id, filename, mime_type, filepath) VALUES (?, ?, 'video/mp4', 'v.mp4')").run(c, c);
  const created = await postForm(`${base}/${c}/audio-tracks`, [
    { name: 'lang', value: 'es' },
    { name: 'audio', filename: 'es.m4a', contentType: 'audio/mp4', value: Buffer.from('ES') },
  ]);
  const onDisk = path.join(require('../config').contentDir, path.basename(created.json.tracks[0].audio_url));
  assert.ok(fs.existsSync(onDisk));

  const del = await reqJson('DELETE', `${base}/${c}/audio-tracks/es`);
  assert.equal(del.status, 200);
  assert.equal(del.json.ok, true);
  assert.equal(audioTracks.listTracks(c).length, 0);
  assert.ok(!fs.existsSync(onDisk), 'audio file unlinked on delete');
});
