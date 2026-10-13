#!/usr/bin/env node
'use strict';
/*
 * Run the WHOLE Roku app (SceneGraph, Task threads and all) in brs-node against a real server.
 *
 *   node roku/tests/run-app.js [--seconds 90]
 *
 * Starts this checkout's server (or SERVER_DIR) with a throwaway DATA_DIR, packages roku/, launches
 * it with the deep link server=<local>, pairs the code it shows through the dashboard API, gives the
 * display an image, a short generated video and a clock widget, and reads the player's "[st]" console
 * lines to check it showed each of them and reported plays.
 *
 * ⚠️ brs-node is a simulator. It runs the BrightScript and the SceneGraph node tree faithfully enough
 * to catch crashes, wrong field types and protocol mistakes; it does not decode video. The video item
 * is expected to be ASKED FOR and then moved past by the player's watchdog — proving the request and
 * the watchdog, not that a Roku plays the file.
 *
 * The simulator reports Autoplay as OFF, so this also runs Roku's autoplay policy: the player must
 * wait with nothing playing, and start when OK (Select) is pressed — sent here over the simulator's
 * ECP port, as a remote would.
 *
 * --drop-first-register puts a proxy between the app and the server that delivers the first
 * device:register POST to the server and then drops the connection. That is the CI "flake" of
 * 2026-10-12/13: the server creates the unclaimed row, the app's 15 s post timeout rebuilds the
 * session, and the re-register is ADOPTED by the server (same pairing code + fingerprint) with
 * status 'online' and deliberately no device:paired. The app must still show its pairing code.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { start, packageApp, REPO } = require('./lib/st-server');

const ROKU = path.join(REPO, 'roku');
const BRS_CLI = process.env.BRS_CLI || path.join(ROKU, 'node_modules/brs-node/bin/brs.cli.js');
const ECP_PORT = 8060;
const SECONDS = Number((process.argv.find((a, i) => process.argv[i - 1] === '--seconds')) || 90);
const DROP_FIRST_REGISTER = process.argv.includes('--drop-first-register');

/**
 * Forward everything to `target`, except the first POST carrying device:register: deliver that one
 * (the server must act on it) and swallow the reply, so the app sees a POST that never completes.
 */
function dropFirstRegisterProxy(target) {
  const up = new URL(target);
  let dropped = false;
  const held = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const swallow = !dropped && req.method === 'POST' && body.includes('device:register');
      const fwd = http.request({ host: up.hostname, port: up.port, method: req.method, path: req.url,
        headers: { ...req.headers, host: up.host } }, (r) => {
        // The server has acted on it; the app gets a dropped connection instead of the reply.
        // (Dropped, not held: brs-node's roUrlTransfer blocks the whole task on a reply that never
        // comes, where a real Roku's async transfer would let the app's 15 s post timeout fire.)
        if (swallow) { r.resume(); r.on('end', () => setTimeout(() => res.socket && res.socket.destroy(), 500)); return; }
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      fwd.on('error', () => { if (!swallow) { res.writeHead(502); res.end(); } });
      fwd.end(body);
      if (swallow) {
        dropped = true;
        held.push(res);
        console.log('  test> delivered the first device:register to the server and dropped the reply');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    wasDropped: () => dropped,
    close: () => { for (const r of held) r.destroy(); server.close(); },
  })));
}

