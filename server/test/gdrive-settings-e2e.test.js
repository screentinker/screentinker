'use strict';

/*
 * Google Drive in a real dashboard: an org owner pastes a service account key in Settings, the card
 * shows the address to share folders with (never the key), and the content library's cloud folders
 * panel offers Google Drive with a Drive link hint naming that address.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SKIP, waitFor, startServer, launch } = require('./helpers/web-player-e2e');

let browser, srv;
before(async () => { if (SKIP) return; browser = await launch(); srv = await startServer('gdrive-ui'); });
after(async () => { if (browser) await browser.close(); if (srv) srv.stop(); });

test('Settings → Google Drive, then the folders panel offers Google Drive', { skip: SKIP }, async () => {
  const pem = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const email = 'screens@lobby.iam.gserviceaccount.com';
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 1000 });
    await page.goto(`${srv.base}/app#/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((tok) => { localStorage.setItem('token', tok); localStorage.setItem('rd_onboarded', '1'); }, srv.token);
    await page.goto(`${srv.base}/app#/settings`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.ok(await waitFor(() => page.$eval('#gdriveCard', (el) => el.style.display !== 'none' && /Google Drive/.test(el.textContent)).catch(() => false), 20000), 'the card is shown to the org owner');
    await page.$eval('#gdriveCard [data-g="json"]', (el, v) => { el.value = v; }, JSON.stringify({ type: 'service_account', client_email: email, private_key: pem }));
    await page.click('#gdriveCard [data-g-act="save"]');
    assert.ok(await waitFor(() => page.$eval('#gdriveCard', (el) => el.textContent.includes('Share folders with')).catch(() => false), 15000), 'saved');
    const card = await page.$eval('#gdriveCard', (el) => el.textContent);
    assert.ok(card.includes(email), 'the address to share with');
    assert.ok(!card.includes('PRIVATE KEY'), 'never the key');

    // The folders panel, opened the way the library opens it.
    await page.evaluate(() => import('/js/components/m365-settings.js').then((m) => m.openCloudFolders({})));
    assert.ok(await waitFor(() => page.$('[data-cf-f="provider"]').then(Boolean), 10000), 'the add form');
    const hint = await page.$eval('[data-cf-hint]', (el) => el.textContent);
    assert.match(hint, /Google Drive/);
    assert.ok(hint.includes(email), 'tells the admin whom to share with');
    assert.equal(await page.$eval('[data-cf-f="share_url"]', (el) => el.placeholder), 'https://drive.google.com/drive/folders/…');
  } finally { await page.close(); }
});
