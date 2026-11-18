'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const dataDir = path.join(os.tmpdir(), `st-image-as-video-${crypto.randomBytes(4).toString('hex')}`);
process.env.DATA_DIR = dataDir;
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('../db/database');
const config = require('../config');
const imageAsVideoVariants = require('../lib/image-as-video-variants');
const videoVariants = require('../lib/video-variants');
const appSettings = require('../lib/app-settings');

const CONTENT_ID = 'image-as-video-test';
const SOURCE_FILE = 'large-image.jpg';

before(() => {
  fs.mkdirSync(config.contentDir, { recursive: true });
  fs.writeFileSync(path.join(config.contentDir, SOURCE_FILE), 'image source');
  db.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('iav-user', 'image-as-video@example.test');
  db.prepare('INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)').run('iav-org', 'Image as video test', 'iav-user');
  db.prepare('INSERT INTO workspaces (id, organization_id, name) VALUES (?, ?, ?)').run('iav-ws', 'iav-org', 'Image as video test');
  db.prepare(`INSERT INTO content
      (id, workspace_id, filename, filepath, mime_type, file_size, width, height, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000, 1000)`)
    .run(CONTENT_ID, 'iav-ws', SOURCE_FILE, SOURCE_FILE, 'image/jpeg', 11, 3840, 2160);
});

after(() => {
  imageAsVideoVariants._resetForTest();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* test cleanup */ }
});

beforeEach(() => {
  db.prepare('DELETE FROM video_variant_usage').run();
  db.prepare("DELETE FROM app_settings WHERE key = 'video_variants_org_monthly_minutes'").run();
  appSettings.__reload();
});

function content() {
  return db.prepare('SELECT * FROM content WHERE id = ?').get(CONTENT_ID);
}

function device(overrides = {}) {
  return {
    client_type: 'apk',
    native_video: 1,
    orientation: 'landscape',
    screen_width: 3840,
    screen_height: 2160,
    capabilities: JSON.stringify(['playback.video', imageAsVideoVariants.CAPABILITY]),
    ...overrides,
  };
}

test('only eligible, opted-in Android full-screen images are queued', () => {
  assert.equal(imageAsVideoVariants.isEligibleImage(content()), true);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), width: 1920, height: 1080 }), false);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), width: 2560, height: 1440 }), true);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), width: 3000, height: 2000 }), true);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), remote_url: 'https://example.test/image.jpg' }), false);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), mime_type: 'video/mp4' }), false);
  assert.equal(imageAsVideoVariants.isEligibleImage({ ...content(), width: 9000 }), false);

  const assignment = () => ({ content_id: CONTENT_ID, mime_type: 'image/jpeg' });
  for (const ineligible of [
    device({ native_video: 0 }),
    device({ capabilities: JSON.stringify(['playback.video']) }),
    device({ wall_id: 'wall-1' }),
    device({ orientation: 'portrait' }),
    device({ client_type: 'web' }),
  ]) {
    imageAsVideoVariants.stampItems([assignment()], ineligible);
  }
  imageAsVideoVariants.stampItems([assignment()], device(), { lazy: false });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_image_as_video_variants').get().n, 0);

  const item = assignment();
  imageAsVideoVariants.stampItems([item], device());
  assert.equal(item.image_as_video_state, 'preparing');
  assert.equal(db.prepare('SELECT status FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID).status, 'queued');

  const transitioned = { ...assignment(), transition: 'fade' };
  imageAsVideoVariants.stampItems([transitioned], device());
  assert.equal(transitioned.image_as_video_state, undefined);
  const zoned = { ...assignment(), zone_id: 'zone-1' };
  imageAsVideoVariants.stampItems([zoned], device());
  assert.equal(zoned.image_as_video_state, undefined);
});

