'use strict';

/*
 * frontend/js/api.js — what a failed request throws (spec §7.12, critique U2).
 *
 * ⚠️ The message must stay EXACTLY the server's `error` text: hundreds of callers do
 * `catch (e) { showToast(e.message) }`. What is new rides beside it — status, code, body — so a view
 * that needs the corporate details (which slot, which mandate) no longer loses them. A head office
 * refusal is shown in the viewer's language when a translation exists and every placeholder in it
 * can be filled; otherwise the server's own sentence is kept, never a raw key.
 *
 * Loaded the way mesh-remote-routing.test.js loads it: the real module, stubbed fetch/localStorage.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const API = pathToFileURL(path.join(__dirname, '..', '..', 'frontend', 'js', 'api.js')).href;

async function load(response) {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  globalThis.window = { location: { hash: '', reload() {} } };
  globalThis.fetch = async () => ({
    ok: response.status < 400, status: response.status, statusText: 'x',
    json: async () => response.body,
  });
  return import(`${API}?t=${Math.random()}`);
}

test('the message is unchanged; status, code and body ride along', async () => {
  const m = await load({ status: 409, body: { error: 'Server sentence.', code: 'not_approved', extra: 1 } });
  await assert.rejects(m.api.post('/playlists/x/publish', {}), (e) => {
    assert.equal(e.message, 'Server sentence.');
    assert.equal(e.status, 409);
    assert.equal(e.code, 'not_approved');
    assert.deepEqual(e.body, { error: 'Server sentence.', code: 'not_approved', extra: 1 });
    return true;
  });
});

test('no body at all still gives "Request failed", as before', async () => {
  const m = await load({ status: 500, body: {} });
  await assert.rejects(m.api.get('/x'), (e) => e.message === 'Request failed' && e.status === 500);
});

test('a corporate code is translated when a translator is set and every placeholder is filled', async () => {
  const m = await load({ status: 403, body: { error: 'EN server text', code: 'CORPORATE_OVERRIDE', corporate: { playlist_name: 'Brand' } } });
  const dict = { 'corp.err.CORPORATE_OVERRIDE': 'Nur Zentrale: "{name}"' };
  m.setErrorTranslator((k, v) => (dict[k] ? dict[k].replace(/\{(\w+)\}/g, (x, n) => (v && n in v ? v[n] : x)) : k));
  await assert.rejects(m.api.get('/x'), (e) => e.message === 'Nur Zentrale: "Brand"' && e.code === 'CORPORATE_OVERRIDE');
});

test('…and falls back to the server sentence when a placeholder cannot be filled or no key exists — never the raw key', async () => {
  const m = await load({ status: 403, body: { error: 'EN server text', code: 'CORPORATE_OVERRIDE' } });
  m.setErrorTranslator((k, v) => (k === 'corp.err.CORPORATE_OVERRIDE' ? `X "${(v && v.name) || '{name}'}"` : k));
  await assert.rejects(m.api.get('/x'), (e) => e.message === 'EN server text');
  const m2 = await load({ status: 403, body: { error: 'EN server text', code: 'CORPORATE_SOMETHING_NEW' } });
  m2.setErrorTranslator((k) => k);
  await assert.rejects(m2.api.get('/x'), (e) => e.message === 'EN server text');
});

test('every corp.err key in en.js names a code the server can send', () => {
  const fs = require('node:fs');
  const en = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const { MESSAGES } = require('../lib/corporate/guard');
  for (const [, code] of en.matchAll(/'corp\.err\.([A-Z_]+)'/g)) assert.ok(MESSAGES[code], `en.js has corp.err.${code} but the server has no such code`);
});
