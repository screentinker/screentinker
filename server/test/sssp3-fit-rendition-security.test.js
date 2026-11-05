'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), 'st-sssp3-fit-' + crypto.randomBytes(4).toString('hex'));
process.env.NODE_ENV = 'test';

const { db } = require('../db/database');
const config = require('../config');
const fit = require('../lib/sssp3-fit-rendition');

fs.mkdirSync(config.contentDir, { recursive: true });
db.prepare("INSERT INTO users (id,email,name,password_hash,auth_provider,role) VALUES ('u-fit','fit@test.invalid','fit','x','local','user')").run();
for (const id of ['a', 'b']) {
  db.prepare('INSERT INTO organizations (id,name,owner_user_id) VALUES (?,?,?)').run('org-' + id, 'Org ' + id, 'u-fit');
  db.prepare('INSERT INTO workspaces (id,organization_id,name) VALUES (?,?,?)').run('ws-' + id, 'org-' + id, 'WS ' + id);
}

function content(id, workspace = 'ws-a', ext = 'mp4') {
  const filename = id + '.' + ext;
  fs.writeFileSync(path.join(config.contentDir, filename), 'source-' + id);
  db.prepare('INSERT INTO content (id,workspace_id,filename,filepath,mime_type,file_size) VALUES (?,?,?,?,?,?)')
    .run(id, workspace, filename, filename, ext === 'mp4' ? 'video/mp4' : 'image/jpeg', 8);
  return { content_id: id, filepath: filename, mime_type: ext === 'mp4' ? 'video/mp4' : 'image/jpeg', zone_id: 'zone-a', fit_mode: 'contain' };
}

const device = { id: 'sssp3-fit-device', workspace_id: 'ws-a', capabilities: JSON.stringify(['playback.sssp3_fit_renditions']) };
const layout = { zones: [
  { id: 'zone-a', width_percent: 50, height_percent: 50 },
  { id: 'zone-b', width_percent: 50, height_percent: 50 },
] };

test.beforeEach(() => {
  db.prepare('DELETE FROM sssp3_fit_renditions').run();
  fit._resetForTest();
});

test('only a capable device payload can approve a bounded rendition', () => {
  const item = content('fit-cap-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, { ...device, capabilities: '[]' });
  assert.equal(item.sssp3_rendition_url, undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions').get().n, 0);

  fit.stampItems([item], layout, device);
  assert.equal(item.sssp3_rendition_url, undefined, 'a queued output is never advertised as downloadable');
  assert.equal(item.sssp3_rendition_state, 'queued');
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  assert.equal(row.workspace_id, 'ws-a');
  assert.equal(row.width, 960);
  assert.equal(row.height, 540);
  assert.equal(row.fit, 'contain');
  assert.equal(row.status, 'queued');
});

test('overlapping ticks claim a rendition once and cannot delete the winning output', async () => {
  const item = content('fit-race-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  let started = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fit._resetForTest({ encodeFn: async ({ tmp }) => { started++; await gate; fs.writeFileSync(tmp, 'single-owner-output'); } });
  const first = fit.tick();
  const second = fit.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, 1, 'only one overlapping tick owns the queued row');
  release();
  await Promise.all([first, second]);
  await fit._drain();
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  assert.equal(row.status, 'ready');
  assert.ok(fit.resolveReady(item.content_id, row.id), 'the owner output remains present after a losing tick');
});

test('a payload cannot approve another workspace content row', () => {
  const item = content('fit-cross-' + crypto.randomBytes(3).toString('hex'), 'ws-b');
  fit.stampItems([item], layout, device);
  assert.equal(item.sssp3_rendition_url, undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id).n, 0);
});

test('the per-content variant ceiling remains durable across requests', () => {
  const item = content('fit-cap-limit-' + crypto.randomBytes(3).toString('hex'), 'ws-a', 'jpg');
  for (let i = 0; i < fit.MAX_VARIANTS_PER_CONTENT + 4; i++) {
    const candidate = { ...item, zone_id: 'z' + i };
    fit.stampItems([candidate], { zones: [{ id: 'z' + i, width_percent: 10 + i, height_percent: 20 }] }, device);
  }
  const count = db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id).n;
  assert.equal(count, fit.MAX_VARIANTS_PER_CONTENT);
});

