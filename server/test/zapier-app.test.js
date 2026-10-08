'use strict';

/*
 * The Zapier app in /zapier must only promise what routes/zapier.js serves: the same events, an
 * action route for every create, and an option list for every dynamic dropdown. A Zap built on an
 * event or action the server dropped fails at 2am with nobody watching.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../../zapier');
const events = require('../lib/automation/events');
const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'zapier.js'), 'utf8');

test('the app offers exactly the events the server emits', () => {
  assert.deepEqual([...app.EVENTS].sort(), [...events.EVENTS].sort());
  for (const e of events.EVENTS) {
    const t = app.triggers[e];
    assert.ok(t, `no trigger for ${e}`);
    assert.equal(t.operation.type, 'hook', `${e} is a REST hook`);
    for (const fn of ['performSubscribe', 'performUnsubscribe', 'perform', 'performList']) assert.equal(typeof t.operation[fn], 'function', `${e}.${fn}`);
  }
});

test('every action and dropdown has a server route behind it', () => {
  for (const c of Object.values(app.creates)) {
    const src = c.operation.perform.toString();
    assert.match(src, /\/actions\/\$\{path\}/);
  }
  for (const p of ['emergency', 'playlist', 'trigger', 'data']) {
    assert.match(routes, new RegExp(`router\\.post\\('/actions/${p}'`), `routes/zapier.js serves /actions/${p}`);
  }
  const optionKinds = /const q = \{([\s\S]*?)\}\[req\.params\.kind\]/.exec(routes)[1].match(/^\s+(\w+): \(\)/gm).map((s) => s.trim().split(':')[0]);
  for (const c of Object.values(app.creates)) {
    for (const f of c.operation.inputFields) {
      if (!f.dynamic) continue;
      const trig = f.dynamic.split('.')[0];
      assert.ok(app.triggers[trig], `dropdown ${f.key} names trigger ${trig}`);
      assert.ok(optionKinds.includes(trig.replace(/_list$/, '')), `server has /options/${trig.replace(/_list$/, '')}`);
    }
  }
});

test('the token goes in the Authorization header, never the URL', () => {
  const req = { headers: {}, url: 'https://x.test/api/zapier/me' };
  app.beforeRequest[0](req, null, { authData: { api_token: 'st_secret', server_url: 'https://x.test' } });
  assert.equal(req.headers.Authorization, 'Bearer st_secret');
  assert.ok(!req.url.includes('st_secret'));
  assert.ok(!JSON.stringify(app.authentication.test).includes('api_token'));
});
