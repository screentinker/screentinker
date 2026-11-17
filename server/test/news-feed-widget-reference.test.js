'use strict';

/*
 * GHSA-rvxj 13.1: a news widget's public render page (/api/widgets/:id/render, open to anyone with
 * the widget id: every player that shows it) carried the full feed address, so a key in its query
 * string (https://example.com/rss?apikey=...) was readable by whoever held the id. The page now
 * names the widget (/api/news-feeds/items?w=<id>&s=<sig>) and the items handler reads the feed from
 * the widget's live config. And a feed address with a user name or password is refused when the
 * widget is saved, with a message, instead of silently showing nothing.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), 'st-news-ref-' + process.pid + '-' + Date.now());
process.env.JWT_SECRET = 'test-secret-news-ref';
process.env.NODE_ENV = 'test';
process.env.OUTBOUND_ALLOW_HOSTS = '127.0.0.1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { db } = require('../db/database');
const { requireAuth, generateToken } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const news = require('../lib/news-feed');

const O = 'org-newsref', WS = 'ws-newsref', U = 'u-newsref';
db.prepare("INSERT OR IGNORE INTO users (id,email,password_hash,role,name) VALUES (?,?,'x','user','ed')").run(U, 'ed@newsref.local');
db.prepare('INSERT OR IGNORE INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run(O, 'Org', U);
db.prepare('INSERT OR IGNORE INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run(WS, O, 'News WS');
db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role) VALUES (?,?,'workspace_editor')").run(WS, U);

let feedSrv, appSrv, feedOrigin, base;
before(async () => {
  feedSrv = http.createServer((req, res) => {
    if (req.url.startsWith('/rss.xml')) {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item><title>Only headline</title><link>https://example.test/a</link></item></channel></rss>');
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => feedSrv.listen(0, '127.0.0.1', r));
  feedOrigin = `http://127.0.0.1:${feedSrv.address().port}`;
  const app = express();
  app.use(express.json());
  const r = require('../routes/news-feeds');
  app.get('/api/news-feeds/items', r.itemsHandler);
  app.use('/public/widgets', require('../routes/widgets'));   // /render is public in server.js
  app.use('/api/widgets', requireAuth, resolveTenancy, require('../routes/widgets'));
  appSrv = app.listen(0, '127.0.0.1');
  await new Promise((res) => appSrv.once('listening', res));
  base = `http://127.0.0.1:${appSrv.address().port}`;
});
after(() => {
  appSrv && appSrv.close(); feedSrv && feedSrv.close();
  try { fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); } catch { /* */ }
});

const auth = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${generateToken(db.prepare('SELECT id,email,role FROM users WHERE id = ?').get(U), WS)}` });
const createRss = (config) => fetch(`${base}/api/widgets`, { method: 'POST', headers: auth(), body: JSON.stringify({ widget_type: 'rss', name: 'News', config }) });

test('the public render page names the widget, not the feed address or its key', async () => {
  const r = await createRss({ feed_url: `${feedOrigin}/rss.xml?apikey=SECRET-KEY-123` });
  assert.equal(r.status, 201);
  const id = (await r.json()).id;
  const html = await (await fetch(`${base}/public/widgets/${id}/render`)).text();
  assert.ok(!html.includes('SECRET-KEY-123'), 'the feed key is not on the public page');
  assert.ok(!html.includes(encodeURIComponent(feedOrigin)) && !html.includes(feedOrigin), 'nor the feed address');
  // In the page's JSON block, where `&` is written \u0026.
  const m = html.match(/\/api\/news-feeds\/items\?w=([^"\\]+)\\u0026s=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'the page reads its items by widget id');
  assert.equal(decodeURIComponent(m[1]), id);

  // The items handler reads the feed from the widget, server-side.
  news._reset();
  const items = await fetch(`${base}/api/news-feeds/items?w=${m[1]}&s=${m[2]}&n=5`);
  assert.equal(items.status, 200);
  assert.equal((await items.json()).items[0].title, 'Only headline');
});

test('an unsigned or forged widget reference reads nothing', async () => {
  const r = await createRss({ feed_url: `${feedOrigin}/rss.xml` });
  const id = (await r.json()).id;
  assert.equal((await fetch(`${base}/api/news-feeds/items?w=${id}&s=nope`)).status, 403);
  // A signature is per widget: a real one for another id, or for a widget that is not a news widget, is refused.
  const text = await (await fetch(`${base}/api/widgets`, { method: 'POST', headers: auth(), body: JSON.stringify({ widget_type: 'text', name: 'T', config: { html: 'x' } }) })).json();
  assert.equal((await fetch(`${base}/api/news-feeds/items?w=${text.id}&s=${news.widgetItemsPath(id).split('&s=')[1]}`)).status, 403);
  assert.equal((await fetch(`${base}/api/news-feeds/items${news.widgetItemsPath(text.id).slice('/api/news-feeds/items'.length)}`)).status, 403);
});

test('a feed address with a user name or password is refused at save, with a reason', async () => {
  const r = await createRss({ feed_url: 'https://reader:hunter2@feeds.example.test/private.xml' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /user name or password/);
  const ok = await (await createRss({ feed_url: `${feedOrigin}/rss.xml` })).json();
  const put = await fetch(`${base}/api/widgets/${ok.id}`, { method: 'PUT', headers: auth(), body: JSON.stringify({ config: { feed_url: 'feed://reader@feeds.example.test/x' } }) });
  assert.equal(put.status, 400);
  assert.throws(() => news.normaliseInput('https://a:b@feeds.example.test/rss'), /user name or password/);
});
