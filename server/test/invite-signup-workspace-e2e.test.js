'use strict';

/*
 * Opening an invite link while signed out, then signing in OR creating an account, lands in the
 * INVITED workspace, with no first-run guide.
 *
 * Found while filming the user guides on a cloud server (every signup gets its own org/workspace):
 * a new account accepted the invite but booted in its own empty "Default" workspace and in the
 * setup guide. login.js onAuthSuccess() set `location.hash = '#/'` before reloading; the hashchange
 * ran route() in the page that was being replaced, which accepted the stashed invite and was torn
 * down mid switch-workspace. Signing in had the same race; opening the link while ALREADY signed
 * in (no reload) was fine, which is why it went unnoticed.
 *
 * Both paths, in cloud and self-hosted mode. Skips cleanly when there is no Chrome or no
 * puppeteer-core, like the other browser suites.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

const servers = {};
let browser;

before(async () => {
  if (SKIP) return;
  // Cloud: AUTO_CREATE_ORG_ON_SIGNUP defaults on, so the invitee's own signup makes a workspace.
  servers.cloud = await startServer('invite-cloud', { SELF_HOSTED: 'false' });
  servers.selfhosted = await startServer('invite-selfhosted');
  browser = await launch();
});
after(async () => {
  try { if (browser) await browser.close(); } catch { /* */ }
  for (const s of Object.values(servers)) s.stop();
});

async function json(srv, method, p, token, body) {
  const r = await fetch(srv.base + '/api' + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

async function run(mode, path) {
  const srv = servers[mode];
  const me = await srv.api('GET', '/auth/me');
  const wsId = me.current_workspace_id;
  assert.ok(wsId, 'the inviter has a workspace');
  const email = `invitee-${path}-${crypto.randomBytes(3).toString('hex')}@x.test`;
  const password = 'Passw0rd123';
  if (path === 'existing') {
    const reg = await json(srv, 'POST', '/auth/register', null, { email, password });
    assert.ok(reg.token, 'the existing account was made: ' + JSON.stringify(reg));
  }
  const inv = await srv.api('POST', `/workspaces/${wsId}/invites`, { email, role: 'workspace_editor' });

  const ctx = await browser.createBrowserContext();
  try {
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/app#/accept-invite/${inv.id}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#loginBtn', { timeout: 20000 });
    if (path === 'new') {
      await page.evaluate((e, pw) => {
        document.getElementById('showRegisterBtn').click();
        document.getElementById('regEmail').value = e;
        document.getElementById('regPassword').value = pw;
        document.getElementById('registerBtn').click();
      }, email, password);
    } else {
      await page.evaluate((e, pw) => {
        document.getElementById('loginEmail').value = e;
        document.getElementById('loginPassword').value = pw;
        document.getElementById('loginBtn').click();
      }, email, password);
      // Identifier-first sign-in may want a second press once the address is recognised.
      await new Promise((r) => setTimeout(r, 1500));
      await page.evaluate(() => { const b = document.getElementById('loginBtn'); if (b && b.offsetParent) b.click(); }).catch(() => {});
    }

    // Done = the invite stash and its toast are both consumed by the reloaded page.
    const settled = await waitFor(() => page.evaluate(() => !!localStorage.getItem('token')
      && !localStorage.getItem('pending_invite') && !localStorage.getItem('pending_invite_toast')).catch(() => false), 30000);
    assert.ok(settled, 'the invite was consumed');
    await new Promise((r) => setTimeout(r, 2500));   // let the first-run check have its say

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const after = await json(srv, 'GET', '/auth/me', token);
    assert.equal(after.email, email);
    assert.equal(after.current_workspace_id, wsId, `${mode}/${path}: the session is in the invited workspace`);
    assert.ok(after.onboarded_at, `${mode}/${path}: joining through an invite is not a first run`);
    const hash = await page.evaluate(() => location.hash);
    assert.notEqual(hash, '#/onboarding', `${mode}/${path}: no setup guide`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

for (const mode of ['cloud', 'selfhosted']) {
  for (const path of ['new', 'existing']) {
    test(`${mode}: invite link, then ${path === 'new' ? 'create an account' : 'sign in'}, lands in the invited workspace`,
      { skip: SKIP, timeout: 90000 }, () => run(mode, path));
  }
}
