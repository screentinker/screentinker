'use strict';

// The feedback loop's HTTP surface on a real (hosted) server: an account can send feedback, only a
// platform admin can read it (JSON and CSV), and the follow-up email's page records NOTHING when
// opened (mail scanners open every link), only when its Send button posts.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer } = require('./helpers/web-player-e2e');
const feedback = require('../lib/feedback');

const SECRET = 'feedback-e2e-' + crypto.randomBytes(8).toString('hex');
let srv;
after(() => srv && srv.stop());

async function signup(base) {
  const r = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `fb${Date.now()}${crypto.randomBytes(2).toString('hex')}@x.test`, password: 'Passw0rd123' }) }).then((x) => x.json());
  return r;
}
const call = (base, token, method, p, body) => fetch(base + '/api' + p, { method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) });

test('send, read as admin only, CSV, and the email page records only on Send', async () => {
  srv = await startServer('feedback', { SELF_HOSTED: '', JWT_SECRET: SECRET });   // first account = platform admin
  const base = srv.base;
  const member = await signup(base);
  assert.ok(member.token, JSON.stringify(member));

  const sent = await call(base, member.token, 'POST', '/feedback', { trigger: 'general', rating: 4, comment: 'Roku pairing was easy' });
  assert.equal(sent.status, 201);
  assert.equal((await call(base, member.token, 'POST', '/feedback', { trigger: 'general', rating: 9 })).status, 400);
  assert.equal((await call(base, member.token, 'GET', '/feedback/admin')).status, 403, 'members cannot read feedback');

  const prompt = await call(base, member.token, 'GET', '/feedback/prompt').then((r) => r.json());
  assert.equal(prompt.enabled, true);

  const admin = await call(base, srv.token, 'GET', '/feedback/admin').then((r) => r.json());
  assert.ok(admin.entries.some((e) => e.comment === 'Roku pairing was easy'));
  const csv = await call(base, srv.token, 'GET', '/feedback/admin.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /Roku pairing was easy/);

  const memberId = member.user && member.user.id;
  assert.ok(memberId, 'register returns the user id');
  const tok = feedback.makeToken(memberId, 'trial_ended', { secret: SECRET });
  const count = async () => (await call(base, srv.token, 'GET', '/feedback/admin').then((r) => r.json())).total;
  const before = await count();
  const page = await fetch(`${base}/api/feedback/respond?t=${encodeURIComponent(tok)}&r=2`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /value="2" checked/);
  assert.equal(await count(), before, 'opening the link records nothing');

  const posted = await fetch(`${base}/api/feedback/respond`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['t', tok], ['rating', '2'], ['reasons', 'price'], ['reasons', 'hardware'], ['comment', 'Did not work on my LG']]).toString() });
  assert.equal(posted.status, 200);
  assert.match(await posted.text(), /Thank you/);
  const after2 = await call(base, srv.token, 'GET', '/feedback/admin').then((r) => r.json());
  const e = after2.entries.find((x) => x.comment === 'Did not work on my LG');
  assert.ok(e && e.source === 'email' && e.rating === 2 && e.trigger === 'trial_ended');
  assert.deepEqual(e.reasons.sort(), ['hardware', 'price']);

  assert.equal((await fetch(`${base}/api/feedback/respond?t=bogus.token&r=1`)).status, 410);
});
