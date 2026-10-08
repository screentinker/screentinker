'use strict';

/*
 * The menu board widget (lib/menu-board.js, routes/widgets.js).
 *
 *   - prices format by the menu's currency rules; anything that is not a number is shown as written
 *   - a sheet's rows become sections by their headers (section, item, price_1/price_2, sold_out…)
 *   - every operator and sheet string is escaped; only safe image URLs are kept
 *   - sold-out items are marked or hidden; time windows ride to the page for the screen's own clock
 *   - PATCH /menu-items/:id goes live at once EVEN WITH APPROVAL ON, without publishing the draft,
 *     and the draft carries the same flag so publishing it later cannot undo it
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-menu-' + crypto.randomBytes(4).toString('hex'));
process.env.JWT_SECRET = 'test-secret-menu';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const menu = require('../lib/menu-board');

test('prices: currency before or after, fixed decimals, words kept as written', () => {
  const m = menu.normalise({ currency: '$', decimals: 2 });
  assert.equal(menu.formatPrice('4.5', m), '$4.50');
  assert.equal(menu.formatPrice('12', menu.normalise({ currency: '€', currency_after: true, decimals: 2 })), '12.00 €');
  assert.equal(menu.formatPrice('3,5', menu.normalise({ currency: '£', decimals: 1 })), '£3.5', 'a decimal comma is a number too');
  assert.equal(menu.formatPrice('Market price', m), 'Market price');
});

test('a sheet becomes sections by its headers, with several prices and sold-out rows', () => {
  const data = {
    row_count: 4,
    row1_section: 'Burgers', row1_item: 'Classic', row1_price_1: '9.5', row1_price_2: '12.5', row1_tags: 'popular', row1_sold_out: '',
    row2_section: 'Burgers', row2_item: 'Garden', row2_price_1: '10', row2_tags: 'vegan, gf', row2_sold_out: 'yes',
    row3_section: 'Sides', row3_item: 'Fries', row3_price_1: '3.5',
    row4_section: 'Sides', row4_item: '', row4_price_1: '1',          // no name: skipped
  };
  const s = menu.sectionsFromData(data);
  assert.deepEqual(s.map((x) => x.name), ['Burgers', 'Sides']);
  assert.deepEqual(s[0].items.map((i) => i.name), ['Classic', 'Garden']);
  assert.deepEqual(s[0].items[0].prices, ['9.5', '12.5']);
  assert.equal(s[0].items[1].sold_out, true);
  assert.deepEqual(s[0].items[1].tags.map((t) => t.code), ['vg', 'gf'], 'vegan and gf are known tags');
  assert.equal(s[1].items.length, 1);
});

test('rendering escapes every string and drops unsafe image URLs', () => {
  const html = menu.renderMenuBoard({
    title: '<img src=x onerror=alert(1)>', footer: '"quoted" & <b>',
    logo_url: 'javascript:alert(1)', background_url: 'https://cdn.example.org/bg.jpg',
    sections: [{ name: 'Mains</h2><script>alert(2)</script>', items: [
      { id: 'a', name: 'Fish <i>', description: 'x', prices: ['10'], image_url: '/uploads/content/fish.jpg' },
      { id: 'b', name: 'Steak', prices: ['20'], image_url: 'data:text/html,<script>' },
    ] }],
  });
  assert.ok(!html.includes('<img src=x onerror'));
  assert.ok(!html.includes('<script>alert(2)'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('javascript:alert'), 'an unsafe logo URL is dropped');
  assert.ok(html.includes('https://cdn.example.org/bg.jpg'));
  assert.ok(html.includes('/uploads/content/fish.jpg'));
  assert.ok(!html.includes('data:text/html'), 'a data: URL is not an image we point at');
});

test('sold out is marked or hidden, and time windows reach the page', () => {
  const cfg = { sections: [{ name: 'Breakfast', show_from: '07:00', show_until: '11:30', items: [
    { id: 'a', name: 'Eggs', prices: ['5'] }, { id: 'b', name: 'Pancakes', prices: ['6'], sold_out: true }] }] };
  const marked = menu.renderMenuBoard(cfg);
  assert.ok(marked.includes('Pancakes') && marked.includes('Sold out'));
  assert.ok(marked.includes('data-from="07:00" data-until="11:30"'));
  const hidden = menu.renderMenuBoard({ ...cfg, sold_out: 'hide' });
  assert.ok(!hidden.includes('Pancakes'));
  const bad = menu.normalise({ sections: [{ name: 'x', show_from: '25:00', items: [] }] });
  assert.equal(bad.sections[0].show_from, '', 'an invalid time is no window, not a hidden section');
});

/* ── the sold-out API ─────────────────────────────────────────────────────────────── */

