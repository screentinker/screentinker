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
const { ALLOWED_COMMANDS } = require('../lib/device-command');

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
      // Operational/fleet-affecting routes require 'full' even though they aren't GETs:
      // the group command route, and #109 PiP (push an arbitrary web overlay to devices).
      /*
       * ⚠️ /triggers IS HERE BECAUSE IT ENFORCES full, NOT BECAUSE IT FEELS IMPORTANT.
       * routes/triggers.js guards every mutation with requireScope('full'): a trigger rewrites what
       * a screen shows in response to an unauthenticated LAN packet, which is a fleet-affecting
       * capability rather than ordinary content editing. Documenting it as 'write' would send an
       * integrator to a guaranteed 403 while telling them their token was sufficient.
       */
      /*
       * ⚠️ /display-power-schedules is here for the SAME reason as /triggers directly above: it
       * enforces full. routes/display-power-schedules.js guards every mutation with
       * requireScope('full') + requireFleetWrite, because deciding when a screen is LIT is a
       * fleet-affecting capability rather than ordinary content editing — it is the one setting
       * that can make an estate go dark, and an integrator whose token was merely 'write' would be
       * sent to a guaranteed 403 while the docs told them they were fine.
       */
      const isFullScope = p.includes('command') || p === '/pip' || p.startsWith('/pip/')
        || p === '/triggers' || p.startsWith('/triggers/')
        || p.endsWith('/trigger-config') || p.endsWith('/trigger-secret')
        || p === '/display-power-schedules' || p.startsWith('/display-power-schedules/')
        /*
         * ⚠️ /device-endpoints enforces full for the same reason as its neighbours above:
         * routes/device-endpoints.js guards every mutation with requireScope('full') +
         * requireFleetWrite, because saving one makes a screen issue requests inside the customer's
         * private network on a timer. Documenting it as 'write' would send an integrator to a
         * guaranteed 403 while the docs told them they were fine.
         */
        || p === '/device-endpoints' || p.startsWith('/device-endpoints/');
      const expected = (m === 'get' || m === 'head') ? 'read' : (isFullScope ? 'full' : 'write');
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

// The published spec version is what Redoc prints at the top of the API reference, so a stale
// value tells integrators they are reading docs for a release that no longer exists. It HAD gone
// stale — the spec said 1.9.0 while 1.9.25 was shipping — because bump-version.sh updated every
// other version source and not this one. That step now exists; this test is what keeps it honest,
// since the failure mode is silent and nobody reads a version number they already trust.
test('openapi: the spec version tracks the shipped release', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  // Pre-release labels (1.9.26-beta.1) live on the build, not on the published API identity,
  // so compare the numeric core the way bump-version.sh writes it.
  const numeric = (v) => String(v).split('-')[0];
  assert.equal(
    numeric(spec.info.version),
    numeric(pkg.version),
    'docs/openapi.yaml info.version drifted from server/package.json — bump-version.sh should ' +
    'have moved both; if you edited a version by hand, move this one too',
  );
});

// Two addresses that are easy to mix up: ip_address is the public/WAN address the SERVER observed
// on connect, local_ip is the LAN address the PLAYER reported about itself. An integrator reaching
// a panel on site needs local_ip; one correlating sites needs ip_address. Both are returned by
// GET /devices, so both must be documented and must not be described interchangeably.
test('openapi: a device documents its WAN and LAN addresses distinctly', () => {
  const props = spec.components.schemas.Device.properties;
  for (const field of ['ip_address', 'local_ip', 'local_ip6']) {
    assert.ok(props[field], `Device.${field} is returned by GET /devices but is not documented`);
    assert.ok(
      props[field].type.includes('null'),
      `Device.${field} must be nullable — it is absent until a device reports/connects`,
    );
    assert.ok(props[field].description, `Device.${field} needs a description to be told apart`);
  }
  assert.match(props.ip_address.description, /WAN|public/i);
  assert.match(props.local_ip.description, /local network|LAN/i);
  assert.match(props.local_ip6.description, /local network|LAN/i);
  // The two LAN fields are a pair, not alternatives — a dual-stack panel reports both, so the
  // spec must not let an integrator read one as a fallback for the other.
  assert.match(props.local_ip.description, /IPv4/i);
  assert.match(props.local_ip6.description, /IPv6/i);
});

// "permission" is a sentinel, not a network name: Android 10+ withholds the SSID without a
// location permission ScreenTinker only requests if an operator opts in. An integrator who does
// not know that will render it as the Wi-Fi name to an end user.
test('openapi: the wifi_ssid permission sentinel is documented', () => {
  const ssid = spec.components.schemas.Device.properties.wifi_ssid;
  assert.ok(ssid, 'wifi_ssid is returned by GET /devices but is not documented');
  assert.match(ssid.description, /permission/, 'the sentinel value must be explained');
});

/*
 * ⚠️ THE COMMAND ENUM HAD ALREADY DRIFTED, BY FIFTEEN COMMANDS.
 *
 * ALLOWED_COMMANDS grew three times - device-owner tooling (#161), system control (#160), and the
 * Tier-2 set - and each time the spec kept the original six. An integrator reading the docs would
 * conclude their token could reboot a screen but not set its volume, when in fact both were
 * accepted; the failure is invisible because a stale enum documents a SUBSET, so nothing 400s and
 * nothing looks wrong. It is exactly the drift this file exists to make impossible.
 */
test('openapi: the documented command set matches what the server accepts', () => {
  const documented = {};
  for (const [p, ops] of Object.entries(spec.paths || {})) {
    if (!p.endsWith('/command')) continue;
    const enumerated = ops.post?.requestBody?.content?.['application/json']
      ?.schema?.properties?.type?.enum;
    assert.ok(Array.isArray(enumerated), `${p} documents no command enum at all`);
    documented[p] = enumerated;
  }
  assert.ok(Object.keys(documented).length >= 2,
    'both the group and the single-device command routes should be documented');

  for (const [p, enumerated] of Object.entries(documented)) {
    // Sorted, because the ORDER is presentation and the SET is the contract.
    assert.deepEqual([...enumerated].sort(), [...ALLOWED_COMMANDS].sort(),
      `${p} documents a different command set than lib/device-command.js enforces`);
  }
});
