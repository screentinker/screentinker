'use strict';
const puppeteer = require('puppeteer-core');
const http = require('http');
let Server; try { Server = require('../../server/node_modules/socket.io'); } catch (e) { console.log('skipped: socket.io unavailable (npm install in server/)'); process.exit(0); }
const path = require('path');
(async () => {
  const server = http.createServer();
  const io = new Server(server, { cors: { origin: true, credentials: true } });
  let registered = false;
  io.of('/device').on('connection', socket => socket.on('device:register', data => {
    registered = !!data.pairing_code;
    socket.emit('device:registered', { device_id: 'test-device', device_token: 'test-token', status: 'provisioning' });
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument(port => {
      delete window.Promise;
      delete window.fetch;
      delete window.URLSearchParams;
      delete NodeList.prototype.forEach;
      delete HTMLCollection.prototype.forEach;
      delete Element.prototype.remove;
      try { localStorage.setItem('rd_web_player', JSON.stringify({ serverUrl: 'http://127.0.0.1:' + port })); } catch (ignore) {}
      window.FileSystem = function () { this.createCommonDir = function () {}; this.openCommonFile = function () { throw Error('missing'); }; this.closeCommonFile = function () {}; };
      window.Common = { API: { Widget: function () { this.sendReadyEvent = function () {}; } } };
      Object.defineProperty(HTMLObjectElement.prototype, 'StartDownFile', { value() {} });
    }, port);
    await page.goto('file://' + path.resolve(__dirname, '../dist/index.html'), { waitUntil: 'load' });
    await new Promise((resolve, reject) => { const until = Date.now() + 10000; const check = () => registered ? resolve() : Date.now() >= until ? reject(Error('automatic registration did not arrive; page errors: ' + JSON.stringify(errors))) : setTimeout(check, 100); check(); });
    if (errors.length) throw Error('Page errors: ' + JSON.stringify(errors));
    console.log('Automatic connection and pairing registration succeeded against a local Socket.IO server.');
  } finally { await browser.close(); io.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
