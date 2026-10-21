'use strict';

/*
 * Slide editor fixes found while filming the user guides:
 *   - the private-address rule the QR codes page and the slide editor share (components/private-host.js)
 *   - source guards for the editor changes that need a browser to exercise for real
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const load = () => import(pathToFileURL(path.join(FRONTEND, 'components', 'private-host.js')).href);
const slidesSrc = fs.readFileSync(path.join(FRONTEND, 'views', 'slides.js'), 'utf8');
const qrSrc = fs.readFileSync(path.join(FRONTEND, 'views', 'qr-codes.js'), 'utf8');

test('private hosts: everything the old rule caught is still caught', async () => {
  const { isPrivateHost } = await load();
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.20', '172.16.0.1', '172.31.255.1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('private hosts: IPv6 and .local names are caught (the old rule missed them)', async () => {
  const { isPrivateHost } = await load();
  for (const h of ['[::1]', '::1', '[fd00::1]', 'fd12:3456::7', 'fc00::1', '[fe80::1]',
    '::ffff:192.168.1.5', '::ffff:c0a8:105', 'signage.local', 'SIGNAGE.LOCAL.', 'app.localhost', '169.254.1.1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('private hosts: public names and addresses are not flagged', async () => {
  const { isPrivateHost } = await load();
  for (const h of ['screentinker.com', 'signs.example.org', '8.8.8.8', '172.32.0.1', '172.15.0.1',
    '[2001:db8::1]', '2606:4700::1111', '::ffff:8.8.8.8', 'localhost.example.com', 'fdroid.org', '', null]) {
    assert.equal(isPrivateHost(h), false, String(h));
  }
});

test('urlHost reads a URL host and ignores plain text', async () => {
  const { urlHost } = await load();
  assert.equal(urlHost('http://192.168.1.5:3001/q/abc'), '192.168.1.5');
  assert.equal(urlHost('http://[::1]:3001/q/abc'), '[::1]');
  assert.equal(urlHost('tel:+15551234'), '');
  assert.equal(urlHost('just some words'), '');
});

test('the QR codes page and the slide editor share the one rule', () => {
  assert.match(qrSrc, /import \{ isPrivateHost \} from '\.\.\/components\/private-host\.js'/);
  assert.doesNotMatch(qrSrc, /192\\\.168/, 'qr-codes.js still has its own copy of the rule');
  assert.match(slidesSrc, /from '\.\.\/components\/private-host\.js'/);
  assert.match(slidesSrc, /slides\.qr\.private_address/);
});

test('Insert Variable lists the keys the source has, not a fixed calendar list', () => {
  assert.doesNotMatch(slidesSrc, /Agenda Text \(/);
  assert.match(slidesSrc, /dataSourceKeys\(ds\)/);
});

test('the toolbar Add keeps the same element cap as paste', () => {
  const add = slidesSrc.slice(slidesSrc.indexOf("closest('[data-add]')"), slidesSrc.indexOf("closest('[data-add]')") + 600);
  assert.match(add, /MAX_ELEMENTS/);
});

test('A.I. Generate records an undo step', () => {
  const at = slidesSrc.indexOf('s2.fields = out.fields');
  assert.ok(at > 0);
  assert.match(slidesSrc.slice(at, at + 400), /touch\(container\)/);
});

test('the sign templates use no made-up data source slugs and no fixed German text', () => {
  for (const bad of ["'testraum'", "'abfall'", 'Konferenzraum', 'Müllabfuhr', 'Nächstes Meeting', 'Termin:']) {
    assert.ok(!slidesSrc.includes(bad), `slides.js still contains ${bad}`);
  }
});

test('choosing "Not tracked" does something', () => {
  const at = slidesSrc.indexOf("qrLinkSel.onchange");
  assert.ok(at > 0);
  assert.match(slidesSrc.slice(at, at + 1400), /target_url/);
});
