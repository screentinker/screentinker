'use strict';

/*
 * A video ELEMENT on a slide: a clip placed and sized like a photo, as the background video
 * already is for the whole stage. Muted and looping (the only kind every engine autoplays), hwz="off"
 * (BrightSign), and at most MAX_SLIDE_VIDEOS per slide counting the background (hardware decoders).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const R = require('../lib/slide-render');
const deck = require('../lib/slide-deck');
const { checkSlide } = require('../lib/a11y/slides');
const L = require('../lib/a11y/legibility');

const urls = (id) => `/uploads/content/${id}.mp4`;
const vid = (id, more = {}) => ({ kind: 'video', slot: 'v_' + id, content_id: id, box: { x: 0, y: 0, w: 40, h: 30 }, ...more });
const render = (template, resolve = urls) => R.renderSlideHtml({ template, fields: {} }, { resolveImage: resolve });
const videoTags = (html) => html.match(/<video[^>]*>/g) || [];

test('a video element renders muted, looping, autoplaying, inline, with hwz="off"', () => {
  const tags = videoTags(render({ elements: [vid('a')] }));
  assert.equal(tags.length, 1);
  for (const attr of ['autoplay', 'muted', 'loop', 'playsinline', 'hwz="off"', 'src="/uploads/content/a.mp4"']) {
    assert.ok(tags[0].includes(attr), `${attr} in ${tags[0]}`);
  }
  assert.ok(!/class="bg"/.test(tags[0]), 'an element, not the background layer');
});

test('fit: cover by default, contain on request, anything else is cover', () => {
  assert.ok(!/class="fit"/.test(videoTags(render({ elements: [vid('a')] }))[0]));
  assert.match(videoTags(render({ elements: [vid('a', { fit: 'contain' })] }))[0], /class="fit"/);
  assert.ok(!/class="fit"/.test(videoTags(render({ elements: [vid('a', { fit: 'stretch' })] }))[0]));
  const html = render({ elements: [vid('a')] });
  assert.match(html, /\.e video \{ width:100%; height:100%; object-fit:cover;/);
  assert.match(html, /\.e video\.fit \{ object-fit:contain; \}/);
});

test('the kind survives normalisation (an unknown kind would have become body text)', () => {
  const s = R.normalizeSlide({ template: { elements: [vid('a', { fit: 'contain' })] } });
  assert.equal(s.elements[0].kind, 'video');
  assert.deepEqual(s.elements[0].cfg, { fit: 'contain' });
  assert.equal(s.elements[0].contentId, 'a');
});

test('a missing or unresolvable video is the quiet placeholder, like a missing photo', () => {
  const html = render({ elements: [vid('gone')] }, () => null);
  assert.equal(videoTags(html).length, 0);
  assert.match(html, /<div class="ph"><\/div>/);
});

test('⚠️ at most MAX_SLIDE_VIDEOS videos per slide; the background video counts', () => {
  assert.equal(R.MAX_SLIDE_VIDEOS, 2);
  const three = render({ elements: [vid('a'), vid('b'), vid('c')] });
  assert.deepEqual(videoTags(three).map((t) => /src="([^"]+)"/.exec(t)[1]),
    ['/uploads/content/a.mp4', '/uploads/content/b.mp4'], 'the first two in order');
  assert.equal((three.match(/class="ph"/g) || []).length, 1, 'the third holds its place');

  const withBg = render({ background_video_content_id: 'bg', elements: [vid('a'), vid('b')] });
  const srcs = videoTags(withBg).map((t) => /src="([^"]+)"/.exec(t)[1]);
  assert.deepEqual(srcs.sort(), ['/uploads/content/a.mp4', '/uploads/content/bg.mp4']);
});

test('an unresolvable video does not use up the budget', () => {
  const html = render({ elements: [vid('gone'), vid('a'), vid('b')] }, (id) => (id === 'gone' ? null : urls(id)));
  assert.equal(videoTags(html).length, 2);
});

test('⚠️ a deck save keeps the fit (storedCfg rebuilds elements key by key)', () => {
  const doc = deck.normalizeDeck({ slides: [{ id: 's1', template: { elements: [vid('a', { fit: 'contain' })] }, fields: {} }] });
  const el = doc.slides[0].template.elements[0];
  assert.equal(el.kind, 'video');
  assert.equal(el.fit, 'contain');
  assert.equal(el.content_id, 'a');
});

test('the AI generator is not offered video (it cannot pick a clip any more than a photo)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'ai.js'), 'utf8');
  assert.match(src, /filter\(\(k\) => k !== 'image' && !SLIDE_RENDER\.KINDS\[k\]\.config\)/);
  assert.equal(R.KINDS.video.config, true);
});

test('text over a video element is "cannot measure", never a contrast pass or fail', () => {
  const g = L.screenSize(55, 1920, 1080);
  const VIEW = { distanceM: 3, widthMm: g.widthMm, heightMm: g.heightMm, pxW: 1920, pxH: 1080 };
  const slide = { template: { background: '#FFFFFF', aspect: '16:9', elements: [
    { ...vid('a'), box: { x: 0, y: 0, w: 100, h: 100 } },
    { kind: 'body', slot: 't', box: { x: 10, y: 10, w: 80 }, style: { color: '#FFFFFF', size_cqw: 4, weight: 400 } },
  ] }, fields: { t: 'Hi' } };
  const issues = checkSlide(slide, VIEW);
  assert.ok(!issues.some((i) => i.code === 'contrast'), 'white on white would fail if the video were ignored');
  const u = issues.find((i) => i.code === 'contrast_unverified');
  assert.ok(u, JSON.stringify(issues));
  assert.equal(u.values.why, 'video');
});

test('the editor offers it: a Video tool, the video picker, kept aspect, corner radius', () => {
  const ed = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'slides.js'), 'utf8');
  assert.match(ed, /video: \{ icon: '▶', label: 'Video'/);
  assert.match(ed, /KEEP_ASPECT_KINDS = \['image', 'video', 'lettering'\]/);
  assert.match(ed, /e\.kind === 'video'\s*\n\s*\? row\('Video', `<select class="input" id="pImg">[\s\S]{0,80}videoContent\(\)/);
  assert.match(ed, /e\.kind === 'image' \|\| e\.kind === 'video' \|\| e\.kind === 'box'\) \? pair\('Corner'/);
  // The canvas preview plays it the way a panel does.
  assert.match(ed, /<video src="\$\{esc\(url\)\}" autoplay muted loop playsinline/);
});
