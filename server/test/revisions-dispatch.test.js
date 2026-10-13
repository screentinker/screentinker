'use strict';

/*
 * captureState dispatches on a resource type that arrives from route params. It used to index an
 * object literal, where 'constructor', '__proto__' and 'toString' are truthy inherited members: the
 * `if (!TABLE[type])` guard waved them through to a SELECT against "function Object() ...".
 * Every name that is not one of the five resource types must be refused before any SQL is built.
 */

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
process.env.DATA_DIR = path.join(os.tmpdir(), 'st-revd-' + crypto.randomBytes(4).toString('hex'));
process.env.SELF_HOSTED = 'true';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const revisions = require('../lib/revisions');

// A db that fails the test if anything reaches it.
const untouchable = { prepare() { throw new Error('SQL was built for a type that should have been refused'); } };

test('inherited object members are not resource types', () => {
  for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', 'nope']) {
    assert.throws(() => revisions.captureState(untouchable, type, 'x'), /unknown resource type/, type);
  }
});

test('the five real types still dispatch', () => {
  const seen = [];
  const fakeDb = { prepare: (sql) => ({ get: () => { seen.push(sql); return null; } }) };
  for (const type of revisions.RESOURCE_TYPES) assert.equal(revisions.captureState(fakeDb, type, 'missing'), null);
  assert.equal(seen.length, revisions.RESOURCE_TYPES.length);
  for (const [i, type] of revisions.RESOURCE_TYPES.entries()) assert.match(seen[i], new RegExp(`FROM ${revisions.TABLE[type]} WHERE`));
});
