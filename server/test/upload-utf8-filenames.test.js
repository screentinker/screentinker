'use strict';

/*
 * Non-ASCII upload filenames survive multipart parsing exactly once-decoded. Browsers and curl send
 * them as raw UTF-8 in `filename="..."`; multer 1 handed busboy's latin1 reading to us and
 * middleware/upload.js re-decoded it, but multer 2 passes defParamCharset through, so that same
 * re-decode turned every such name into U+FFFD. This drives the real middleware with raw bytes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-upload-utf8-'));
const config = require('../config');
config.contentDir = tmp;

const upload = require('../middleware/upload');
const mw = upload.fields([{ name: 'files', maxCount: 60 }]);

let server;
test.before(() => new Promise((ok) => {
  server = http.createServer((req, res) => mw(req, res, (err) => {
    const files = Object.values(req.files || {}).flat();
    for (const f of files) fs.rmSync(f.path, { force: true });
    res.end(JSON.stringify(err ? { err: err.code || err.message } : { names: files.map((f) => f.originalname) }));
  })).listen(0, '127.0.0.1', ok);
}));
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function post(disposition) {
  return new Promise((ok, fail) => {
    const B = 'stUtf8Boundary';
    const body = Buffer.concat([
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="files"; `),
      disposition,
      Buffer.from(`\r\nContent-Type: video/mp4\r\n\r\nx\r\n--${B}--\r\n`),
    ]);
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${B}`, 'content-length': body.length },
    }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => ok(JSON.parse(d))); });
    r.on('error', fail);
    r.end(body);
  });
}

for (const name of ['café.mp4', '日本語.mp4', 'Begrüßung.mp4', 'plain.mp4']) {
  test(`raw UTF-8 filename="${name}" comes through intact`, async () => {
    assert.deepStrictEqual(await post(Buffer.from(`filename="${name}"`, 'utf8')), { names: [name] });
  });
}

test('RFC 5987 filename*=UTF-8\'\'… comes through intact', async () => {
  assert.deepStrictEqual(await post(Buffer.from("filename*=UTF-8''caf%C3%A9.mp4")), { names: ['café.mp4'] });
});
