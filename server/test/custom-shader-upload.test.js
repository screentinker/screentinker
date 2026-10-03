'use strict';

/*
 * #320: an operator uploads their own GLSL transition, and it reaches the screens.
 *
 * shared/Transitions/ stays a first-party set so docs/licensing.md can keep making a flat claim.
 * An uploaded shader is the customer's content and licence, stored per workspace, never entering
 * the shipped library or a release.
 *
 * The delivery is the interesting part and the reason this is small: every player already resolves
 * a shader as an id to a GLSL string, so the source travels with the playlist and each player
 * merges it into the lookup it already has. No endpoint, no download, no cache to invalidate.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { freePort } = require('./helpers/free-port');
let PORT, BASE, jwt;
const DATA_DIR = path.join(os.tmpdir(), 'st-cs-' + crypto.randomBytes(4).toString('hex'));
let proc;

const post = (o) => ({ method: 'POST', headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });
const del = () => ({ method: 'DELETE', headers: { Authorization: 'Bearer ' + jwt } });
const get = () => ({ headers: { Authorization: 'Bearer ' + jwt } });

const GOOD = `// My Fade
// blurb: a plain dissolve of my own
// Author: An Operator
// License: MIT
uniform float amount; // = 0.5 [0.0..1.0]

vec4 transition(vec2 uv){
  return mix(getFromColor(uv), getToColor(uv), progress * amount);
}
`;

before(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const logFd = fs.openSync(path.join(os.tmpdir(), 'st-cs.log'), 'w');
  proc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR, SELF_HOSTED: 'true', PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', logFd, logFd],
  });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/status'); if (r.ok) { up = true; break; } } catch { /* */ } await new Promise(r => setTimeout(r, 250)); }
  if (!up) throw new Error('server did not boot');
  const email = 'cs' + crypto.randomBytes(4).toString('hex') + '@x.local';
  jwt = (await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd123' }) })).json()).token;
});
after(() => { try { proc.kill('SIGKILL'); } catch { /* */ } });

test('#320: a valid shader uploads, and its header and params are read like a shipped one', async () => {
  const r = await fetch(BASE + '/api/transitions/custom', post({ source: GOOD }));
  assert.equal(r.status, 201);
  const s = await r.json();
  assert.match(s.shader_id, /^custom-/, 'ids are prefixed so they can never shadow a built-in');
  assert.equal(s.name, 'My Fade', 'the name comes from the first comment line, as generate-manifest does');
  assert.equal(s.blurb, 'a plain dissolve of my own');
  assert.deepEqual(s.params.map((p) => p.name), ['amount'], 'uniforms are parsed by the shared parser');
});

