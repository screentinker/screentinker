'use strict';

/*
 * Express 5 refuses a dot-segment anywhere in an absolute res.sendFile path; the server's pages must
 * still load from an install that lives under a dot-directory (~/.local/...). A dotfile itself must
 * still be refused, as it was under Express 4.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { sendFileCompat } = require('../middleware/send-file-compat');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sendfile-'));
const dotDir = path.join(root, '.local', 'share', 'screentinker');
fs.mkdirSync(dotDir, { recursive: true });
fs.writeFileSync(path.join(dotDir, 'index.html'), '<h1>shell</h1>');
fs.writeFileSync(path.join(dotDir, '.secret'), 'nope');

function serve(withCompat) {
  const app = express();
  if (withCompat) app.use(sendFileCompat);
  app.get('/page', (req, res) => res.sendFile(path.join(dotDir, 'index.html')));
  app.get('/dotfile', (req, res) => res.sendFile(path.join(dotDir, '.secret')));
  app.get('/cb', (req, res) => res.sendFile(path.join(dotDir, 'index.html'), (err) => { if (err) res.status(500).end(); }));
  app.get('/rooted', (req, res) => res.sendFile('index.html', { root: dotDir, dotfiles: 'allow' }));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

let compat, bare;
before(async () => { compat = await serve(true); bare = await serve(false); });
after(() => { compat.close(); bare.close(); fs.rmSync(root, { recursive: true, force: true }); });
const get = (srv, p) => fetch(`http://127.0.0.1:${srv.address().port}${p}`);

test('without the shim, Express 5 404s a page that lives under a dot-directory (why it exists)', async () => {
  assert.equal((await get(bare, '/page')).status, 404);
});

test('with it, the page is served', async () => {
  const r = await get(compat, '/page');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<h1>shell</h1>');
});

test('a dotfile itself is still refused', async () => {
  assert.equal((await get(compat, '/dotfile')).status, 404);
});

test('the callback form and an explicit root still work', async () => {
  assert.equal((await get(compat, '/cb')).status, 200);
  assert.equal((await get(compat, '/rooted')).status, 200);
});
