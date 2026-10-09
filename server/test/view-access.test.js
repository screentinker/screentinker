'use strict';

// lib/view-access.js on its own: CIDR validation and matching, the client IP an access decision
// uses, the viewer payload allowlist, and the instance switch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config');
const va = require('../lib/view-access');
const { canonicalLimitPath } = require('../lib/limit-paths');

test('CIDR input: IPv4 and IPv6 ranges and bare addresses; junk and "everyone" refused', () => {
  assert.equal(va.parseCidr('10.0.0.0/8'), '10.0.0.0/8');
  assert.equal(va.parseCidr(' 192.168.1.20 '), '192.168.1.20/32');
  assert.equal(va.parseCidr('2001:DB8::/32'), '2001:db8::/32');
  assert.equal(va.parseCidr('fe80::1'), 'fe80::1/128');
  for (const bad of ['10.0.0.0/33', '256.1.1.1/8', '10.0.0/8', 'banana', '0.0.0.0/0', '::/0', '10.0.0.0/-1', '1.2.3.4/8/9', '2001:db8::/129', ':::1']) {
    assert.equal(va.parseCidr(bad), null, bad);
  }
  assert.deepEqual(va.normaliseCidrs('10.0.0.0/8, 10.0.0.0/8\n192.168.0.0/16'), { cidrs: ['10.0.0.0/8', '192.168.0.0/16'] }, 'text, deduplicated');
  const r = va.normaliseCidrs(['10.0.0.0/8', 'nope']);
  assert.match(r.error, /nope/);
  assert.deepEqual(r.invalid, ['nope']);
  assert.match(va.normaliseCidrs(Array.from({ length: va.MAX_CIDRS + 1 }, (_, i) => `10.0.${i}.0/24`)).error, /At most/);
  assert.deepEqual(va.normaliseCidrs([]), { cidrs: [] }, 'empty clears the list');
});

test('CIDR matching, both families, including IPv4-mapped peers', () => {
  assert.equal(va.ipInCidrs('10.2.3.4', ['10.0.0.0/8']), true);
  assert.equal(va.ipInCidrs('11.2.3.4', ['10.0.0.0/8']), false);
  assert.equal(va.ipInCidrs('2001:db8::5', ['2001:db8::/32']), true);
  assert.equal(va.ipInCidrs('2001:db9::5', ['2001:db8::/32']), false);
  assert.equal(va.ipInCidrs('', ['10.0.0.0/8']), false);
  assert.equal(va.ipInCidrs('10.0.0.1', []), false, 'no ranges: nobody');
  const req = { socket: { remoteAddress: '::ffff:10.9.9.9' }, connection: { remoteAddress: '::ffff:10.9.9.9' }, headers: {} };
  assert.equal(va.viewerIp(req), '10.9.9.9');
});

test('X-Forwarded-For counts only through VIEW_TRUSTED_PROXIES', () => {
  const req = (peer) => ({ socket: { remoteAddress: peer }, connection: { remoteAddress: peer }, headers: { 'x-forwarded-for': '10.1.2.3' } });
  const saved = config.viewTrustedProxies;
  try {
    config.viewTrustedProxies = [];
    assert.equal(va.viewerIp(req('192.168.1.1')), '192.168.1.1', 'untrusted peer: the header is ignored');
    config.viewTrustedProxies = ['192.168.1.1'];
    assert.equal(va.viewerIp(req('192.168.1.1')), '10.1.2.3', 'the listed proxy is believed');
    assert.equal(va.viewerIp(req('192.168.1.2')), '192.168.1.2', 'its neighbour is not');
  } finally { config.viewTrustedProxies = saved; }
});

