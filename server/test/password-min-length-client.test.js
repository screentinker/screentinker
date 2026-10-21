'use strict';

// The Create Account form said "At least 6 characters" and let a 6- or 7-character password
// through its own check, and the server then refused it ("Password must be at least 8
// characters"). The client and the server must ask for the same minimum, in every language.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { MIN_PASSWORD_LENGTH } = require('../lib/passwordReset');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');
const LOGIN = fs.readFileSync(path.join(FRONTEND, 'views', 'login.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

test('the server registration minimum is the shared one', () => {
  assert.equal(MIN_PASSWORD_LENGTH, 8);
  assert.match(AUTH, /if \(password\.length < 8\) return res\.status\(400\)/);
});

test('the sign-up form checks the same minimum as the server', () => {
  const m = LOGIN.match(/function doRegister[\s\S]*?if \(password\.length < (\d+)\)/);
  assert.ok(m, 'doRegister has a client-side length check');
  assert.equal(Number(m[1]), MIN_PASSWORD_LENGTH);
  assert.doesNotMatch(LOGIN, /error_password_min_6/);
});

test('every locale that words the hint or the error says the server minimum', () => {
  const dir = path.join(FRONTEND, 'i18n');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /'auth\.error_password_min_6'/, `${f} still has the old key`);
    for (const key of ['auth.placeholder_register_password', 'auth.error_password_min_8']) {
      const m = src.match(new RegExp(`'${key.replace(/\./g, '\\.')}'\\s*:\\s*(['"])(.*?)\\1`));
      if (!m) continue; // a skeleton locale falls back to English
      assert.ok(m[2].includes(String(MIN_PASSWORD_LENGTH)), `${f} ${key}: "${m[2]}"`);
      assert.doesNotMatch(m[2], /6/, `${f} ${key}: "${m[2]}"`);
    }
  }
  assert.match(fs.readFileSync(path.join(dir, 'en.js'), 'utf8'), /'auth\.error_password_min_8'/);
});
