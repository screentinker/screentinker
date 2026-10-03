/*
 * Bring a small fake fleet genuinely ONLINE on the capture instance.
 *
 * "Online" is a live socket, not a column — the Pi video learned this the hard way — so each
 * device here is a real socket.io client that registers and then heartbeats, as a player does.
 *
 * ⚠️ CREDENTIALS ARE CACHED IN fleet.json AND REUSED.
 *    Registering with a fresh pairing_code mints a NEW device row every time. A run that forgot
 *    this left the instance with 15 devices instead of 5, and the extra ten were unpairable
 *    strays. On a second run we re-register with the stored device_id/device_token instead, so
 *    the same five screens come back online. Delete fleet.json when the DB is wiped.
 *
 * ⚠️ ALL FIVE ARE INVENTED. Talks only to :3011 (DATA_DIR=~/screentinker-video-2p2/instance).
 */
const ioClient = require('/home/owner/Downloads/remote_display/server/node_modules/socket.io-client');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3011';
const CREDS = path.join(__dirname, 'fleet.json');
const FLEET = [
  { name: 'Main Lobby',        loc: 'Reception · Level 1' },
  { name: 'Ward B Day Room',   loc: 'Ward B · Level 3' },
  { name: 'Cafeteria Menu',    loc: 'Cafeteria · Level 1' },
  { name: 'Radiology Waiting', loc: 'Radiology · Level 2' },
  { name: 'Staff Room',        loc: 'Staff · Level 4' },
];

let saved = {};
try { saved = JSON.parse(fs.readFileSync(CREDS, 'utf8')); } catch { saved = {}; }
const reused = Object.keys(saved).length > 0;
console.log(reused ? `reusing credentials for ${Object.keys(saved).length} devices`
                   : 'no fleet.json — provisioning fresh devices');

/*
 * ⚠️ ONE SCREEN IS DELIBERATELY LEFT OFFLINE. The video's opening shot asks an assistant which
 * screens are offline, and with a fully online fleet the honest answer is "none" - which is a
 * worse hook AND a worse demonstration. OFFLINE=<name> skips that device's socket, so the row
 * genuinely reads offline and the answer on screen is the instance's own, not a caption.
 */
const OFFLINE = (process.env.OFFLINE || '').split(',').map((s) => s.trim()).filter(Boolean);
// The readiness line has to count what we actually DIAL, not the whole fleet, or skipping a screen
// means it never prints and rebuild.sh sits in its wait loop for the full timeout.
const TARGET = FLEET.filter((d) => !OFFLINE.includes(d.name)).length;

const sockets = [];
let ready = 0;

FLEET.forEach((d, i) => {
  if (OFFLINE.includes(d.name)) { console.log(`  skipping ${d.name} - left OFFLINE on purpose`); return; }
  const sock = ioClient(`${BASE}/device`, { transports: ['websocket'], reconnection: true, forceNew: true });
  sockets.push(sock);

  sock.on('connect', () => {
    const have = saved[d.name];
    const payload = {
      device_info: {
        name: d.name, location: d.loc, platform: 'linux',
        user_agent: 'ScreenTinker Player/2.0.0 (capture)',
        screen: { width: 1920, height: 1080 },
      },
    };
    if (have) { payload.device_id = have.device_id; payload.device_token = have.device_token; }
    else      { payload.pairing_code = String(crypto.randomInt(100000, 1000000)); }
    sock.emit('device:register', payload);
  });

  sock.on('device:registered', (info) => {
    ready++;
    saved[d.name] = { device_id: info.device_id, device_token: info.device_token };
    console.log(`  online: ${d.name.padEnd(20)} id=${String(info.device_id).slice(0, 8)}`);
    setInterval(() => {
      sock.emit('device:heartbeat', {
        device_id: info.device_id,
        device_token: info.device_token,
        telemetry: {
          uptime_sec: 3600 + i * 900,
          free_mem_mb: 512 + i * 37,
          cpu_pct: 6 + i,
        },
      });
    }, 9000);
    if (ready === TARGET) {
      try { fs.writeFileSync(CREDS, JSON.stringify(saved, null, 2)); } catch { /* */ }
      console.log(`\n${ready}/${FLEET.length} devices online — holding sockets open.`);
    }
  });

  sock.on('connect_error', (e) => console.log(`  !! ${d.name}: ${e.message}`));
});

const bye = () => { sockets.forEach((s) => { try { s.close(); } catch { /* */ } }); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
