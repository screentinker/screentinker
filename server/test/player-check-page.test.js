'use strict';

// /player/check (player/check.html): the page a screen opens when /player shows an empty setup page.
// It exists for browsers too old for the player, so it must itself parse on them: ES3-era syntax only,
// no external script, and served on its own route ahead of the /player static handler.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'player', 'check.html'), 'utf8');
const scripts = [...HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

test('the check page is routed', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /app\.get\(\['\/player\/check', '\/player\/check\/'\]/);
});

test('its script parses on an ES3/ES5 browser: none of the syntax that blanks the player there', () => {
  assert.ok(scripts.length > 0, 'it has inline script');
  assert.doesNotMatch(HTML, /<script\b[^>]*\bsrc=/, 'no external script: one request, nothing else to fail');
  // Strip strings and comments first, so the probe strings it tests with ("() => 1") do not count.
  const code = scripts
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');
  for (const [re, what] of [[/=>/, 'arrow functions'], [/\blet\s/, 'let'], [/\bconst\s/, 'const'], [/`/, 'template literals'], [/\bclass\s/, 'class'], [/\.\.\./, 'spread']]) {
    assert.doesNotMatch(code, re, `${what} would stop the check page itself on the browsers it is for`);
  }
});

test('it names both players it can recommend', () => {
  assert.match(HTML, /\/player\/legacy/);
  assert.match(HTML, /\/player\b/);
});
