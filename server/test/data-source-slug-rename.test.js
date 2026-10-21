'use strict';

/*
 * Renaming a data source's slug, and the names it is given in the first place.
 *
 * Slides and widgets bind to a source by its slug ({{ds:slug.key}}, a menu board's source.slug, a
 * template widget's data_source values + ds_refs). A new slug used to leave every one of them on the
 * old name, rendering empty with no warning. Now GET /:id/references lists them and PUT with
 * rewrite_tags: true moves them to the new name — in the live config and any pending draft — and
 * nothing else (not another workspace, not a source whose slug merely starts the same).
 *
 * Also: an auto slug keeps accented letters as their plain form ("Café menu" → cafe_menu).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { freePort } = require('./helpers/free-port');
const { rewriteConfig } = require('../lib/data-sources/slug-refs');

const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'st-ds-slug-'));
const DATA_DIR = path.join(TMP, 'data');
let BASE;
let proc;
let sqlite;
const U = {};

async function api(who, method, p, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && who.token) headers.Authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, text, json };
}

test('rewriteConfig: tags in any string, a menu board source, template values and ds_refs', () => {
  const cfg = {
    fields: { title: 'Latte {{ds:menu.latte_price}} / {{DS:Menu.flat_white}}', other: '{{ds:menu_b.x}} {{ds:menus.y}}' },
    list: ['{{ds:menu.a}}', 3, null],
    source: { slug: 'menu' },
    values: { src: 'menu', heading: 'menu' },
    ds_refs: [{ slug: 'menu' }],
  };
  assert.equal(rewriteConfig(cfg, 'menu', 'carte', ['src']), true);
  assert.equal(cfg.fields.title, 'Latte {{ds:carte.latte_price}} / {{ds:carte.flat_white}}');
  assert.equal(cfg.fields.other, '{{ds:menu_b.x}} {{ds:menus.y}}', 'another source whose slug starts the same is left alone');
  assert.deepEqual(cfg.list, ['{{ds:carte.a}}', 3, null]);
  assert.deepEqual(cfg.source, { slug: 'carte' });
  assert.deepEqual(cfg.values, { src: 'carte', heading: 'menu' }, 'only the data_source param, not a text param that happens to match');
  assert.deepEqual(cfg.ds_refs, [{ slug: 'carte' }]);
  assert.equal(rewriteConfig({ fields: { a: 'plain' }, values: { src: 'menu' } }, 'menu', 'carte'), false, 'no ds_refs: a value is not taken for a slug');
});

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(TMP, 'server.log'), 'w');
  const env = { ...process.env };
  delete env.DISABLE_REGISTRATION;
  Object.assign(env, { DATA_DIR, SELF_HOSTED: 'true', PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', JWT_SECRET: 'ds-slug-' + crypto.randomBytes(8).toString('hex') });
  proc = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', logFd, logFd] });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(BASE + '/api/status')).ok; } catch { /* booting */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) throw new Error('server did not boot; see ' + path.join(TMP, 'server.log'));
  let n = 0;
  const reg = async (email) => {
    const r = await api(null, 'POST', '/api/auth/register', { email, password: 'Passw0rd123!', createOrg: true }, { 'X-Forwarded-For': `192.0.2.${++n}` });
    assert.equal(r.status, 201, `register ${email}: ${r.text}`);
    return { token: r.json.token, id: r.json.user.id, ws: r.json.current_workspace_id };
  };
  U.admin = await reg('admin@slug.local');
  U.a = await reg('owner-a@slug.local');
  U.b = await reg('owner-b@slug.local');
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(DATA_DIR, 'db', 'remote_display.db'));
  sqlite.pragma('busy_timeout = 5000');
});

after(() => {
  try { if (proc) proc.kill('SIGKILL'); } catch { /* */ }
  try { if (sqlite) sqlite.close(); } catch { /* */ }
  if (!process.env.KEEP_TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } }
});