test('#320: a shader without the entry point is refused with a reason', async () => {
  const r = await fetch(BASE + '/api/transitions/custom', post({ source: '// nope\nvoid main(){}\n' }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /vec4 `?transition/i);
});

test('#320: #include is refused rather than reasoned about', async () => {
  const src = GOOD.replace('uniform float', '#include "x.glsl"\nuniform float');
  const r = await fetch(BASE + '/api/transitions/custom', post({ source: src }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /include/i);
});

test('#320: an oversized shader is refused', async () => {
  const r = await fetch(BASE + '/api/transitions/custom', post({ source: GOOD + '\n// ' + 'x'.repeat(70 * 1024) }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /larger than/i);
});

test('#320: too many parameters is refused (an unusable picker is not a shader)', async () => {
  const many = GOOD.replace('uniform float amount; // = 0.5 [0.0..1.0]',
    Array.from({ length: 12 }, (_, i) => `uniform float p${i}; // = 0.5 [0.0..1.0]`).join('\n'));
  const r = await fetch(BASE + '/api/transitions/custom', post({ source: many }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /at most/i);
});

test('#320: uploads are listed and can be deleted', async () => {
  const created = await (await fetch(BASE + '/api/transitions/custom', post({ source: GOOD, name: 'Deletable' }))).json();
  const list = await (await fetch(BASE + '/api/transitions/custom', get())).json();
  assert.ok(list.some((x) => x.id === created.id), 'appears in the list');
  assert.equal((await fetch(BASE + '/api/transitions/custom/' + created.id, del())).status, 200);
  const after = await (await fetch(BASE + '/api/transitions/custom', get())).json();
  assert.ok(!after.some((x) => x.id === created.id), 'and is gone');
});

// ---- the delivery half ----

test('#320: the resolver accepts a custom id only when the workspace registry is supplied', () => {
  const { resolveTransitionConfig } = require('../lib/transition-config');
  assert.equal(resolveTransitionConfig({ shaders: ['custom-x'] }), null,
    'unknown without a registry -> no transition -> the player hard-cuts');
  const reg = new Map([['custom-x', { id: 'custom-x', params: [{ name: 'amount', default: 0.5, min: 0, max: 1 }] }]]);
  const out = resolveTransitionConfig({ shaders: ['custom-x'], params: { 'custom-x': { amount: 9 } } }, reg);
  assert.equal(out.effects[0].shader, 'custom-x');
  assert.equal(out.effects[0].params.amount, 1, 'and its params are clamped like a shipped shader');
});

test('#320: a built-in can never be shadowed by an upload', () => {
  const { resolveTransitionConfig, MANIFEST } = require('../lib/transition-config');
  const builtin = MANIFEST[0].id;
  const hostile = new Map([[builtin, { id: builtin, params: [] }]]);
  const out = resolveTransitionConfig({ shaders: [builtin] }, hostile);
  assert.equal(out.effects[0].shader, builtin);
  assert.ok(out.effects[0].params && Object.keys(out.effects[0].params).length > 0,
    'resolved against the shipped manifest entry, not the registry one');
});

test('#320: every player merges the sources into the lookup it already has', () => {
  const web = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(web, /data\.custom_shaders/, 'web player reads the field');
  assert.match(web, /window\.__TRANSITION_SHADERS\[id\] = data\.custom_shaders\[id\]/, 'and merges it');
  const tizen = fs.readFileSync(path.join(__dirname, '..', '..', 'tizen', 'js', 'app.js'), 'utf8');
  assert.match(tizen, /mergeCustomShaders\(payload\.custom_shaders\)/, 'tizen merges on the payload');
  const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'android', 'app', 'src', 'main', 'java',
    'com', 'remotedisplay', 'player', 'player', 'TransitionCompositor.kt'), 'utf8');
  assert.match(kt, /uploaded\[shaderId\]\?\.let \{ return it \}/, 'android checks uploads before assets');
  assert.match(kt, /if \(k\.startsWith\("custom-"\)\) uploaded\[k\] = v/, 'and refuses to hold a non-custom id');
});

// ---------------------------------------------------------------------------
// Tenancy: isolated per workspace, capped per organisation.
// ---------------------------------------------------------------------------

const Database = require('better-sqlite3');

test('#320: one workspace cannot read or delete another workspace\'s shader', async () => {
  // A second, unrelated account -> its own workspace and its own organisation.
  const email2 = 'cs2' + crypto.randomBytes(4).toString('hex') + '@x.local';
  const jwt2 = (await (await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email2, password: 'Passw0rd123' }),
  })).json()).token;
  const auth2 = (extra) => ({ headers: { Authorization: 'Bearer ' + jwt2, ...(extra || {}) } });

  const mine = await (await fetch(BASE + '/api/transitions/custom', post({ source: GOOD, name: 'Mine Only' }))).json();
  // They upload one too, so the isolation is two-way and the payload fixture below is real.
  const theirs = await (await fetch(BASE + '/api/transitions/custom', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt2, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: GOOD, name: 'Theirs Only' }),
  })).json();

  // Each sees only its own.
  const theirList = await (await fetch(BASE + '/api/transitions/custom', auth2())).json();
  assert.ok(!theirList.some((x) => x.id === mine.id), 'another workspace does not list mine');
  assert.ok(theirList.some((x) => x.id === theirs.id), 'but does list its own');
  const myList = await (await fetch(BASE + '/api/transitions/custom', get())).json();
  assert.ok(!myList.some((x) => x.id === theirs.id), 'and I do not list theirs');

  // They cannot delete it.
  const delRes = await fetch(BASE + '/api/transitions/custom/' + mine.id, {
    method: 'DELETE', ...auth2(),
  });
  assert.equal(delRes.status, 403, 'deleting across workspaces is refused');

  // And it is still there afterwards.
  const stillMine = await (await fetch(BASE + '/api/transitions/custom', get())).json();
  assert.ok(stillMine.some((x) => x.id === mine.id), 'and it survived the attempt');
});

test('#320: a device is only ever sent its OWN workspace\'s shaders', () => {
  const db = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT workspace_id, shader_id FROM custom_shaders').all();
    const byWs = new Map();
    for (const r of rows) byWs.set(r.workspace_id, (byWs.get(r.workspace_id) || 0) + 1);
    assert.ok(byWs.size >= 2, 'the fixture really does have two workspaces holding shaders');

    // The payload helpers select on workspace_id, so a device in workspace A can never be handed a
    // shader stored against workspace B. Assert the query shape rather than trusting the comment.
    const ds = fs.readFileSync(path.join(__dirname, '..', 'ws', 'deviceSocket.js'), 'utf8');
    assert.match(ds, /FROM custom_shaders WHERE workspace_id = \?/,
      'the registry is scoped to the device workspace');
    assert.match(ds, /WHERE workspace_id = \? AND shader_id = \?/,
      'and so is each source lookup');
    assert.match(ds, /customShaderRegistry\(workspace_id\)/, 'using the device row workspace');
  } finally { db.close(); }
});

test('#320: the cap counts across the whole organisation, not one workspace', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'custom-shaders.js'), 'utf8');
  assert.match(route, /const MAX_PER_ORG/, 'the limit is named per organisation');
  assert.match(route, /JOIN workspaces w ON w\.id = cs\.workspace_id/,
    'counting joins through workspaces');
  assert.match(route, /WHERE w\.organization_id = \?/, 'and groups by the organisation');
  assert.doesNotMatch(route, /MAX_PER_WORKSPACE/, 'the per-workspace cap is gone');
});