test('the durable pending queue has a global ceiling and a per-workspace share', () => {
  for (let i = 0; i < fit.MAX_PENDING_RENDITIONS + 5; i++) {
    const item = content('fit-queue-' + i + '-' + crypto.randomBytes(2).toString('hex'), 'ws-a', 'jpg');
    fit.stampItems([item], layout, device);
  }
  const pending = db.prepare("SELECT count(*) AS n FROM sssp3_fit_renditions WHERE status IN ('queued','running')").get().n;
  assert.equal(pending, fit.MAX_PENDING_RENDITIONS_PER_WORKSPACE);
});

test('one workspace cannot consume another workspace pending capacity', () => {
  for (let i = 0; i < fit.MAX_PENDING_RENDITIONS_PER_WORKSPACE; i++) {
    fit.stampItems([content('fit-fair-a-' + i + '-' + crypto.randomBytes(2).toString('hex'), 'ws-a', 'jpg')], layout, device);
  }
  const other = content('fit-fair-b-' + crypto.randomBytes(2).toString('hex'), 'ws-b', 'jpg');
  fit.stampItems([other], layout, { ...device, workspace_id: 'ws-b' });
  assert.equal(db.prepare("SELECT status FROM sssp3_fit_renditions WHERE content_id = ?").get(other.content_id).status, 'queued');
});