(async () => {
  let exitCode = 0;
  const fail = (m) => { console.log('FAIL ' + m); exitCode = 1; };
  const seen = [];
  let srv = null;
  let brs = null;
  let proxy = null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'st-roku-app-'));
  try {
    srv = await start();
    await srv.admin();
    const img = await srv.upload(path.join(REPO, 'frontend/assets/icon-512.png'), 'image/png');
    const vid = await srv.upload(srv.testVideo(4), 'video/mp4');
    const clock = await srv.widget('clock', 'Lobby clock', { timezone: 'America/Chicago' });
    // a widget the Roku cannot draw itself: shown as a server-rendered frame
    const note = await srv.widget('text', 'Welcome note', { html: '<h1 style="color:#fff;font:700 96px sans-serif;text-align:center;margin-top:40vh">Welcome to the lobby</h1>' });
    console.log(`content: image ${img.id}, video ${vid.id}, clock widget ${clock.id}`);

    const zip = packageApp(work);
    if (DROP_FIRST_REGISTER) proxy = await dropFirstRegisterProxy(srv.base);
    const appServer = proxy ? proxy.base : srv.base;
    brs = spawn(process.execPath, [BRS_CLI, '-c', '0', '-g', 'warning', '-e', '-k', `server=${appServer}`, zip], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let deviceId = null;
    let pairing = false;
    let pressedAt = -1;
    let buf = '';
    const onData = async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (/^\[st\]|BRIGHTSCRIPT: ERROR|Runtime Error/.test(line)) console.log('  roku> ' + line);
        seen.push(line);
        if (pressedAt < 0 && /\[st\] autoplay: off on this Roku, waiting for OK/.test(line)) {
          pressedAt = seen.length;
          // a viewer takes a moment; it also proves nothing started in the meantime
          setTimeout(() => {
            fetch(`http://127.0.0.1:${ECP_PORT}/keypress/Select`, { method: 'POST' })
              .then((r) => console.log(`  test> pressed OK over ECP (${r.status})`))
              .catch((e) => fail('ECP keypress: ' + e.message));
          }, 3000);
        }
        const m = line.match(/\[st\] pairing: code (\d{6})/);
        if (m && !pairing) {
          pairing = true;
          try {
            deviceId = await srv.pairAndAssign(m[1], [{ content_id: img.id, duration_sec: 6 }, { content_id: vid.id }, { widget_id: clock.id, duration_sec: 8 }, { widget_id: note.id, duration_sec: 8 }]);
            console.log(`  test> paired ${deviceId}; assigned and published image, video, clock`);
          } catch (e) { fail('pair/assign: ' + e.message); }
        }
      }
    };
    brs.stdout.on('data', onData);
    brs.stderr.on('data', onData);
    await new Promise((r) => setTimeout(r, SECONDS * 1000));

    const has = (re) => seen.some((l) => re.test(l));
    if (proxy && !proxy.wasDropped()) fail('--drop-first-register: no device:register POST was ever seen to drop');
    if (proxy && !has(/session closed: post (timeout|rejected)/)) fail('--drop-first-register: the app never gave up on the dropped POST');
    if (!has(/\[st\] pairing: code \d{6}/)) fail('the app never showed a pairing code');
    if (!has(/\[st\] payload: items=4/)) fail('the app never received the 4-item playlist');
    if (!has(/\[st\] launch: complete/)) fail('the AppLaunchComplete beacon was never signalled');
    if (pressedAt < 0) fail('with Autoplay off the player never waited for OK');
    else {
      const started = seen.findIndex((l) => /\[st\] autoplay: started by the viewer/.test(l));
      if (started < 0) fail('OK did not start playback');
      const early = seen.slice(0, started < 0 ? seen.length : started).filter((l) => /\[st\] play: play_start|show (image|video|raster) /.test(l));
      if (early.length) fail('something played before OK was pressed: ' + early[0]);
    }
    if (!has(/show image icon-512/)) fail('the image was never started');
    if (!has(/on screen .*\/uploads\/content\//)) fail('the image never reached the screen');
    if (!has(/show video /)) fail('the video was never started');
    if (!has(/native clock /)) fail('the clock widget was not drawn natively');
    if (!has(/show raster Welcome note/)) fail('the text widget was never started');
    if (!has(/\[st\] play: play_start/)) fail('no play_start was reported');
    if (process.env.EXPECT_RASTER && !has(/on screen tmp:\/st\//)) fail('no server-rendered frame reached the screen');
    if (process.env.EXPECT_TZ && !has(/payload: items=4 tz=America\/Chicago\/\d+/)) fail('the payload carried no tz_table');
    const crashes = seen.filter((l) => /BRIGHTSCRIPT: ERROR|Runtime Error/i.test(l));
    if (crashes.length) { fail('BrightScript errors:'); for (const c of crashes.slice(0, 10)) console.log('   ' + c); }
    // A playlist push must not restart playback from item one (#234).
    // Rebuilds are counted per payload (keyed by the payload line before each rebuild): one payload
    // must rebuild the stage at most once. Two DIFFERENT payloads may each rebuild it, as when an
    // adopted re-register (--drop-first-register) gets an empty playlist before the paired one.
    const rebuildsPer = new Map();
    let lastPayload = '';
    for (const l of seen) {
      const pm = l.match(/\[st\] payload: (items=.*)$/);
      if (pm) lastPayload = pm[1];
      else if (/structure changed, rebuilding/.test(l)) rebuildsPer.set(lastPayload, (rebuildsPer.get(lastPayload) || 0) + 1);
    }
    for (const [payload, n] of rebuildsPer) if (n > 1) fail(`the stage was rebuilt ${n} times for one structure (${payload})`);

    if (deviceId) {
      // Online at SOME point in the next 15 s, not at this one instant: a run can end in the gap of a
      // session rebuild (the simulator's own stalls), and "offline for 3 s while reconnecting" is not
      // the regression this check is for.
      let d = await srv.device(deviceId);
      for (let i = 0; i < 15 && (!d || d.status !== 'online'); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        d = await srv.device(deviceId);
      }
      console.log(`  server> status=${d && d.status} platform=${d && d.platform} client_type=${d && d.client_type} family=${d && d.platform_family}`);
      if (!d || d.status !== 'online') fail('the display is not online on the server');
      if (process.env.EXPECT_FAMILY && d.platform_family !== 'roku') fail(`platform_family is ${d.platform_family}, expected roku`);
    }
    // ⚠️ ON FAILURE, SHOW THE SERVER'S SIDE TOO. Twice on 2026-10-12 the app logged only "session
    // closed: server closed ()" and never got back in, and nothing said why the server closed it:
    // this harness printed the server log only when the server failed to start.
    // RUN_APP_SERVER_LOG=1 prints it on a passing run as well, for debugging the socket.
    if ((exitCode || process.env.RUN_APP_SERVER_LOG) && srv && typeof srv.log === 'function') {
      const lines = String(srv.log()).split('\n');
      const relevant = lines.filter((l) => /socket|device|disconnect|reconnect|refus|throttl|quarantin|flap|reject|error|warn|pair|regist/i.test(l));
      console.log(`  --- server log on failure: ${relevant.length} relevant of ${lines.length} lines (last 60), then the final 20 ---`);
      for (const l of relevant.slice(-60)) console.log('  server> ' + l.slice(0, 240));
      console.log('  --- final 20 server lines ---');
      for (const l of lines.slice(-20)) console.log('  server> ' + l.slice(0, 240));
    }
    console.log(exitCode ? 'app run: FAILED' : 'app run: passed');
  } catch (e) {
    fail(e.stack || e.message);
    if (srv) console.log(srv.log().slice(-2000));
  } finally {
    if (brs) brs.kill('SIGKILL');
    if (proxy) proxy.close();
    if (srv) await srv.stop();
    fs.rmSync(work, { recursive: true, force: true });
    process.exit(exitCode);
  }
})();
