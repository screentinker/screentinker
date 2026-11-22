'use strict';

// /player sends engines that cannot parse it to /player/legacy (webOS 4-6, Tizen-era Chromium).
// Without it, "Play via URL" or an older IPK on those panels hit a SyntaxError in the main script
// block and showed black ("Unexpected token" field reports). The redirect itself must be ES5 and must
// run before any other player script, or it fails the same way it exists to prevent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PLAYER = path.join(__dirname, '..', 'player');
const MARK = 'OLD ENGINES GO TO THE LEGACY BUILD';

function redirectScript(html) {
  const at = html.indexOf(MARK);
  assert.ok(at > 0, 'legacy redirect block missing');
  const open = html.indexOf('<script>', at);
  const close = html.indexOf('</script>', open);
  return { at, code: html.slice(open + '<script>'.length, close) };
}

function run(code, pathname, modern) {
  let replaced = null;
  const ctx = {
    window: { location: { pathname, search: '?host=webos', hash: '#x', replace: (u) => { replaced = u; } } },
    // An old engine cannot compile `?.`: simulate it by making Function throw a SyntaxError.
    Function: modern ? Function : function () { throw new SyntaxError("Unexpected token '.'"); },
  };
  vm.runInNewContext(code, ctx);
  return replaced;
}

for (const file of ['index.html', 'legacy.html']) {
  test(`${file}: the legacy redirect is ES5 and runs before every other player script`, () => {
    const html = fs.readFileSync(path.join(PLAYER, file), 'utf8');
    const { at, code } = redirectScript(html);
    assert.doesNotMatch(code.replace(/\/\*[\s\S]*?\*\//g, ''), /=>|\bconst\b|\blet\b|`|\bclass\b/, 'redirect must stay ES5');
    const firstSrc = html.search(/<script\s+src=/);
    assert.ok(firstSrc < 0 || at < firstSrc, 'redirect must come before the first external player script');
  });
}

test('an engine without ?. on /player goes to /player/legacy, keeping query and hash', () => {
  const { code } = redirectScript(fs.readFileSync(path.join(PLAYER, 'index.html'), 'utf8'));
  for (const p of ['/player', '/player/', '/player/index.html']) assert.equal(run(code, p, false), '/player/legacy?host=webos#x');
});

test('a modern engine stays, and nothing outside the exact /player paths is bounced', () => {
  const { code } = redirectScript(fs.readFileSync(path.join(PLAYER, 'index.html'), 'utf8'));
  assert.equal(run(code, '/player', true), null);
  for (const p of ['/player/legacy', '/player/legacy.html', '/view/abc', '/index.html', '']) assert.equal(run(code, p, false), null, p);
});
