'use strict';

/*
 * Social walls, the parts that need no server: the guarded media fetch, the blocklist, Mastodon's
 * HTML flattening, image sniffing, and the page's escaping.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getMedia } = require('../lib/social/http');
const { blocked } = require('../lib/social/feeds');
const { htmlToText } = require('../lib/social/networks');
const { sniff } = require('../lib/social/media');
const widget = require('../lib/social/widget');

test('the media fetcher refuses metadata, private and loopback addresses', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    for (const u of ['https://169.254.169.254/latest/meta-data/', 'https://10.0.0.7/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://metadata.google.internal/x']) {
      await assert.rejects(getMedia(u), (e) => /blocked|private|reserved|ssrf|loopback|link-local|metadata/i.test(`${e.name} ${e.message} ${e.code || ''}`), u);
    }
    await assert.rejects(getMedia('http://example.com/a.png'), /https/, 'plain http is refused outside tests');
    await assert.rejects(getMedia('file:///etc/passwd'));
  } finally { process.env.NODE_ENV = prev; }
});

test('the blocklist matches whole words, hashtags and mentions, any case', () => {
  assert.equal(blocked('Great ROAST today', ['roast']), true);
  assert.equal(blocked('#roast season', ['roast']), true);
  assert.equal(blocked('ping @roast', ['roast']), true);
  assert.equal(blocked('roasted beans', ['roast']), false, 'not a substring match');
  assert.equal(blocked('café crème', ['crème']), true, 'unicode words');
  assert.equal(blocked('a.b (c)', ['(c)']), true, 'punctuation in an entry is matched literally');
  assert.equal(blocked('a.b c', ['a.b c']), true);
  assert.equal(blocked('axb c', ['a.b']), false, 'a dot is not a wildcard');
  assert.equal(blocked('anything', []), false);
});

test("Mastodon's HTML becomes plain text", () => {
  assert.equal(htmlToText('<p>a &amp; b</p><p>c<br/>d</p>'), 'a & b\n\nc\nd');
  assert.equal(htmlToText('<script>alert(1)</script>x'), 'alert(1)x', 'tags are dropped, never kept');
  assert.equal(htmlToText('&lt;img src=x&gt;'), '<img src=x>', 'entities decode to TEXT, which the wall renders with textContent');
  assert.equal(htmlToText('&#128512;&#x1F600;&#0;'), '😀😀');
});

test('only image bytes are kept, whatever the content type said', () => {
  assert.equal(sniff(Buffer.from('<html><body>hi</body></html>')), null);
  assert.equal(sniff(Buffer.from('ffd8ffe000104a464946000101', 'hex')), 'image/jpeg');
  assert.equal(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'image/webp');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'SVG (which can carry script) is not accepted');
});

test('JSON in the page cannot close its script element', () => {
  const s = widget.jsonForScript({ t: '</script><!-- \u2028 & >' });
  assert.ok(!/[<>&\u2028]/.test(s));
  assert.deepEqual(JSON.parse(s), { t: '</script><!-- \u2028 & >' });
});

test('the editor preview renders sample posts with no network', () => {
  const html = widget.previewHtml({ layout: 'ticker' });
  assert.match(html, /"layout":"ticker"/);
  assert.match(html, /Doors open at 9/);
});