const table = { columns: ['Item', 'Price'], rows: [['Latte', '3.80']], key_column: 'Item' };
function widget(who, type, name, config, draft) {
  const id = crypto.randomUUID();
  sqlite.prepare('INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, draft_config, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1000)')
    .run(id, who.id, who.ws, type, name, JSON.stringify(config), draft ? JSON.stringify(draft) : null);
  return id;
}
const cfgOf = (id) => JSON.parse(sqlite.prepare('SELECT config FROM widgets WHERE id = ?').get(id).config);

test('an auto slug folds accents instead of dropping the letter', async () => {
  const r = await api(U.a, 'POST', '/api/data-sources', { name: 'Café menu', type: 'table', config: table });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.slug, 'cafe_menu');
  const r2 = await api(U.a, 'POST', '/api/data-sources', { name: 'x', slug: 'Crème Brûlée', type: 'table', config: table });
  assert.equal(r2.json.slug, 'creme_brulee', 'a typed slug too');
});

test('a slug change lists the widgets that use it, and rewrites them only when asked', async () => {
  const r = await api(U.a, 'POST', '/api/data-sources', { name: 'Menu', slug: 'menu', type: 'table', config: table });
  assert.equal(r.status, 201, r.text);
  const dsId = r.json.id;
  const other = await api(U.a, 'POST', '/api/data-sources', { name: 'Menu B', slug: 'menu_b', type: 'table', config: table });
  assert.equal(other.status, 201, other.text);

  const slide = widget(U.a, 'slide', 'Prices', { fields: { price: 'Latte {{ds:menu.latte_price}}' } },
    { name: 'Prices', config: { fields: { price: 'Draft {{ds:menu.latte_price}}' } } });
  const board = widget(U.a, 'menu-board', 'Board', { source: { slug: 'menu' }, sections: [] });
  const unrelated = widget(U.a, 'slide', 'Other', { fields: { price: '{{ds:menu_b.latte_price}}' } });
  const otherOrg = widget(U.b, 'slide', 'B slide', { fields: { price: '{{ds:menu.latte_price}}' } });

  const refs = await api(U.a, 'GET', `/api/data-sources/${dsId}/references`);
  assert.equal(refs.status, 200, refs.text);
  assert.deepEqual(refs.json.widgets.map((w) => w.id).sort(), [slide, board].sort());
  assert.equal((await api(U.b, 'GET', `/api/data-sources/${dsId}/references`)).status, 404, 'another org cannot ask');

  // Without rewrite_tags (an API client that never asked): the rename alone, as before.
  let put = await api(U.a, 'PUT', `/api/data-sources/${dsId}`, { slug: 'menu2' });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.rewritten, 0);
  assert.match(cfgOf(slide).fields.price, /\{\{ds:menu\.latte_price\}\}/);
  assert.ok(sqlite.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(slide).updated_at > 1000, 'its rev moved: it now renders empty');
  put = await api(U.a, 'PUT', `/api/data-sources/${dsId}`, { slug: 'menu' });
  assert.equal(put.status, 200, put.text);

  put = await api(U.a, 'PUT', `/api/data-sources/${dsId}`, { slug: 'Carte', rewrite_tags: true });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.slug, 'carte');
  assert.equal(put.json.rewritten, 2);
  assert.equal(cfgOf(slide).fields.price, 'Latte {{ds:carte.latte_price}}');
  assert.equal(JSON.parse(sqlite.prepare('SELECT draft_config FROM widgets WHERE id = ?').get(slide).draft_config).config.fields.price, 'Draft {{ds:carte.latte_price}}', 'the pending draft too');
  assert.deepEqual(cfgOf(board).source, { slug: 'carte' });
  assert.equal(cfgOf(unrelated).fields.price, '{{ds:menu_b.latte_price}}');
  assert.equal(cfgOf(otherOrg).fields.price, '{{ds:menu.latte_price}}', 'another workspace is never touched');
  assert.deepEqual((await api(U.a, 'GET', `/api/data-sources/${dsId}/references`)).json.widgets.map((w) => w.id).sort(), [slide, board].sort());
});
