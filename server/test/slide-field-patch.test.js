'use strict';

/*
 * #790 live field patch — the RENDER half. With markers off (the default) a slide renders exactly
 * as before. With markers on, each {{ds:slug.key}} value is wrapped in its own <span data-ds> and
 * the slide carries the patch agent, so the player can update one field without reloading the slide.
 * The escaping contract is unchanged: every piece is escaped, the spans are the only new bytes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/slide-render');

const slide = (over = {}) => ({
  template: {
    background: '#101820',
    elements: [
      { slot: 'headline', kind: 'head', box: { x: 8, y: 30, w: 60 },
        style: { color: '#FFFFFF', font: 'sans', size_cqw: 7, weight: 700, align: 'left' } },
    ],
    ...(over.template || {}),
  },
  fields: { headline: 'Now: {{ds:menu.price}} today', ...(over.fields || {}) },
});

const resolve = (vals) => (slug, key) => vals[`${slug}.${key}`];

test('markers OFF (default): ds value is interpolated, but no [data-ds] and no patch agent', () => {
  const html = S.renderSlideHtml(slide(), { resolveData: resolve({ 'menu.price': '$9.99' }) });
  assert.match(html, /Now: \$9\.99 today/, 'the value is still interpolated inline');
  assert.doesNotMatch(html, /data-ds=/, 'no marker spans when the flag is off');
  assert.doesNotMatch(html, /st-ds-patch/, 'no patch agent when the flag is off');
});

test('markers ON: the ds value is wrapped in a [data-ds] span, static text preserved, agent present', () => {
  const html = S.renderSlideHtml(slide(), { fieldMarkers: true, resolveData: resolve({ 'menu.price': '$9.99' }) });
  assert.match(html, /Now: <span data-ds="menu\.price">\$9\.99<\/span> today/,
    'the value sits in its own data-ds span with the surrounding text intact');
  assert.match(html, /st-ds-patch/, 'the patch agent is injected when a field is marked');
});

test('markers ON but no ds field: no agent is injected', () => {
  const html = S.renderSlideHtml(slide({ fields: { headline: 'static headline' } }),
    { fieldMarkers: true, resolveData: resolve({}) });
  assert.doesNotMatch(html, /data-ds=/);
  assert.doesNotMatch(html, /st-ds-patch/, 'a slide with no ds tag never carries the agent');
});

test('markers ON: a ds value carrying markup is escaped inside the span (no new injection surface)', () => {
  const html = S.renderSlideHtml(slide({ fields: { headline: '{{ds:x.y}}' } }),
    { fieldMarkers: true, resolveData: resolve({ 'x.y': '<img src=x onerror=alert(1)>' }) });
  assert.match(html, /<span data-ds="x\.y">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/,
    'the value is HTML-escaped exactly as the plain path escapes it');
  assert.doesNotMatch(html, /<img src=x/, 'no raw markup reaches the document');
});

test('the agent only sets textContent and only reacts to st-ds-patch (read the injected source)', () => {
  const html = S.renderSlideHtml(slide(), { fieldMarkers: true, resolveData: resolve({ 'menu.price': '1' }) });
  assert.match(html, /d\.type!=='st-ds-patch'/, 'ignores any other message type');
  assert.match(html, /\.textContent=String\(/, 'writes textContent, never innerHTML');
  assert.doesNotMatch(html, /innerHTML/, 'the agent never touches innerHTML');
});
