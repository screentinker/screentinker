'use strict';

// #41: unit tests for the security-critical bits of the AI design route -
// normalizing untrusted LLM output, and the SSRF guard on the configurable
// endpoint. Node v20 built-ins only; db is mocked so requiring the route doesn't
// touch a real database. SELF_HOSTED=false so the SSRF guard is active.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

process.env.JWT_SECRET = 'test-secret-ai';
process.env.SELF_HOSTED = 'false';

const db = new Database(':memory:');
const dbModulePath = require.resolve('../db/database');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: { db, pruneTelemetry() { }, pruneScreenshots() { } } };

const ai = require('../routes/ai');
const { normalizeDesign, endpointAllowed } = ai;

test('normalizeDesign: keeps valid text+shape, sets background', () => {
  const d = normalizeDesign({
    background: '#102030', elements: [
      { type: 'text', x: 5, y: 5, text: 'HELLO', fontSize: 90, color: '#ffffff', bold: true },
      { type: 'shape', x: 0, y: 90, width: 100, height: 8, color: '#ff0000', opacity: 0.5 },
    ]
  });
  assert.equal(d.background, '#102030');
  assert.equal(d.elements.length, 2);
  const txt = d.elements.find((e) => e.type === 'text');
  assert.equal(txt.text, 'HELLO');
  assert.equal(txt.fontFamily, 'Arial');
});

test('normalizeDesign: converts pixel shape dims to %, clamps ranges', () => {
  const d = normalizeDesign({
    elements: [
      { type: 'shape', x: -10, y: 200, width: 1920, height: 1080, color: 'red', opacity: 5 },
    ]
  });
  const s = d.elements[0];
  assert.equal(s.x, 0, 'x clamped so full-width shape fits');
  assert.equal(s.y, 0, 'y clamped so full-height shape fits (y+height<=100)');
  assert.ok(Math.abs(s.width - 100) < 0.01, '1920px -> 100%');
  assert.ok(Math.abs(s.height - 100) < 0.01, '1080px -> 100%');
  assert.equal(s.color, '#e65c00', 'non-hex color -> default');
  assert.equal(s.opacity, 1, 'opacity clamped to 1');
});

test('normalizeDesign: strips HTML from text, drops empty/invalid', () => {
  const d = normalizeDesign({
    elements: [
      { type: 'text', text: '<img src=x onerror=alert(1)>Sale</b>', fontSize: 9999 },
      { type: 'text', text: '   ' },
      { type: 'bogus', text: 'x' },
      null,
    ]
  });
  assert.equal(d.elements.length, 1, 'only the one real text survives');
  assert.equal(d.elements[0].text, 'Sale');
  assert.ok(!/[<>]/.test(d.elements[0].text), 'no angle brackets');
  assert.equal(d.elements[0].fontSize, 200, 'fontSize clamped to max');
});

test('normalizeDesign: caps element count + bad input', () => {
  const many = { elements: Array.from({ length: 50 }, () => ({ type: 'text', text: 'x' })) };
  assert.ok(normalizeDesign(many).elements.length <= 20);
  assert.deepEqual(normalizeDesign(null).elements, []);
  assert.equal(normalizeDesign({ background: 'notacolor' }).background, '#111827');
});

test('endpointAllowed: blocks private/internal when hosted, allows public https', () => {
  assert.equal(endpointAllowed('https://api.openai.com/v1'), true);
  assert.equal(endpointAllowed('http://localhost:11434/v1'), false);
  assert.equal(endpointAllowed('http://127.0.0.1:1234'), false);
  assert.equal(endpointAllowed('http://10.0.0.5/v1'), false);
  assert.equal(endpointAllowed('http://192.168.1.9/v1'), false);
  assert.equal(endpointAllowed('http://169.254.169.254/latest/meta-data'), false, 'cloud metadata blocked');
  assert.equal(endpointAllowed('http://172.16.5.5/v1'), false);
  assert.equal(endpointAllowed('ftp://example.com'), false, 'non-http blocked');
  assert.equal(endpointAllowed('not a url'), false);
});

test('normalizeDesign: long/large text is shrunk + repositioned to fit canvas', () => {
  const d = normalizeDesign({
    elements: [
      { type: 'text', x: 30, y: 95, text: 'GRAND OPENING THIS FRIDAY EVERYONE WELCOME', fontSize: 160, color: '#fff' },
    ]
  });
  const e = d.elements[0];
  const w = e.text.length * e.fontSize * 0.075;
  assert.ok(e.x + w <= 96.5, `fits horizontally (x=${e.x} w=${w.toFixed(1)})`);
  assert.ok(e.y + e.fontSize * 0.22 <= 96.5, 'fits vertically');
  assert.ok(e.fontSize < 160, 'fontSize was shrunk');
  assert.ok(e.x >= 4 && e.y >= 4, 'within margins');
});

test('normalizeDesign: separates overlapping text + orders shapes behind text', () => {
  const d = normalizeDesign({
    elements: [
      { type: 'text', x: 5, y: 40, text: 'HEADLINE TEXT HERE', fontSize: 60, color: '#fff' },
      { type: 'text', x: 5, y: 41, text: 'SUBTEXT OVERLAPPING IT', fontSize: 40, color: '#fff' },
      { type: 'shape', x: 0, y: 0, width: 100, height: 100, color: '#000', opacity: 0.5 },
    ]
  });
  assert.equal(d.elements[0].type, 'shape', 'shape rendered behind (first in array)');
  const texts = d.elements.filter((e) => e.type === 'text');
  const hi = texts[0].y <= texts[1].y ? texts[0] : texts[1];
  const lo = texts[0].y <= texts[1].y ? texts[1] : texts[0];
  assert.ok(lo.y >= hi.y + hi.fontSize * 0.22, 'text lines no longer overlap vertically');
});
