'use strict';
const assert = require('assert/strict');
const path = require('path');
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.FileSystem = function () { throw new Error('filesystem unavailable'); };
      window.Common = { API: { Widget: function () { this.sendReadyEvent = function () { window.__launcherReady = true; }; } } };
    });
    await page.setRequestInterception(true);
    page.on('request', req => /^https?:/.test(req.url()) ? req.abort() : req.continue());
    await page.goto('file://' + path.resolve(__dirname, '../dist/index.html'), { waitUntil: 'load' });
    const state = await page.evaluate(() => ({ ready: window.__launcherReady, nativeReady: window.__STNative.ready, error: window.__STNative.error }));
    assert.equal(state.ready, true, 'launcher must receive the ready signal even when native initialization fails');
    assert.notEqual(state.nativeReady, true);
    assert.match(state.error, /filesystem unavailable/);
    console.log('Launcher ready signal survives native filesystem initialization failure.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