const O = 'o-menu', WS = 'ws-menu', U = 'u-menu', V = 'u-menu-view', W = 'w-menu', WD = 'w-menu-ds';
let server, base;
const tokenOf = (u) => generateToken(db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(u), WS);
async function patch(id, item, body, who = U) {
  const r = await fetch(`${base}/api/widgets/${id}/menu-items/${item}`, { method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenOf(who)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const liveConfig = (id) => JSON.parse(db.prepare('SELECT config FROM widgets WHERE id = ?').get(id).config);

before(async () => {
  db.prepare("INSERT INTO users (id, email, password_hash, role) VALUES (?, 'menu@t.local', 'x', 'user'), (?, 'menuv@t.local', 'x', 'user')").run(U, V);
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run(O, 'Org', U);
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run(WS, O, 'WS');
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_editor'), (?, ?, 'workspace_viewer')").run(WS, U, WS, V);
  const cfg = { title: 'Lunch', sections: [{ id: 's1', name: 'Mains', items: [{ id: 'fish', name: 'Fish', prices: ['12'] }, { id: 'steak', name: 'Steak', prices: ['20'] }] }] };
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config, updated_at) VALUES (?, ?, ?, 'menu-board', 'Lunch', ?, 1000)").run(W, U, WS, JSON.stringify(cfg));
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES (?, ?, ?, 'menu-board', 'Sheet', ?)").run(WD, U, WS, JSON.stringify({ source: { slug: 'menu' } }));
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { try { server.close(); } catch { /* */ } });

test('sold out goes live at once and bumps the revision so players reload', async () => {
  const before = db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(W).updated_at;
  const r = await patch(W, 'fish', { sold_out: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(liveConfig(W).sections[0].items[0].sold_out, true);
  assert.ok(db.prepare('SELECT updated_at FROM widgets WHERE id = ?').get(W).updated_at > before);
  const html = await (await fetch(`${base}/api/widgets/${W}/render`, { headers: { Authorization: `Bearer ${tokenOf(U)}` } })).text();
  assert.ok(html.includes('Sold out'));
});

test('⚠️ with approval on, a sold-out toggle still goes live, does not publish the draft, and lands in the draft too', async () => {
  db.prepare('UPDATE workspaces SET require_approval = 1 WHERE id = ?').run(WS);
  const draft = { name: 'Lunch', config: { ...liveConfig(W), title: 'UNREVIEWED TITLE' } };
  db.prepare('UPDATE widgets SET draft_config = ? WHERE id = ?').run(JSON.stringify(draft), W);
  const r = await patch(W, 'steak', { sold_out: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const live = liveConfig(W);
  assert.equal(live.title, 'Lunch', 'the unreviewed draft was NOT published');
  assert.equal(live.sections[0].items[1].sold_out, true, 'but the sold-out flag is live');
  const d = JSON.parse(db.prepare('SELECT draft_config FROM widgets WHERE id = ?').get(W).draft_config);
  assert.equal(d.config.sections[0].items[1].sold_out, true, 'and in the draft, so publishing it cannot undo it');
  assert.equal(d.config.title, 'UNREVIEWED TITLE');
  db.prepare('UPDATE workspaces SET require_approval = 0 WHERE id = ?').run(WS);
});

test('refusals: viewer, unknown item, bad body, a data-source menu, a widget that is not a menu', async () => {
  assert.equal((await patch(W, 'fish', { sold_out: false }, V)).status, 403);
  assert.equal((await patch(W, 'nope', { sold_out: true })).status, 404);
  assert.equal((await patch(W, 'fish', { sold_out: 'yes' })).status, 400);
  const ds = await patch(WD, 'r1', { sold_out: true });
  assert.equal(ds.status, 409); assert.equal(ds.body.code, 'MENU_FROM_DATA_SOURCE');
  db.prepare("INSERT INTO widgets (id, user_id, workspace_id, widget_type, name, config) VALUES ('w-clock-m', ?, ?, 'clock', 'c', '{}')").run(U, WS);
  assert.equal((await patch('w-clock-m', 'x', { sold_out: true })).status, 400);
});

test('a menu bound to a data source renders that source\'s rows', async () => {
  db.prepare("INSERT INTO data_sources (id, workspace_id, slug, name, type, config, cached_data) VALUES ('ds-m', ?, 'menu', 'Menu', 'csv', '{}', ?)")
    .run(WS, JSON.stringify({ row_count: 1, row1_section: 'Specials', row1_item: 'Soup of the day', row1_price: '6' }));
  const html = await (await fetch(`${base}/api/widgets/${WD}/render`, { headers: { Authorization: `Bearer ${tokenOf(U)}` } })).text();
  assert.ok(html.includes('Specials') && html.includes('Soup of the day') && html.includes('$6.00'));
});
