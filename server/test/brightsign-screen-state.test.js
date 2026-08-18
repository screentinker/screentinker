'use strict';

// What a BrightSign shows: the server's own diagnostics, or the player.
//
// The box is both server and player, so the screen has to be one or the other at any moment, and
// the interesting part is the transitions:
//
//   - a fresh install has nothing to play and nobody to play it for, so it must show the address
//     where the first account gets created. There is no keyboard on a player; hiding that address
//     leaves the device unsetuppable.
//   - once an account exists it should get out of the way and be a screen.
//   - if the server later fails, the diagnostics must come BACK, or a black display is the only
//     symptom of a server that died overnight.
//
// That last requirement is why the player is an iframe layer rather than a navigation: navigating
// would replace the document and kill the poller that notices the failure.
//
// The decision lives in node-server.html, which ships in autorun.zip and cannot be imported. It is
// written as one pure function so the table below can pin it; the test lifts that function out of
// the page rather than restating it, so a change to the page is a change to what is tested.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'brightsign', 'server', 'node-server.html'), 'utf8');

function loadScreenState() {
  const at = PAGE.indexOf('function screenState(');
  assert.notEqual(at, -1, 'screenState() not found in node-server.html');
  const open = PAGE.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < PAGE.length; i++) {
    if (PAGE[i] === '{') depth++;
    else if (PAGE[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, 'unbalanced screenState()');
  // eslint-disable-next-line no-new-func
  return new Function(`${PAGE.slice(at, end + 1)}; return screenState;`)();
}

const screenState = loadScreenState();

const frame = (over) => Object.assign(
  { serving: true, fatal: null, needsSetup: false, port: '8181' }, over);

test('a healthy server with an account shows the player', () => {
  assert.equal(screenState(frame()), 'player');
});

test('a healthy server with NO account shows setup, not a blank player', () => {
  // The whole point of requirement 1: stay on the config screen until someone has signed up.
  assert.equal(screenState(frame({ needsSetup: true })), 'setup');
});

test('an unanswered setup probe is not treated as "no setup needed"', () => {
  // null means we have not been told yet. Guessing "false" here would flip a fresh box to a player
  // that has nothing to show, and take the sign-up address off the screen while doing it.
  assert.equal(screenState(frame({ needsSetup: null })), 'diagnostics');
  assert.equal(screenState(frame({ needsSetup: undefined })), 'diagnostics');
});

test('nothing listening means diagnostics, whatever else is true', () => {
  assert.equal(screenState(frame({ serving: false })), 'diagnostics');
  assert.equal(screenState(frame({ serving: false, needsSetup: false })), 'diagnostics');
});

test('THE RECOVERY CASE: a server that fails takes the player off the screen', () => {
  // Requirement 2. A box that has been playing for weeks and then throws must show the operator
  // something other than black.
  const playing = frame();
  assert.equal(screenState(playing), 'player');

  const broken = frame({ fatal: 'server failed to start TypeError: ...' });
  assert.equal(screenState(broken), 'diagnostics', 'a fatal must reveal the diagnostics again');

  const gone = frame({ serving: false });
  assert.equal(screenState(gone), 'diagnostics', 'so must the port going away');
});

test('no status at all is diagnostics rather than a crash', () => {
  // The first paint happens before the first poll answers.
  assert.equal(screenState(null), 'diagnostics');
  assert.equal(screenState(undefined), 'diagnostics');
});

test('the page reloads the player when it comes back, rather than leaving an error page', () => {
  // Not expressible in the pure function - assert the wiring instead. A player that rendered a
  // connection error while the server was down will sit on it forever unless the src is re-set.
  assert.match(PAGE, /if \(!playerShown\)[\s\S]{0,220}frame\.src =/,
    'entering the player state must (re)assign the iframe src');
  assert.match(PAGE, /frame\.removeAttribute\('src'\)/,
    'leaving it must blank the frame so a dead server is not hammered behind an invisible layer');
});

test('the player is a layer, never a navigation', () => {
  // location.href = player would replace this document and kill the poller that implements
  // requirement 2. This is the assertion that stops someone "simplifying" it back.
  assert.doesNotMatch(PAGE, /location\.href\s*=/,
    'navigating away would destroy the only thing able to notice the server failing');
});