test('skips variants when the known UI render surface can display the source at native size', () => {
  imageAsVideoVariants.removeFor(CONTENT_ID);
  const assignment = () => ({ content_id: CONTENT_ID, mime_type: 'image/jpeg' });

  const fullResolution = assignment();
  imageAsVideoVariants.stampItems(
    [fullResolution],
    device({ render_width: 3840, render_height: 2160 })
  );
  assert.equal(fullResolution.image_as_video_state, undefined);
  assert.equal(
    db.prepare('SELECT 1 FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID),
    undefined
  );

  const lowerResolution = assignment();
  imageAsVideoVariants.stampItems(
    [lowerResolution],
    device({ render_width: 2560, render_height: 1440 })
  );
  assert.equal(lowerResolution.image_as_video_state, 'preparing');
  assert.equal(
    db.prepare('SELECT status FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID).status,
    'queued'
  );
  imageAsVideoVariants.removeFor(CONTENT_ID);
});

test('encoding revisions invalidate older cached variants without changing the source image', () => {
  const source = content();
  const previousRevision = Number(source.updated_at);
  imageAsVideoVariants.ensure(source);
  db.prepare('UPDATE content_image_as_video_variants SET status = ?, source_revision = ? WHERE content_id = ?')
    .run('ready', previousRevision, CONTENT_ID);

  assert.equal(imageAsVideoVariants.ensure(source), 'queued');
  assert.notEqual(
    db.prepare('SELECT source_revision FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID).source_revision,
    previousRevision
  );
});

test('worker creates a revision-bound video and exposes it only when ready', async () => {
  imageAsVideoVariants._resetForTest({
    encode: async ({ src, out }) => {
      assert.equal(src, path.join(config.contentDir, SOURCE_FILE));
      fs.writeFileSync(out, 'encoded video');
    },
  });
  imageAsVideoVariants.ensure(content());
  await imageAsVideoVariants._tick();
  await imageAsVideoVariants._drain();

  const row = db.prepare('SELECT * FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID);
  assert.equal(row.status, 'ready');
  assert.equal(db.prepare('SELECT seconds FROM video_variant_usage WHERE organization_id = ?').get('iav-org').seconds, 1);
  assert.match(row.filepath, imageAsVideoVariants.FILE_RE);
  assert.equal(fs.readFileSync(path.join(config.contentDir, row.filepath), 'utf8'), 'encoded video');
  assert.equal(imageAsVideoVariants.servePath(content()), path.join(config.contentDir, row.filepath));
  assert.equal(imageAsVideoVariants.servePath(content(), row.updated_at), path.join(config.contentDir, row.filepath));
  assert.equal(imageAsVideoVariants.servePath(content(), row.updated_at - 1), null);

  const item = { content_id: CONTENT_ID, mime_type: 'image/jpeg' };
  imageAsVideoVariants.stampItems([item], device());
  assert.equal(item.image_as_video_state, 'ready');
  assert.equal(item.image_as_video_revision, row.updated_at);

  db.prepare('UPDATE content SET updated_at = 1001 WHERE id = ?').run(CONTENT_ID);
  assert.equal(imageAsVideoVariants.servePath(content()), null, 'a stale image-as-video variant is never served after the image changes');
  imageAsVideoVariants.removeFor(CONTENT_ID);
  assert.equal(db.prepare('SELECT 1 FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID), undefined);
  assert.equal(fs.existsSync(path.join(config.contentDir, row.filepath)), false);
});

test('image variants share the monthly video-variant allowance and retry next month', async () => {
  const now = new Date();
  videoVariants.saveSettings({ org_monthly_minutes: 1 });
  db.prepare('INSERT INTO video_variant_usage (organization_id, month, seconds) VALUES (?, ?, 60)')
    .run('iav-org', videoVariants.monthKey(now));
  let encoded = 0;
  imageAsVideoVariants._resetForTest({
    encode: async () => { encoded++; },
  });

  imageAsVideoVariants.ensure(content());
  await imageAsVideoVariants._tick();
  const row = db.prepare('SELECT status, error FROM content_image_as_video_variants WHERE content_id = ?').get(CONTENT_ID);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'monthly allowance reached');
  assert.equal(encoded, 0, 'denied work is not encoded');
  assert.equal(imageAsVideoVariants.ensure(content(), { now }), 'failed', 'does not repeatedly queue within the same month');

  const previousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  db.prepare('UPDATE content_image_as_video_variants SET updated_at = ? WHERE content_id = ?')
    .run(Math.floor(previousMonth.getTime() / 1000), CONTENT_ID);
  assert.equal(imageAsVideoVariants.ensure(content(), { now }), 'queued');
});

test('FFmpeg creates a short, high-quality H.264 MP4 that preserves 4K dimensions', () => {
  const args = imageAsVideoVariants.ffmpegArgs('source.jpg', 'output.mp4');
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('yuv420p'));
  const filter = args[args.indexOf('-vf') + 1];
  assert.equal(filter, 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p');
  assert.doesNotMatch(filter, /in_range|out_range/);
  assert.equal(args.includes('-color_range'), false);
  assert.ok(args.includes('10'));
  assert.ok(args.includes('+faststart'));
  const framerate = args.indexOf('-framerate');
  assert.deepEqual(args.slice(framerate, framerate + 2), ['-framerate', '1']);
  const duration = args.indexOf('-t');
  assert.deepEqual(args.slice(duration, duration + 2), ['-t', '1']);
  assert.ok(args.includes('source.jpg'));
  assert.ok(args.includes('output.mp4'));
});
