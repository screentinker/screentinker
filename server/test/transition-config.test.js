'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { resolveTransitionConfig, normalizeTransitions } = require('../lib/transition-config');

const T = (cfg) => ({ widget_id: 'w', widget_type: 'transition', widget_config: JSON.stringify(cfg) });
const IMG = (id) => ({ content_id: id, mime_type: 'image/png' });

test('resolveTransitionConfig: valid shader resolves + clamps params/duration', () => {
  const r = resolveTransitionConfig({ shader: 'CRTCollapse', params: { lineHold: 99, flashGain: -5 }, durationMs: 800, scope: 'next' });
  assert.equal(r.shader, 'CRTCollapse');
  assert.equal(r.durationMs, 800);
  assert.equal(r.scope, 'next');
  assert.equal(r.params.lineHold, 0.45, 'over-range param clamped to shader max');
  assert.equal(r.params.flashGain, 0, 'under-range param clamped to shader min');
});

test('resolveTransitionConfig: unknown shader -> null (hard cut, never black)', () => {
  assert.equal(resolveTransitionConfig({ shader: 'NopeShader' }), null);
  assert.equal(resolveTransitionConfig({ shader: '' }), null);
  assert.equal(resolveTransitionConfig('not json'), null);
});

test('resolveTransitionConfig: duration bounded, scope defaults to next', () => {
  assert.equal(resolveTransitionConfig({ shader: 'Etch', durationMs: 999999 }).durationMs, 3000);
  assert.equal(resolveTransitionConfig({ shader: 'Etch', durationMs: 1 }).durationMs, 150);
  assert.equal(resolveTransitionConfig({ shader: 'Etch' }).durationMs, 800, 'missing duration -> default');
  assert.equal(resolveTransitionConfig({ shader: 'Etch' }).scope, 'next');
  assert.equal(resolveTransitionConfig({ shader: 'Etch', scope: 'all' }).scope, 'all');
});

test('normalizeTransitions: scope:next attaches to the FOLLOWING item, widget dropped', () => {
  const out = normalizeTransitions([IMG('a'), T({ shader: 'CRTCollapse', scope: 'next' }), IMG('b'), IMG('c')]);
  assert.equal(out.length, 3, 'transition widget removed from visible list');
  assert.deepEqual(out.map((i) => i.content_id), ['a', 'b', 'c']);
  assert.equal(out[0].transition, undefined);
  assert.equal(out[1].transition.shader, 'CRTCollapse', 'plays INTO b');
  assert.equal(out[2].transition, undefined);
});

test('normalizeTransitions: scope:all is a playlist default, scope:next overrides it', () => {
  const out = normalizeTransitions([
    T({ shader: 'Etch', scope: 'all' }),
    IMG('a'), IMG('b'),
    T({ shader: 'CRTCollapse', scope: 'next' }), IMG('c'),
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].transition.shader, 'Etch', 'default applies to a');
  assert.equal(out[1].transition.shader, 'Etch', 'default applies to b');
  assert.equal(out[2].transition.shader, 'CRTCollapse', 'override wins for c');
});

test('normalizeTransitions: a trailing scope:next wraps onto the first item (loop)', () => {
  const out = normalizeTransitions([IMG('a'), IMG('b'), T({ shader: 'ReelChange', scope: 'next' })]);
  assert.equal(out.length, 2);
  assert.equal(out[0].transition.shader, 'ReelChange', 'last->first advance');
  assert.equal(out[1].transition, undefined);
});

test('normalizeTransitions: unknown-shader transition widget is dropped, no transition attached', () => {
  const out = normalizeTransitions([IMG('a'), T({ shader: 'Ghost' }), IMG('b')]);
  assert.equal(out.length, 2);
  assert.equal(out[1].transition, undefined, 'invalid config -> hard cut, not a black frame');
});

test('normalizeTransitions: non-transition widgets pass through untouched', () => {
  const clock = { widget_id: 'c1', widget_type: 'clock' };
  const out = normalizeTransitions([IMG('a'), clock, T({ shader: 'Etch', scope: 'next' }), IMG('b')]);
  assert.equal(out.length, 3);
  assert.equal(out[1].widget_type, 'clock', 'clock widget stays visible');
  assert.equal(out[1].transition, undefined);
  assert.equal(out[2].transition.shader, 'Etch');
});
