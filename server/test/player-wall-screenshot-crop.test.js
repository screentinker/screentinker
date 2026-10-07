'use strict';

/*
 * Every panel of a web-player wall sent the WHOLE picture as its screenshot.
 *
 * renderCaptureCanvas drew the first <video>/<img> across the canvas, and on a wall that element
 * fills the stage — the entire player rect. Live view then showed the full frame on every tile of a
 * 2-panel wall while the real screens correctly showed their halves (checked against the desktop).
 *
 * drawWallComposite draws the stage with the same geometry styleWallStage gives it on screen. These
 * run the real function with the real WallGeometry and a canvas that tracks its transform, and assert
 * where the picture's corners land.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLAYER = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
const SRC = PLAYER.slice(PLAYER.indexOf('function drawWallComposite('), PLAYER.indexOf('// Build the screenshot/stream canvas'));
const WallGeometry = require('../lib/wall-geometry');

// A 2D context reduced to its transform + what was drawn where (corners in canvas pixels).
function fakeCtx() {
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const pt = (x, y) => [Math.round(m[0] * x + m[2] * y + m[4]), Math.round(m[1] * x + m[3] * y + m[5])];
  const draws = [], fills = [];
  return {
    draws, fills,
    save() { stack.push(m.slice()); }, restore() { m = stack.pop(); },
    translate(x, y) { m = mul(m, [1, 0, 0, 1, x, y]); },
    rotate(r) { const c = Math.round(Math.cos(r)), s = Math.round(Math.sin(r)); m = mul(m, [c, s, -s, c, 0, 0]); },
    fillRect(x, y, w, h) { fills.push({ fillStyle: this.fillStyle, tl: pt(x, y), br: pt(x + w, y + h) }); },
    strokeRect() {}, fillText() {},
    drawImage(el, ...a) {
      const [x, y, w, h] = a.length === 4 ? a : a.slice(4);
      draws.push({ el: el.name, tl: pt(x, y), br: pt(x + w, y + h) });
    },
  };
}

function el(tag, props = {}) {
  return { tagName: tag, style: {}, classList: { contains: (c) => (props.className || '').split(' ').includes(c) }, children: [], ...props,
    querySelectorAll(sel) {
      const tags = sel.split(',').map((s) => s.trim());
      const out = [];
      const walk = (n) => n.children.forEach((c) => {
        if (tags.some((t) => (t.startsWith('.') ? c.classList.contains(t.slice(1)) : c.tagName === t.toUpperCase()))) out.push(c);
        walk(c);
      });
      walk(this);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
}
const img = (name) => el('IMG', { name, complete: true, naturalWidth: 1920, naturalHeight: 1080 });

function run(wallConfig, container, W = 960, H = 540) {
  const ctx = fakeCtx();
  const fn = new Function('window', 'wallConfig', 'isMediaReadable', 'videoFrameIsCapturable', 'drawMediaFit', 'drawZonePlaceholder',
    'zonePlaceholderLabel', 'getComputedStyle', `${SRC}; return drawWallComposite;`)(
    { WallGeometry }, wallConfig, () => true, () => true,
    (c, e, ew, eh, dx, dy, dw, dh) => c.drawImage(e, dx, dy, dw, dh),
    (c, dx, dy, dw, dh, label) => c.fillRect(dx, dy, dw, dh),
    () => 'Widget', () => ({ objectFit: 'fill' }));
  const out = fn(ctx, container, W, H);
  return { out, ctx };
}

const twoWide = { w: 3840, h: 1080 };
const leftPanel = { screen_rect: { x: 0, y: 0, w: 1920, h: 1080 }, player_rect: { x: 0, y: 0, ...twoWide }, rotation: 0 };
const rightPanel = { screen_rect: { x: 1920, y: 0, w: 1920, h: 1080 }, player_rect: { x: 0, y: 0, ...twoWide }, rotation: 0 };
function plainStage(name) {
  const c = el('DIV');
  const stage = el('DIV', { className: 'wall-stage' });
  stage.children.push(img(name));
  c.children.push(stage);
  return c;
}

test('the LEFT panel of a 2-wide wall captures the left half: the picture runs off its right edge', () => {
  const { out, ctx } = run(leftPanel, plainStage('river'));
  assert.deepEqual(out, { drawn: true, uncapturable: false });
  assert.deepEqual(ctx.draws, [{ el: 'river', tl: [0, 0], br: [1920, 540] }], 'twice the canvas wide, from x=0');
});

test('the RIGHT panel captures the right half: the picture starts one canvas-width to the left', () => {
  const { ctx } = run(rightPanel, plainStage('river'));
  assert.deepEqual(ctx.draws, [{ el: 'river', tl: [-960, 0], br: [960, 540] }]);
});

test('a panel mounted turned captures its framebuffer the way the stage is drawn on it (rotated about the centre)', () => {
  // One portrait-hung panel showing the whole player rect: the stage is turned 90° inside the framebuffer.
  const cfg = { screen_rect: { x: 0, y: 0, w: 1080, h: 1920 }, player_rect: { x: 0, y: 0, w: 1080, h: 1920 }, rotation: 90 };
  const { ctx } = run(cfg, plainStage('poster'), 960, 540);
  const [d] = ctx.draws;
  // The wall's top-left lands top-RIGHT on the framebuffer at 90° (lib/wall-geometry.js), and the box fills it.
  assert.deepEqual(d.tl, [960, 0]);
  assert.deepEqual(d.br, [0, 540]);
});

test('the hidden incoming stage of a buffered swap is not what the screen shows, so it is not captured', () => {
  const c = plainStage('outgoing');
  const incoming = el('DIV', { className: 'wall-stage' });
  incoming.style.visibility = 'hidden';
  incoming.children.push(img('incoming'));
  c.children.push(incoming);
  const { ctx } = run(leftPanel, c);
  assert.equal(ctx.draws[0].el, 'outgoing');
});

test('wall zones: each zone is placed from its box in the stage, so a zone on the other panel is off this canvas', () => {
  const c = el('DIV');
  const stage = el('DIV', { className: 'wall-stage', offsetWidth: 3840, offsetHeight: 1080 });
  const zone = (name, left, z) => {
    const zd = el('DIV', { className: 'zone', offsetLeft: left, offsetTop: 0, offsetWidth: 1920, offsetHeight: 1080 });
    zd.style.zIndex = String(z);
    const warming = img(name + '-warming'); warming.style.opacity = '0';
    zd.children.push(img(name), warming);
    return zd;
  };
  stage.children.push(zone('B', 1920, 1), zone('A', 0, 0));
  c.children.push(stage);
  const { ctx } = run(rightPanel, c);
  assert.deepEqual(ctx.draws, [
    { el: 'A', tl: [-960, 0], br: [0, 540] },   // zone A is the left panel's: entirely off this canvas
    { el: 'B', tl: [0, 0], br: [960, 540] },    // zone B fills the right panel
  ], 'z-order kept, and the opacity-0 warming element is skipped');
});

test('not a wall: the normal capture paths are used', () => {
  assert.equal(run(null, plainStage('x')).out, null);
});

test('renderCaptureCanvas asks for the wall composite before the single-element fast path', () => {
  const rc = PLAYER.slice(PLAYER.indexOf('function renderCaptureCanvas()'), PLAYER.indexOf('function captureAndSend()'));
  const wall = rc.indexOf('drawWallComposite(ctx, container, W, H)');
  const fast = rc.indexOf("container.querySelector('video')");
  assert.ok(wall > 0 && fast > wall);
});
