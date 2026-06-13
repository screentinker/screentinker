'use strict';

// #90: the vestigial bare POST /api/provision is consolidated to POST /api/provision/pair.
// It must now return 410 Gone and point callers at /pair. Mounts the router in-process
// (it no longer touches the DB, so no server boot or injection is needed). The token ->
// 401 firewall for /api/provision is covered by the partition test in api.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const provisioningRouter = require('../routes/provisioning');

const app = express();
app.use(express.json());
app.use('/api/provision', provisioningRouter);

let server, base;
before(() => new Promise((resolve) => {
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
after(() => { if (server) server.close(); });

test('provisioning: the bare POST /api/provision is gone (410, consolidated to /pair)', async () => {
  const res = await fetch(base + '/api/provision', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pairing_code: '123456' }),
  });
  assert.equal(res.status, 410);
  assert.match(JSON.stringify(await res.json()), /provision\/pair/i, 'should point at POST /api/provision/pair');
});
