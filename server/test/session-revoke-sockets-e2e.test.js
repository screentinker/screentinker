'use strict';

/*
 * A password change ends the OTHER sessions' live dashboards at once, and keeps the tab that made it.
 *
 * Reported (2026-11-02): "changing the password leaves other browsers signed in". Since 3.0 a new
 * password bumps token_version, so every older session's next HTTP request is refused. But an open
 * dashboard keeps one Socket.IO connection and makes no request: it kept receiving live device events
 * until it happened to reconnect. bumpTokenVersion now closes those sockets (ws/dashboardSocket.js
 * endRevokedUserSockets), the closed tab checks its login and goes to sign-in, and the tab that made
 * the change reconnects with the fresh token it was handed (frontend/js/socket.js, api.js keepSession).
 *
 * Skips cleanly when there is no Chrome or no puppeteer-core, like the other browser suites.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

const OLD_PW = 'Passw0rd123';
const NEW_PW = 'N3w-passw0rd-456';

let srv, browser;

before(async () => {
  if (SKIP) return;
  srv = await startServer('session-revoke-sockets');
  browser = await launch();
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  if (srv) srv.stop();
});

async function openDashboard(token) {
  const ctx = await browser.createBrowserContext();   // its own localStorage: another browser
  const page = await ctx.newPage();
  await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, token);
  await page.goto(`${srv.base}/app#/`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return page;
}
const isConnected = (page) => page.evaluate(() => {
  const el = document.getElementById('connectionStatus');
  return !!el && /connected/i.test(el.textContent) && !/disconnected/i.test(el.textContent);
}).catch(() => false);
const isAtLogin = (page) => page.evaluate(() => location.hash.startsWith('#/login') && !localStorage.getItem('token')).catch(() => false);

test('changing the password closes the other browser at once and keeps this one', { skip: SKIP, timeout: 120000 }, async () => {
  const me = await srv.api('GET', '/auth/me');
  const email = me.email || (me.user && me.user.email);
  assert.ok(email, 'the account email');
  // A second, separate login: the browser that will change the password.
  const login = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: OLD_PW }) }).then((r) => r.json());
  assert.ok(login.token, 'second login: ' + JSON.stringify(login));

  const other = await openDashboard(srv.token);   // "Browser B", e.g. the attacker's
  const mine = await openDashboard(login.token);  // "Browser A"
  assert.ok(await waitFor(() => isConnected(other), 20000), 'browser B connects');
  assert.ok(await waitFor(() => isConnected(mine), 20000), 'browser A connects');

  // Browser A changes the password through the app's own API helper (keepSession stores the new token).
  const changed = await mine.evaluate(async (cur, next) => {
    const { api } = await import('/js/api.js');
    const r = await api.updateMe({ current_password: cur, password: next });
    return { ok: !!(r && r.token), stored: localStorage.getItem('token') === r.token };
  }, OLD_PW, NEW_PW);
  assert.deepEqual(changed, { ok: true, stored: true }, 'the change returns and stores a fresh token');

  // B: no network blip, no click. Its socket is closed and the page goes to sign-in on its own.
  assert.ok(await waitFor(() => isAtLogin(other), 20000), 'browser B was signed out without making a request');

  // A: still signed in, and back on a live connection with the fresh token.
  await new Promise((res) => setTimeout(res, 4000));
  assert.equal(await isAtLogin(mine), false, 'browser A stays signed in');
  assert.ok(await waitFor(() => isConnected(mine), 20000), 'browser A is live again');

  // And the old session is dead on the HTTP side too.
  const old = await fetch(srv.base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + srv.token } });
  assert.equal(old.status, 401, 'the old token is refused');
});
