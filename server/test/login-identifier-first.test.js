'use strict';

/*
 * Identifier-first login (#258).
 *
 * The password box does not exist until an address has been submitted. That is what lets the
 * organization lookup happen BEFORE a credential is offered, so someone whose company requires its
 * own identity provider is never shown a password box that is going to be refused.
 *
 * Verified in a real browser as well (password hidden -> submit -> visible + focused -> edit the
 * address -> hidden again); these assertions stop the wiring being removed silently.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOGIN = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'login.js'), 'utf8');
// The visibility decision itself now lives in a pure module - see login-form-state.test.js for its
// truth table. It moved because computing it inline from two mutable flags let a keystroke undo
// first-run setup. These assertions follow it there rather than pinning it to its old address.
const STATE = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'login-form-state.js'), 'utf8');

test('password visibility depends on BOTH identification and SSO-only', () => {
  assert.match(STATE, /identified && !ssoOnlyDomain/,
    'the two drivers must be combined in one place so they cannot disagree');
  assert.match(LOGIN, /loginFormState\(\{ isSetup, identified, ssoOnlyDomain \}\)/,
    'the view must take its state from that one place rather than recomputing it');
});

test('the primary button advances before it signs in', () => {
  assert.match(LOGIN, /if \(identified && !ssoOnlyDomain\) return doLogin\(\);\s*\n\s*identify\(\);/,
    'the button must identify first and only sign in once an address is known');
  assert.match(STATE, /'auth\.sign_in'[\s\S]{0,80}'auth\.next'/,
    'the label must still advance through Next before offering Sign in');
});

test('editing the address returns to the identifier step', () => {
  assert.match(LOGIN, /if \(!identified\) return;\s*\n\s*identified = false;/,
    'a corrected address must get a fresh answer, not the previous domain\'s');
});

test('the per-keystroke lookup is gone', () => {
  assert.doesNotMatch(LOGIN, /ssoLookupTimer/,
    'the debounced lookup answered for half-typed domains and burned a 10/min budget');
  assert.match(LOGIN, /async function identify\(\)[\s\S]{0,400}await lookupOrgSso\(email\)/,
    'the lookup now runs on submit');
});

test('instance-wide providers are never hidden', () => {
  // Deliberate: they are the operator's, offered to everyone, and the server refuses them for an
  // SSO-only organization anyway. Hiding them made the page change shape while typing.
  assert.doesNotMatch(LOGIN, /getElementById\('instanceProviders'\)[\s\S]{0,120}style\.display/,
    'nothing may hide #instanceProviders');
});

test('first-run setup skips identifier-first', () => {
  assert.match(LOGIN, /if \(isSetup\) identified = true;/,
    'creating the first admin needs both fields at once');
});

test('the initial state is applied after its declarations (temporal dead zone)', () => {
  const decl = LOGIN.indexOf('let identified = false;');
  const call = LOGIN.lastIndexOf('\n  applyFormState();');
  assert.ok(decl !== -1 && call !== -1, 'both the declaration and the init call must exist');
  assert.ok(call > decl,
    'applyFormState() must be called AFTER the let declarations — earlier throws on the TDZ, which '
    + 'on this page means a login form that never renders');
});
