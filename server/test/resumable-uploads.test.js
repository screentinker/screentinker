'use strict';

/*
 * Resumable uploads.
 *
 * ⚠️ THE BUG THIS EXISTS FOR, as measured on prod rather than imagined: a customer in Perth
 * uploading to a Hetzner box failed SEVEN times at 125.008-125.012 seconds — a hard ceiling at
 * Cloudflare — while his 65 successful uploads in the same session peaked at 114.2s. He was living
 * inside a ten-second margin. Selecting several files made it certain, because the dashboard sent
 * them as ONE request (#212), so the bytes scaled but the 125 seconds did not.
 *
 * The assertions below are therefore about the properties that make a slow, distant, unreliable
 * link work — not about whether a happy-path POST returns 201:
 *
 *   - the offset survives the client going away entirely (the actual definition of resumable)
 *   - a chunk that is sent twice is refused in a way the client can act on, not silently applied
 *   - the declared size is a CEILING, not a promise to be trusted
 *   - the finished file goes through the SAME ingest as a single-shot upload
 *   - a tenant cannot see, resume, or finalize another tenant's upload
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
const DATA_DIR = path.join(os.tmpdir(), 'st-ru-' + crypto.randomBytes(4).toString('hex'));
const LOG = DATA_DIR + '.log';
let PORT, BASE, proc, jwt, workspaceId;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const J = (tok, body, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const api = (p) => `${BASE}/api/content${p}`;

/*
 * A real PNG, because the ingest SNIFFS the bytes and refuses anything it does not recognise —
 * a buffer of zeroes would be rejected at finalize and every test here would pass for the wrong
 * reason. Padded with a trailing comment-ish tail so it is big enough to chunk.
 */
function pngOf(totalBytes) {
  const header = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const pad = Buffer.alloc(Math.max(0, totalBytes - header.length), 0x20);
  return Buffer.concat([header, pad]);
}

async function createSession(bytes, filename = 'big.png', tok = null) {
  const r = await fetch(api('/uploads'), J(tok || jwt, { filename, size: bytes.length }));
  return { status: r.status, body: await r.json() };
}

