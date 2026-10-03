'use strict';

/*
 * ⚠️ WHAT AN API TOKEN MAY NEVER READ OFF A DEVICE ROW.
 *
 * Two of the columns on `devices` are remote credentials, and handing either to an integration
 * token converts a read scope into a write no scope granted:
 *
 *   trigger_secret — an unauthenticated LAN datagram that changes what a screen shows.
 *   enrol_key      — more than that: the holder can BE the display. Register as it, take its
 *                    playlist and its commands, report as it.
 *
 * The enrolment key shipped withheld from the device LIST — the blast-radius reasoning that governs
 * settings_pin — and that is where it stopped. The DETAIL endpoint has no scope gate, so a
 * read-scoped token could read the key straight off `GET /api/devices/:id`. Same escalation the
 * trigger secret is already defended against, on the stronger of the two credentials.
 *
 * These assertions are per-credential and per-shape rather than "the response looks fine", because
 * the bug was not a missing check — it was a check that covered one credential and not its
 * neighbour.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../lib/device-sanitize');

const row = () => ({
  id: 'd1',
  name: 'Lobby',
  device_token: 'tok',
  settings_pin: '123456',
  trigger_secret: 'shhh',
  enrol_key: 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk',
});

test('an API token gets neither remote credential', () => {
  const out = S.stripSecretsForTokens(row(), true);
  assert.equal(out.trigger_secret, undefined, 'the trigger secret escalates read into control');
  assert.equal(out.enrol_key, undefined, 'the enrolment key lets the holder become the display');
  // ...and it is not a blanket wipe: the token still gets a usable device.
  assert.equal(out.id, 'd1');
  assert.equal(out.name, 'Lobby');
});

test('a dashboard session keeps both, because the operator screens are the only place they exist', () => {
  const out = S.stripSecretsForTokens(row(), false);
  assert.equal(out.trigger_secret, 'shhh', 'a human configuring a panel has to read it somewhere');
  assert.equal(out.enrol_key.length, 40, 'the operator has to read the player URL to paste it into vMix');
});

test('the list drops every secret with a single consumer, for every caller', () => {
  const out = S.stripDeviceSecretsForList(row());
  for (const k of ['device_token', 'settings_pin', 'trigger_secret', 'enrol_key']) {
    assert.equal(out[k], undefined, `${k} must not ride on the collection endpoint`);
  }
});

test('device_token leaves on every path, session or token', () => {
  assert.equal(S.stripDeviceSecrets(row()).device_token, undefined);
  assert.equal(S.stripSecretsForTokens(S.stripDeviceSecrets(row()), false).device_token, undefined);
});

/*
 * ⚠️ AND THE ROUTES HAVE TO ACTUALLY CALL IT. The sanitiser was correct for the list the whole
 * time; the hole was a response that never asked. Every device row that leaves devices.js has to
 * pass through the token filter, so this reads the source rather than trusting the unit above.
 */
test('every device-row response in devices.js passes through the token filter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');

  // The detail endpoint: filters in place before the spread that builds the response.
  assert.match(src, /stripSecretsForTokens\(device, req\.viaToken\)/,
    'GET /:id must filter the row for token callers');

  // The two echo paths that return a device after a write.
  const echoes = src.match(/res\.json\(stripSecretsForTokens\(stripDeviceSecrets\(updated\), req\.viaToken\)\)/g) || [];
  assert.equal(echoes.length, 2, `expected both write echoes to filter, found ${echoes.length}`);

  // The narrower old name must not come back on a call site and quietly reinstate the gap.
  assert.ok(!/stripTriggerSecretForTokens\s*\(/.test(src),
    'devices.js should call stripSecretsForTokens — the old name covered only one credential');
});

/*
 * ⚠️ READING THE KEY WAS ONLY HALF THE DOOR. 2.0.3 stopped an API token reading an enrolment key
 * off a device. Minting one was left on the default method-based gate, where anything that is not a
 * GET needs only `write` — so a write-scoped integration could roll a key for any display in reach
 * and then adopt that display's identity with it, which is the exact power the read was closed to
 * deny. Revoke matters for the mirror reason: it is a vMix display's only way back.
 */
test('minting or revoking an enrolment key needs FULL scope, like the trigger secret', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'devices.js'), 'utf8');

  for (const verb of ['post', 'delete']) {
    const re = new RegExp(`router\\.${verb}\\('/:id/enrol-key',\\s*requireScope\\('full'\\)`);
    assert.match(src, re,
      `${verb.toUpperCase()} /:id/enrol-key is not gated to full scope — a write token can mint an ` +
      'impersonation credential, which is what the 2.0.3 read fix exists to prevent');
  }

  // The trigger secret is the precedent this follows; if that regresses, so does the reasoning.
  assert.match(src, /router\.post\('\/:id\/trigger-secret', requireScope\('full'\)/,
    'the precedent for this rule has moved — re-check both');
});

/*
 * ⚠️ AND A BROADCAST IS A LIST, NOT A DETAIL VIEW. dashboard:device-added goes to the whole
 * workspace room — every member with a tab open, whatever their role — so it has to be sanitised
 * like a list. It was sent as a raw row with only device_token removed, which meant the settings
 * PIN, the trigger secret and the enrolment key were pushed unasked to every viewer-seat member the
 * moment a web-player display was created.
 */
test('the device-added broadcast is sanitised like a list, not like a detail row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const call = src.match(/'dashboard:device-added',\s*(\w+)\)/);
  assert.ok(call, 'could not find the device-added broadcast');
  assert.notEqual(call[1], 'created',
    'the raw row is broadcast to the whole workspace — it still carries the enrolment key');
  assert.match(src, /stripDeviceSecretsForList\(\{ \.\.\.created \}\)/,
    'the broadcast payload must go through the LIST sanitiser');
});
