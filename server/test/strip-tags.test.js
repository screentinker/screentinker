'use strict';

// lib/strip-tags.js and the markup flatteners built on it. These are TEXT flatteners, not
// sanitisers — every caller renders the result as text — but a stripped tag must still never leave
// the halves around it joined into a new one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stripTags } = require('../lib/strip-tags');
const md = require('../lib/markdown-rendition');

test('every complete tag is dropped, and a stray < with no > is left as text', () => {
  assert.equal(stripTags('<p>a <b>b</b></p>'), 'a b');
  assert.equal(stripTags('5 < 6'), '5 < 6');
  assert.equal(stripTags('<scr<script>ipt>alert(1)'), 'ipt>alert(1)');
  assert.ok(!/<[^>]*>/.test(stripTags('<<a>b<<c>>d>')), 'no complete tag survives');
  assert.equal(stripTags(42), '42');
});

test('a rendition never reassembles a tag from the halves of a removed block', () => {
  const html = '<main><p>x</p><scr<script>1</script>ipt>alert(1)</script><!<!-- c -->-- d --></main>';
  const out = md.toMarkdown(html);
  assert.ok(!/<script/i.test(out), `a script tag was reassembled: ${out}`);
  assert.ok(!/<!--/.test(out), `a comment opener was reassembled: ${out}`);
});

test('an empty <i></i> pair removed from inside another tag does not leave that tag behind', () => {
  const out = md.toMarkdown('<main><p><<i></i>iframe src=x>y</p></main>');
  assert.ok(!/<iframe/i.test(out), out);
});

test('a backslash before a pipe in a table cell cannot turn into a column break', () => {
  const out = md.toMarkdown('<main><table><tr><th>a</th></tr><tr><td>x\\|y</td></tr></table></main>');
  // "x\|y" escapes to "x\\\|y": an escaped backslash, then an escaped pipe. Still one cell.
  assert.match(out, /^\| x\\\\\\\|y \|$/m, out);
  // And a backslash that is NOT before a pipe is left alone (GFM keeps "\\" in a code span literally).
  const win = md.toMarkdown('<main><table><tr><th>p</th></tr><tr><td><code>C:\\dir</code></td></tr></table></main>');
  assert.match(win, /`C:\\dir`/, win);
  assert.doesNotMatch(win, /C:\\\\dir/, win);
});
