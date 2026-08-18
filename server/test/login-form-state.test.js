'use strict';

// THE BUG: on a fresh install with no users, typing an email address made the password field
// disappear.
//
// The login form is identifier-first for normal sign-in: it asks the server which identity provider
// an address uses before offering a credential, so an SSO-only user is never shown a password box
// that will be refused. First-run setup set `identified = true` up front so both fields were
// available - there is nobody to identify, the operator is creating the first account - and then the
// "editing the address returns to the identifier step" listener fired on the first keystroke, set it
// back to false, and hid the password field mid-typing. The same re-render relabelled the button
// from "Create admin account" to "Next".
//
// The decision now lives in frontend/js/lib/login-form-state.js as a pure function so the whole
// truth table can be pinned, including the state the old code could not represent: setup mode where
// `identified` has been clobbered.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'lib', 'login-form-state.js')).href;

let loginFormState;
test('load the module', async () => {
  ({ loginFormState } = await import(MOD));
  assert.equal(typeof loginFormState, 'function');
});

test('THE BUG: during setup the password survives a keystroke in the email box', async () => {
  ({ loginFormState } = await import(MOD));
  // identified:false is exactly what the input listener used to leave behind. Setup must not care.
  const s = loginFormState({ isSetup: true, identified: false, ssoOnlyDomain: false });
  assert.equal(s.showPassword, true, 'the password field must stay visible during first-run setup');
  assert.equal(s.buttonKey, 'auth.create_admin_account', 'and the button must not become Next');
});

test('setup shows both fields regardless of any other flag', async () => {
  ({ loginFormState } = await import(MOD));
  for (const identified of [true, false]) {
    for (const ssoOnlyDomain of [true, false]) {
      const s = loginFormState({ isSetup: true, identified, ssoOnlyDomain });
      assert.equal(s.showPassword, true,
        `setup must show the password (identified=${identified} ssoOnly=${ssoOnlyDomain})`);
      assert.equal(s.showButton, true, 'and must always offer the button');
      assert.equal(s.buttonKey, 'auth.create_admin_account');
    }
  }
});

test('normal sign-in still hides the password until an address is submitted', async () => {
  ({ loginFormState } = await import(MOD));
  const before = loginFormState({ isSetup: false, identified: false, ssoOnlyDomain: false });
  assert.equal(before.showPassword, false, 'identifier-first: no password box yet');
  assert.equal(before.buttonKey, 'auth.next');

  const after = loginFormState({ isSetup: false, identified: true, ssoOnlyDomain: false });
  assert.equal(after.showPassword, true);
  assert.equal(after.buttonKey, 'auth.sign_in');
});

test('an SSO-only domain gets neither a password box nor a submit button', async () => {
  ({ loginFormState } = await import(MOD));
  // The provider button is the only way in; offering a password that will be refused, or a submit
  // that cannot work, is worse than offering nothing.
  const s = loginFormState({ isSetup: false, identified: true, ssoOnlyDomain: true });
  assert.equal(s.showPassword, false);
  assert.equal(s.showButton, false);
});

test('the button key is always a real translation key', async () => {
  ({ loginFormState } = await import(MOD));
  // t() renders the KEY when it is undefined, so a typo here puts a bare identifier on the button.
  const fs = require('node:fs');
  const en = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'i18n', 'en.js'), 'utf8');
  const seen = new Set();
  for (const isSetup of [true, false]) {
    for (const identified of [true, false]) {
      for (const ssoOnlyDomain of [true, false]) {
        seen.add(loginFormState({ isSetup, identified, ssoOnlyDomain }).buttonKey);
      }
    }
  }
  for (const key of seen) {
    assert.ok(en.includes(`'${key}'`), `${key} is not defined in en.js`);
  }
});
