'use strict';

// The Duplicate button made the widget card's action row Edit · Duplicate · History · Delete. That
// row is right-aligned (justify-content: flex-end) inside a card that clips (overflow: hidden) and
// auto-fills down to 200px — and a flex-end row that does not fit spills out of its LEFT edge, so
// the FIRST button, Edit, vanished from every widget on a wide screen. The row must wrap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'css', 'main.css'), 'utf8');

function rule(selector) {
  const m = new RegExp(`(^|\\n)${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `${selector} rule exists`);
  return m[2].replace(/\/\*[\s\S]*?\*\//g, '');
}

test('card action rows wrap instead of overflowing (a clipped flex-end row hides its FIRST button)', () => {
  const actions = rule('.content-item-actions');
  assert.match(actions, /flex-wrap\s*:\s*wrap/, 'BUG: .content-item-actions does not wrap — the Edit button gets clipped off narrow cards');
});