test('the viewer payload is an allowlist; secrets and the room panel capability never reach it', () => {
  const out = va.sanitizeForViewer({
    assignments: [{ content_id: 'c', widget_id: 'w', widget_panel: 'CAP', __origin_ws: 'ws', trigger: { secret: 's' }, filepath: 'f.mp4' }],
    layout: { id: 'l' }, orientation: 'landscape', trigger_config: { secret: 's' }, local_api: { secret: 's' },
    endpoints: [{ headers: { Authorization: 'x' } }], power_schedule: {}, triggers: [], wall_config: {}, group_sync: {},
    audience: {}, some_future_field: 'x',
  });
  assert.deepEqual(Object.keys(out).sort(), ['assignments', 'layout', 'orientation']);
  assert.deepEqual(out.assignments, [{ content_id: 'c', widget_id: 'w', filepath: 'f.mp4' }]);
  assert.deepEqual(va.sanitizeForViewer({ suspended: true, reason: 'trial', message: 'm', assignments: [] }),
    { suspended: true, reason: 'trial', message: 'm', assignments: [] }, 'a suspended screen shows its card');
});

test('tokens: 32 random bytes, stored as a hash, sealed copy decrypts', () => {
  const t = va.mintToken();
  assert.match(t.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t.hash, va.hashToken(t.token));
  assert.equal(require('../lib/secretbox').decrypt(t.enc), t.token);
  assert.notEqual(va.mintToken().token, t.token);
  assert.equal(va.looksLikeToken('short'), false);
  assert.equal(va.looksLikeToken('a'.repeat(200)), false);
});

test('the instance switch turns every door off, whatever a display says', () => {
  const saved = config.viewOnlyEnabled;
  const db = { prepare: () => { throw new Error('must not reach the database'); } };
  try {
    config.viewOnlyEnabled = false;
    assert.deepEqual(va.resolve(db, {}, { token: va.mintToken().token }), { status: 404, reason: 'disabled' });
    assert.deepEqual(va.resolve(db, {}, { deviceId: '00000000-0000-0000-0000-000000000000' }), { status: 404, reason: 'disabled' });
  } finally { config.viewOnlyEnabled = saved; }
});

test('the default follows SELF_HOSTED, and VIEW_ONLY_ENABLED overrides it', () => {
  const { execFileSync } = require('node:child_process');
  const read = (env) => execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./config').viewOnlyEnabled))"],
    { cwd: require('node:path').join(__dirname, '..'), env: { ...process.env, VIEW_ONLY_ENABLED: '', SELF_HOSTED: '', ...env } }).toString();
  assert.equal(read({ SELF_HOSTED: 'true' }), 'true');
  assert.equal(read({ SELF_HOSTED: '' }), 'false', 'the hosted cloud opts in explicitly');
  assert.equal(read({ SELF_HOSTED: 'true', VIEW_ONLY_ENABLED: 'false' }), 'false');
  assert.equal(read({ VIEW_ONLY_ENABLED: 'true' }), 'true');
});

test('rate limiting: one bucket per route shape, not one per token', () => {
  assert.equal(canonicalLimitPath('/view/abcDEF123_-xyz'), '/view/:token');
  assert.equal(canonicalLimitPath('/view/screen/0f8b2c1e-1111-2222-3333-444455556666'), '/view/screen/:id');
  assert.equal(canonicalLimitPath('/api/view/t/abcDEF/payload'), '/api/view/t/:key/payload');
  assert.equal(canonicalLimitPath('/api/view/d/some-id/payload'), '/api/view/d/:key/payload');
});

test('player: viewer state is declared above the boot gate that uses it (1.9.32 TDZ class)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['index.html', 'legacy.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'player', file), 'utf8');
    const gate = html.indexOf('bootViewer(VIEWER)');
    assert.ok(gate > 0, `${file}: the viewer boot gate exists (legacy.html is rebuilt from index.html)`);
    for (const v of ['viewerRev', 'viewerTimer', 'viewerEnded', 'viewerLastAnchor', 'viewerJoin']) {
      const decl = html.search(new RegExp(`(let|var) ${v}\\b`));
      assert.ok(decl > 0 && decl < gate, `${file}: ${v} must be declared before bootViewer runs — read first, it throws and the viewer never starts`);
    }
    // A screen is untouched: viewer mode is only ever entered from the server-injected config.
    assert.match(html, /const VIEWER = \(?window\.__playerConfig && window\.__playerConfig\.viewer\)? \|\| null;/);
  }
});
