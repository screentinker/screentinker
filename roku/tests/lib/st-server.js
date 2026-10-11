'use strict';
/*
 * A throwaway ScreenTinker server for the Roku test harnesses: start it, make an admin, upload test
 * media, pair a code and give the display a published playlist. Shared by run-app.js and
 * screenshot-app.js so both drive the server the way the dashboard does.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');

async function start({ serverDir = process.env.SERVER_DIR || path.join(REPO, 'server'), node = process.env.NODE_FOR_SERVER || process.execPath, env = {} } = {}) {
  const port = 3500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'st-roku-srv-'));
  const proc = spawn(node, ['server.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), DATA_DIR: path.join(work, 'data'), SELF_HOSTED: 'true', NODE_ENV: 'development', JWT_SECRET: crypto.randomBytes(16).toString('hex'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { await fetch(base + '/'); up = true; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) throw new Error('server did not start:\n' + log.slice(-2000));
  const s = {
    base, work, proc, log: () => log,
    async api(p, opts = {}, token = s.token) {
      const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) };
      if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
      const r = await fetch(base + '/api' + p, { ...opts, headers });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      if (!r.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${r.status} ${text.slice(0, 300)}`);
      return body;
    },
    async admin() {
      const reg = await s.api('/auth/register', { method: 'POST', body: JSON.stringify({ email: `admin-${crypto.randomBytes(3).toString('hex')}@roku.test`, password: crypto.randomBytes(12).toString('base64url') + 'aA1!', name: 'Roku test' }) }, null);
      s.token = reg.token;
      return reg;
    },
    async upload(file, mime) {
      const fd = new FormData();
      fd.append('files', new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
      const r = await fetch(base + '/api/content', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` }, body: fd });
      const body = await r.json();
      if (!r.ok) throw new Error('upload: ' + JSON.stringify(body).slice(0, 300));
      const list = Array.isArray(body) ? body : (body.content || body.items || [body]);
      return list[0];
    },
    /** A 1280x720 test-pattern clip we generate ourselves (no third-party media). */
    testVideo(seconds = 4) {
      const f = path.join(work, 'test-pattern.mp4');
      spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=1280x720:r=30:d=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', f]);
      return f;
    },
    async widget(type, name, config) {
      return s.api('/widgets', { method: 'POST', body: JSON.stringify({ widget_type: type, name, config }) });
    },
    /** Pair a code, put `items` on the display and publish them. Returns the device id. */
    async pairAndAssign(code, items, name = 'Roku lobby', layoutId = null) {
      const r = await s.api('/provision/pair', { method: 'POST', body: JSON.stringify({ pairing_code: code, name, browser_timezone: 'America/Chicago' }) });
      let id = r.id || (r.device && r.device.id);
      if (!id) {
        const list = await s.api('/devices');
        id = (Array.isArray(list) ? list : list.devices)[0].id;
      }
      // the display's zone, as an operator sets it in the dashboard (the payload's tz_table follows it)
      await s.api(`/devices/${id}`, { method: 'PUT', body: JSON.stringify({ timezone: 'America/Chicago', ...(layoutId ? { layout_id: layoutId } : {}) }) });
      for (const it of items) await s.api(`/assignments/device/${id}`, { method: 'POST', body: JSON.stringify(it) });
      const dev = await s.api(`/devices/${id}`);
      const plId = dev.playlist_id || (dev.device && dev.device.playlist_id);
      // edits land in the draft; publishing is what puts them on screen
      await s.api(`/playlists/${plId}/publish`, { method: 'POST', body: '{}' });
      return id;
    },
    /** A layout with the given zones ([{ name, x, y, w, h }] in percent); returns it with zone ids. */
    async layout(name, zones) {
      return s.api('/layouts', { method: 'POST', body: JSON.stringify({ name, zones: zones.map((z, i) => ({ name: z.name, x_percent: z.x, y_percent: z.y, width_percent: z.w, height_percent: z.h, z_index: i, sort_order: i, background_color: z.bg || null })) }) });
    },
    async device(id) {
      const list = await s.api('/devices');
      return (Array.isArray(list) ? list : list.devices).find((x) => x.id === id);
    },
    async stop() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
  return s;
}

/** Copy the app into dir/app and zip it to dir/app.zip. */
function packageApp(dir) {
  const ROKU = path.join(REPO, 'roku');
  const app = path.join(dir, 'app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['manifest', 'source', 'components', 'images', 'assets', 'fonts']) fs.cpSync(path.join(ROKU, f), path.join(app, f), { recursive: true });
  const zip = path.join(dir, 'app.zip');
  fs.rmSync(zip, { force: true });
  const r = spawnSync('zip', ['-qr', zip, '.'], { cwd: app });
  if (r.status !== 0) throw new Error('zip failed');
  return zip;
}

module.exports = { start, packageApp, REPO };