test('replacing source bytes invalidates the old approved rendition', async () => {
  const item = content('fit-replace-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  fit._resetForTest({ encodeFn: async ({ tmp }) => { fs.writeFileSync(tmp, 'old-rendition'); } });
  await fit.tick();
  await fit._drain();
  const old = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  assert.ok(fit.resolveReady(item.content_id, old.id));

  fs.writeFileSync(path.join(config.contentDir, item.filepath), 'replacement-source-bytes');
  db.prepare("UPDATE content SET updated_at = updated_at + 1,file_size = ? WHERE id = ?").run(24, item.content_id);
  item.content_rev = 2;
  fit.stampItems([item], layout, device);
  assert.equal(fit.resolveReady(item.content_id, old.id), null);
  const rows = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').all(item.content_id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, old.id);
  assert.equal(rows[0].status, 'queued');
});

test('public lookup never creates or starts a rendition job', async () => {
  const before = db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions').get().n;
  assert.equal(fit.resolveReady('missing-content', '0'.repeat(32)), null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions').get().n, before);
  assert.equal(fit.stats().running, 0);
});

test('startup sweep removes interrupted work without touching unrelated directories', () => {
  const stale = fs.mkdtempSync(path.join(config.contentDir, '.sssp3-fit-'));
  fs.writeFileSync(path.join(stale, 'partial.mp4'), 'partial');
  const unrelated = fs.mkdtempSync(path.join(config.contentDir, '.other-work-'));
  fs.writeFileSync(path.join(unrelated, 'keep'), 'keep');

  assert.equal(fit.sweepOrphans(), 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(unrelated), true);
  fs.rmSync(unrelated, { recursive: true, force: true });
});

test('orphan sweep never removes a live encoder work directory', async () => {
  const item = content('fit-live-work-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  let release;
  let workDir;
  fit._resetForTest({ encodeFn: ({ tmp }) => new Promise((resolve) => {
    workDir = path.dirname(tmp);
    release = () => { fs.writeFileSync(tmp, 'complete'); resolve(); };
  }) });

  await fit.tick();
  assert.ok(workDir && fs.existsSync(workDir));
  assert.equal(fit.sweepOrphans(), 0);
  assert.equal(fs.existsSync(workDir), true);
  release();
  await fit._drain();
  assert.equal(fs.existsSync(workDir), false);
});

test('the bounded worker exposes only a complete atomic output', async () => {
  const item = content('fit-worker-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  assert.equal(fit.resolveReady(item.content_id, row.id), null);

  fit._resetForTest({ encodeFn: async ({ tmp }) => { fs.writeFileSync(tmp, 'complete-rendition'); } });
  await fit.tick();
  await fit._drain();
  const ready = fit.resolveReady(item.content_id, row.id);
  assert.ok(ready && fs.statSync(ready).size > 0);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'ready');
});

test('the global byte quota evicts the least-recently-used completed output', async () => {
  const first = content('fit-quota-a-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([first], layout, device);
  fit._resetForTest({ cacheBytes: 24, encodeFn: async ({ tmp }) => { fs.writeFileSync(tmp, '1234567890123456'); } });
  await fit.tick();
  await fit._drain();
  const old = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(first.content_id);
  assert.equal(old.status, 'ready');

  const second = content('fit-quota-b-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([second], layout, device);
  await fit.tick();
  await fit._drain();
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(old.id).status, 'evicted');
  assert.equal(fs.existsSync(path.join(config.contentDir, old.filepath)), false);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE content_id = ?').get(second.content_id).status, 'ready');
});

test('an evicted rendition is not automatically requeued by later payloads', () => {
  const item = content('fit-evicted-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  db.prepare("UPDATE sssp3_fit_renditions SET status = 'evicted', filepath = NULL WHERE id = ?").run(row.id);
  fit.stampItems([{ ...item }], layout, device);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'evicted');
  assert.equal(fit.stats().queued, 0);
});

test('failed work is bounded and public requests do not retry it', async () => {
  const item = content('fit-fail-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  let attempts = 0;
  fit._resetForTest({ encodeFn: async () => { attempts++; throw new Error('bad media'); } });
  await fit.tick();
  await fit._drain();
  assert.equal(attempts, 1);
  assert.equal(fit.resolveReady(item.content_id, row.id), null);
  assert.equal(fit.resolveReady(item.content_id, row.id), null);
  assert.equal(attempts, 1);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'failed');
});

test('a transient failed rendition retries only after bounded exponential backoff', () => {
  const item = content('fit-retry-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  db.prepare("UPDATE sssp3_fit_renditions SET status = 'failed',attempts = 1,updated_at = strftime('%s','now'),error = 'temporary storage outage' WHERE id = ?").run(row.id);
  fit.stampItems([{ ...item }], layout, device);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'failed');
  db.prepare("UPDATE sssp3_fit_renditions SET updated_at = strftime('%s','now') - 61 WHERE id = ?").run(row.id);
  fit.stampItems([{ ...item }], layout, device);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'queued');
  db.prepare("UPDATE sssp3_fit_renditions SET status = 'failed',attempts = ? ,updated_at = 0 WHERE id = ?").run(fit.MAX_RENDITION_ATTEMPTS, row.id);
  fit.stampItems([{ ...item }], layout, device);
  assert.equal(db.prepare('SELECT status FROM sssp3_fit_renditions WHERE id = ?').get(row.id).status, 'failed');
});

test('content cleanup removes rendition rows and files', async () => {
  const item = content('fit-remove-' + crypto.randomBytes(3).toString('hex'));
  fit.stampItems([item], layout, device);
  fit._resetForTest({ encodeFn: async ({ tmp }) => { fs.writeFileSync(tmp, 'complete-rendition'); } });
  await fit.tick();
  await fit._drain();
  const row = db.prepare('SELECT * FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id);
  assert.ok(fs.existsSync(path.join(config.contentDir, row.filepath)));
  fit.removeFor(item.content_id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sssp3_fit_renditions WHERE content_id = ?').get(item.content_id).n, 0);
  assert.equal(fs.existsSync(path.join(config.contentDir, row.filepath)), false);
});

test('rendition rows are classified as rebuildable cache state, not tenant export data', () => {
  const { EXCLUDED } = require('../lib/trust/export-tables');
  assert.match(EXCLUDED.sssp3_fit_renditions, /derived|cache|rebuilt/i);
});