function patch(id, offset, chunk, tok = null) {
  return fetch(api(`/uploads/${id}`), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${tok || jwt}`,
      'Content-Type': 'application/octet-stream',
      'Upload-Offset': String(offset),
    },
    body: chunk,
  });
}

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(LOG, 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ }
    await sleep(250);
  }
  if (!up) throw new Error('server did not boot:\n' + fs.readFileSync(LOG, 'utf8').slice(-2000));

  const reg = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `ru${Date.now()}@example.com`, password: 'Passw0rd123', name: 'RU',
  }))).json();
  jwt = reg.token;
  workspaceId = reg.current_workspace_id;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

/* --------------------------------------------------------------- the happy path, in chunks */

test('a file uploaded in several chunks lands as ordinary library content', async () => {
  const bytes = pngOf(300 * 1024);
  const { status, body } = await createSession(bytes, 'chunked.png');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.offset, 0);
  assert.ok(body.chunk_size > 0);

  const CH = 100 * 1024;
  let offset = 0;
  while (offset < bytes.length) {
    const slice = bytes.subarray(offset, offset + CH);
    const r = await patch(body.id, offset, slice);
    // Read the body ONCE: a fetch Response can only be consumed once, so using `await r.text()`
    // as the assertion message and then calling r.json() throws "Body has already been read".
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    offset = j.offset;
  }
  assert.equal(offset, bytes.length);

  const fin = await fetch(api(`/uploads/${body.id}/finalize`), J(jwt, {}));
  const content = await fin.json();
  assert.equal(fin.status, 201, JSON.stringify(content));

  // ⚠️ The point of reusing ingestUploadedFile: the row is indistinguishable from a single-shot
  // upload — sniffed mime, real size, a digest for mesh dedup.
  assert.equal(content.filename, 'chunked.png');
  assert.equal(content.file_size, bytes.length);
  assert.match(content.mime_type, /^image\//);
  assert.ok(content.byte_digest, 'the digest must be set, exactly as for a single-shot upload');
  assert.ok(content.filepath && !content.filepath.endsWith('.part'), 'the part extension must be gone');
});

/* ------------------------------------------------ the property that makes it "resumable" */

test('⚠️ the offset survives the client vanishing — this is the whole feature', async () => {
  /*
   * Sean's browser did not politely negotiate; the request died at 125 seconds. A resumable upload
   * has to answer "where was I" to a client that kept NOTHING but the session id — which is why
   * the offset is read from the bytes on disk rather than from a counter the client maintains.
   */
  const bytes = pngOf(200 * 1024);
  const { body } = await createSession(bytes, 'interrupted.png');

  await patch(body.id, 0, bytes.subarray(0, 120 * 1024));

  // Everything the "client" remembers is this id. Ask the server where it got to.
  const head = await fetch(api(`/uploads/${body.id}`), { method: 'HEAD', headers: { Authorization: `Bearer ${jwt}` } });
  assert.equal(head.status, 204);
  assert.equal(head.headers.get('Upload-Offset'), String(120 * 1024));
  assert.equal(head.headers.get('Upload-Length'), String(bytes.length));

  const info = await (await fetch(api(`/uploads/${body.id}`), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(info.offset, 120 * 1024);
  assert.equal(info.filename, 'interrupted.png', 'a resume prompt needs to say WHAT it is resuming');

  // Carry on from exactly there.
  const r = await patch(body.id, info.offset, bytes.subarray(info.offset));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).offset, bytes.length);

  const fin = await fetch(api(`/uploads/${body.id}/finalize`), J(jwt, {}));
  assert.equal(fin.status, 201);
  assert.equal((await fin.json()).file_size, bytes.length, 'the reassembled file must be byte-exact');
});

test('a chunk sent twice is refused, and the refusal says where to go', async () => {
  // A client that lost a response would otherwise duplicate bytes into the middle of the file and
  // produce a corrupt image that only fails much later, at playback, on a screen.
  const bytes = pngOf(60 * 1024);
  const { body } = await createSession(bytes, 'dup.png');
  const first = bytes.subarray(0, 30 * 1024);

  assert.equal((await patch(body.id, 0, first)).status, 200);
  const again = await patch(body.id, 0, first);
  assert.equal(again.status, 409);
  const err = await again.json();
  assert.equal(err.offset, 30 * 1024, 'the 409 must name the current offset so the client self-corrects');

  // And the correction works in one round trip.
  assert.equal((await patch(body.id, err.offset, bytes.subarray(err.offset))).status, 200);
});

test('a chunk from the future is refused too — no sparse files', async () => {
  const bytes = pngOf(60 * 1024);
  const { body } = await createSession(bytes, 'gap.png');
  const r = await patch(body.id, 40 * 1024, bytes.subarray(40 * 1024));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).offset, 0);
});

/* ------------------------------------------------------------------- limits and lying clients */

test('⚠️ the declared size is a CEILING, not a promise', async () => {
  /*
   * The storage allowance is checked at create against a number the CLIENT chose. If the ceiling
   * were not enforced on every append, a client could declare 1KB and then stream for ever, one
   * honest-looking chunk at a time, until the disk filled.
   */
  const bytes = pngOf(50 * 1024);
  const r = await fetch(api('/uploads'), J(jwt, { filename: 'liar.png', size: 1024 }));
  const session = await r.json();
  const over = await patch(session.id, 0, bytes);
  assert.equal(over.status, 413);
  assert.match((await over.json()).error, /declared/i);
});

test('finalize refuses an incomplete upload and says what is missing', async () => {
  const bytes = pngOf(80 * 1024);
  const { body } = await createSession(bytes, 'partial.png');
  await patch(body.id, 0, bytes.subarray(0, 40 * 1024));

  const fin = await fetch(api(`/uploads/${body.id}/finalize`), J(jwt, {}));
  assert.equal(fin.status, 409);
  const j = await fin.json();
  assert.equal(j.offset, 40 * 1024);
  assert.equal(j.declared_size, bytes.length);
});

test('a session refuses a size beyond the server file limit up front', async () => {
  const r = await fetch(api('/uploads'), J(jwt, { filename: 'huge.mp4', size: 10 * 1024 * 1024 * 1024 }));
  assert.equal(r.status, 413);
});

test('a bad create is refused before any bytes move', async () => {
  for (const bad of [{ filename: 'x.png' }, { size: 10 }, { filename: 'x.png', size: 0 }, { filename: 'x.png', size: -5 }]) {
    const r = await fetch(api('/uploads'), J(jwt, bad));
    assert.equal(r.status, 400, `should refuse ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------------------------------------------------------- tenancy */

test('another workspace cannot see, resume, finalize or cancel this upload', async () => {
  const bytes = pngOf(60 * 1024);
  const { body } = await createSession(bytes, 'mine.png');
  await patch(body.id, 0, bytes.subarray(0, 20 * 1024));

  const other = await (await fetch(BASE + '/api/auth/register', J(null, {
    email: `ru-other${Date.now()}@example.com`, password: 'Passw0rd123', name: 'Other',
  }))).json();
  const H = { headers: { Authorization: `Bearer ${other.token}` } };

  assert.equal((await fetch(api(`/uploads/${body.id}`), { method: 'HEAD', ...H })).status, 404);
  assert.equal((await fetch(api(`/uploads/${body.id}`), H)).status, 404);
  assert.equal((await patch(body.id, 20 * 1024, bytes.subarray(20 * 1024), other.token)).status, 404);
  assert.equal((await fetch(api(`/uploads/${body.id}/finalize`), J(other.token, {}))).status, 404);

  // ...and ours is untouched by any of that.
  const info = await (await fetch(api(`/uploads/${body.id}`), { headers: { Authorization: `Bearer ${jwt}` } })).json();
  assert.equal(info.offset, 20 * 1024);
});

test('cancelling removes the bytes, and is idempotent', async () => {
  const bytes = pngOf(40 * 1024);
  const { body } = await createSession(bytes, 'cancelled.png');
  await patch(body.id, 0, bytes.subarray(0, 20 * 1024));

  assert.equal((await fetch(api(`/uploads/${body.id}`), J(jwt, undefined, 'DELETE'))).status, 200);
  assert.equal((await fetch(api(`/uploads/${body.id}`), { headers: { Authorization: `Bearer ${jwt}` } })).status, 404);
  // A client that already forgot gets the same answer rather than an error it cannot act on.
  assert.equal((await fetch(api(`/uploads/${body.id}`), J(jwt, undefined, 'DELETE'))).status, 200);
});

test('rubbish bytes are refused at finalize, by the same sniffer a single-shot upload uses', async () => {
  const junk = Buffer.alloc(4096, 0x00);
  const r = await fetch(api('/uploads'), J(jwt, { filename: 'notmedia.png', size: junk.length }));
  const session = await r.json();
  assert.equal((await patch(session.id, 0, junk)).status, 200);

  const fin = await fetch(api(`/uploads/${session.id}/finalize`), J(jwt, {}));
  assert.equal(fin.status, 400, 'the content sniffer must judge these bytes exactly as it would a form upload');

  // And the spent session is gone, so a client cannot retry a finalize that can never succeed.
  assert.equal((await fetch(api(`/uploads/${session.id}`), { headers: { Authorization: `Bearer ${jwt}` } })).status, 404);
});

test('⚠️ the stored file EXISTS at the path the row claims', async () => {
  /*
   * This is the regression guard for a bug the digest assertion above only hinted at.
   *
   * upload-sniff.finalizeUpload renames the temp file WITHIN ITS OWN DIRECTORY, because multer
   * always wrote it straight into contentDir. The first version of the resumable path assembled
   * into `incoming/` and handed that file over, so the sniffer renamed it in `incoming/`, reported
   * the bare filename, and the row pointed at `contentDir/<uuid>.<ext>` — which did not exist. The
   * endpoint returned 201. The media was unplayable, and nothing said so until a screen showed
   * nothing.
   *
   * So: assert on the filesystem, not on the status code.
   */
  const bytes = pngOf(150 * 1024);
  const { body } = await createSession(bytes, 'exists.png');
  let offset = 0;
  while (offset < bytes.length) {
    const r = await patch(body.id, offset, bytes.subarray(offset, offset + 64 * 1024));
    offset = (await r.json()).offset;
  }
  const content = await (await fetch(api(`/uploads/${body.id}/finalize`), J(jwt, {}))).json();

  const onDisk = path.join(DATA_DIR, 'uploads', 'content', content.filepath);
  assert.ok(fs.existsSync(onDisk), `row says ${content.filepath} but nothing is there`);
  assert.equal(fs.statSync(onDisk).size, bytes.length, 'and it must be the whole file');

  // Nothing is left behind in the staging area either.
  const incoming = path.join(DATA_DIR, 'uploads', 'incoming');
  const leftovers = fs.existsSync(incoming) ? fs.readdirSync(incoming).filter((f) => f.startsWith(body.id)) : [];
  assert.deepEqual(leftovers, [], 'the part file must not survive a successful finalize');
});
