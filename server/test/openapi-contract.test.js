'use strict';

// Contract tests for the published OpenAPI spec. The spec is the integrator-facing
// contract, so it must not drift from what the server actually enforces. These parse
// docs/openapi.yaml directly (no server needed) and are derived from the same
// config/api-surface.js the server mounts from.
//
// Born from a real self-review finding: POST /widgets/preview was documented as scope
// 'read' while the method-based tokenScopeGate enforces 'write' for any POST, so a
// read-token integrator following the docs would hit a surprise 403. This makes that
// class of drift fail CI forever after.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { PUBLIC_ROUTERS, JWT_ONLY_ROUTERS } = require('../config/api-surface');

const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml'), 'utf8'));
const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head'];
// Spec paths are written without the /api prefix (servers: [{ url: /api }]).
const PUBLIC_PREFIXES = PUBLIC_ROUTERS.map(r => r.path.replace(/^\/api/, ''));
const JWT_ONLY_PREFIXES = JWT_ONLY_ROUTERS.map(r => r.path.replace(/^\/api/, ''));
const underPrefix = (p, prefixes) => prefixes.some(pre => p === pre || p.startsWith(pre + '/'));

test('openapi: every operation x-required-scope matches the method-based enforcement', () => {
  // Mirrors tokenScopeGate (GET/HEAD -> read, mutations -> write) + requireScope('full')
  // on the operational command route. Public render endpoints (security: []) carry no scope.
  const mismatches = [];
  for (const [p, ops] of Object.entries(spec.paths || {})) {
    for (const [m, op] of Object.entries(ops)) {
      if (!METHODS.includes(m) || !op || typeof op !== 'object') continue;
      if (Array.isArray(op.security) && op.security.length === 0) continue; // unauthenticated render
      const expected = (m === 'get' || m === 'head') ? 'read' : (p.includes('command') ? 'full' : 'write');
      if (op['x-required-scope'] !== expected) {
        mismatches.push(`${m.toUpperCase()} ${p}: spec='${op['x-required-scope']}' enforcement='${expected}'`);
      }
    }
  }
  assert.deepEqual(mismatches, [], 'spec x-required-scope drifted from enforcement:\n' + mismatches.join('\n'));
});

test('openapi: every documented path is a token-reachable (public) router, never JWT-only', () => {
  // The spec must never advertise a JWT-only / privileged route as part of the token
  // surface (it would invite an integrator to call something their token can't reach).
  const offenders = [];
  for (const p of Object.keys(spec.paths || {})) {
    if (underPrefix(p, JWT_ONLY_PREFIXES) || !underPrefix(p, PUBLIC_PREFIXES)) offenders.push(p);
  }
  assert.deepEqual(offenders, [], 'spec documents non-public paths:\n' + offenders.join('\n'));
});
