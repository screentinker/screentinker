'use strict';

/*
 * The EDID parser, checked against a REAL panel.
 *
 * The fixture below is assembled byte by byte to match what the XT245's own DWS reported for the
 * CX101 attached to it — manufacturer RTK, product 0x1010, serial 1, made 2020 week 26, 22x13 cm,
 * gamma 2.20, and a preferred mode whose modeline is
 *
 *   "1920x1200x62p 168.50 1920 2008 2052 2200  1200 1204 1209 1245"
 *
 * That last one matters: the DWS calls it 62p, which looks like a typo for 60 until you divide the
 * pixel clock by the totals — 168.5MHz / (2200 x 1245) = 61.5Hz. A parser that "helpfully" rounds
 * to 60 would disagree with the player's own diagnostics about the panel in front of it, which is
 * the one thing an operator would use this screen to check.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEdid } = require('../lib/edid');

function buildCx101() {
  const b = Buffer.alloc(128);
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(b, 0);

  // 'RTK' — five bits per letter, big-endian, A=1.
  b.writeUInt16BE(((18 & 0x1f) << 10) | ((20 & 0x1f) << 5) | (11 & 0x1f), 8);
  b.writeUInt16LE(0x1010, 10);          // product
  b.writeUInt32LE(1, 12);               // serial
  b[16] = 26;                           // week
  b[17] = 2020 - 1990;                  // year
  b[18] = 1; b[19] = 3;                 // EDID 1.3
  b[20] = 0x80;                         // digital
  b[21] = 22; b[22] = 13;               // cm
  b[23] = 220 - 100;                    // gamma 2.20

  // Established: 640x480@60 (0x20) + 800x600@60 (0x01) in byte 35, 1024x768@60 (0x08) in byte 36.
  b[35] = 0x20 | 0x01;
  b[36] = 0x08;

  // Standard timings. 1920x1200@60 = 16:10, and 1280x720@60 = 16:9.
  b[38] = 1920 / 8 - 31; b[39] = (0 << 6) | (60 - 60);
  b[40] = 1280 / 8 - 31; b[41] = (3 << 6) | (60 - 60);
  for (let i = 42; i <= 52; i += 2) { b[i] = 0x01; b[i + 1] = 0x01; }

  // DTD 1 — the preferred mode, from the modeline above.
  const d = b.slice(54, 72);
  d.writeUInt16LE(16850, 0);            // 168.50 MHz in 10kHz units
  const hActive = 1920, hBlank = 2200 - 1920, vActive = 1200, vBlank = 1245 - 1200;
  d[2] = hActive & 0xff;  d[3] = hBlank & 0xff;
  d[4] = ((hActive >> 8) << 4) | (hBlank >> 8);
  d[5] = vActive & 0xff;  d[6] = vBlank & 0xff;
  d[7] = ((vActive >> 8) << 4) | (vBlank >> 8);
  d[12] = 476 & 0xff; d[13] = 268 & 0xff;
  d[14] = ((476 >> 8) << 4) | (268 >> 8);
  d[17] = 0x1e;                          // digital separate, +h +v

  // Descriptor 2 — monitor name.
  b[72] = 0; b[73] = 0; b[74] = 0; b[75] = 0xfc; b[76] = 0;
  Buffer.from('CX101\n').copy(b, 77);
  for (let i = 77 + 6; i < 90; i++) b[i] = 0x20;

  b[126] = 0;                            // no extension blocks
  b[127] = (256 - (b.slice(0, 127).reduce((a, x) => (a + x) & 0xff, 0) % 256)) & 0xff;
  return b;
}

const CX101 = buildCx101();

test('the identity fields match what the player DWS reports for this panel', () => {
  const e = parseEdid(CX101);
  assert.ok(e, 'a well-formed EDID must parse');
  assert.equal(e.manufacturer, 'RTK');
  assert.equal(e.productHex, '0x1010');
  assert.equal(e.serialNumber, 1);
  assert.equal(e.weekOfManufacture, 26);
  assert.equal(e.yearOfManufacture, 2020);
  assert.equal(e.edidVersion, '1.3');
  assert.equal(e.digital, true);
  assert.equal(e.widthCm, 22);
  assert.equal(e.heightCm, 13);
  assert.equal(e.gamma, 2.2);
  assert.equal(e.monitorName, 'CX101');
  assert.equal(e.checksumValid, true);
});

test('the preferred mode is 62p, exactly as the DWS modeline computes', () => {
  // 168.5MHz / (2200 x 1245) = 61.5Hz. Rounding to a "nicer" 60 would contradict the player.
  const e = parseEdid(CX101);
  assert.equal(e.preferredMode, '1920x1200@62');
  const dtd = e.detailedTimings[0];
  assert.equal(dtd.pixelClockKhz, 168500);
  assert.equal(dtd.width, 1920);
  assert.equal(dtd.height, 1200);
  assert.equal(dtd.interlaced, false);
});

test('established and standard timing lists come back', () => {
  const e = parseEdid(CX101);
  for (const m of ['640x480@60', '800x600@60', '1024x768@60']) {
    assert.ok(e.establishedTimings.includes(m), `expected ${m} in ${e.establishedTimings}`);
  }
  const labels = e.standardTimings.map((s) => s.label);
  assert.deepEqual(labels, ['1920x1200@60', '1280x720@60'],
    'unused 0x01 0x01 slots must be skipped, not reported as modes');
});

test('a bad panel degrades to "we do not know", never to a thrown page', () => {
  // This runs on bytes a display supplied. The device page must survive a monitor that lies.
  assert.equal(parseEdid(null), null);
  assert.equal(parseEdid(Buffer.alloc(0)), null);
  assert.equal(parseEdid(Buffer.alloc(128)), null, 'all zeroes has no EDID header');
  assert.equal(parseEdid(Buffer.alloc(64, 0xff)), null, 'too short to be a base block');
  assert.equal(parseEdid('not an edid at all'), null);
});

test('a corrupt checksum is REPORTED, not rejected', () => {
  // A panel with a bad checksum still answers most questions correctly, and an installer chasing a
  // flaky cable wants to see the fields AND be told the block is suspect. Dropping it wholesale
  // would hide the very evidence they need.
  const bad = Buffer.from(CX101);
  bad[127] = (bad[127] + 1) & 0xff;
  const e = parseEdid(bad);
  assert.ok(e, 'a bad checksum must still parse');
  assert.equal(e.checksumValid, false);
  assert.equal(e.monitorName, 'CX101');
});

test('the wire formats the bridge might send all land in the same place', () => {
  // getEdid() has not been observed on hardware yet, so accept the plausible shapes rather than
  // betting on one: a Buffer, a byte array, a Uint8Array, base64, or hex.
  const expected = parseEdid(CX101);
  const shapes = {
    array: Array.from(CX101),
    uint8: new Uint8Array(CX101),
    base64: CX101.toString('base64'),
    hex: CX101.toString('hex'),
  };
  for (const [name, value] of Object.entries(shapes)) {
    const got = parseEdid(value);
    assert.ok(got, `${name} should parse`);
    assert.equal(got.monitorName, expected.monitorName, `${name} lost the monitor name`);
    assert.equal(got.productHex, expected.productHex, `${name} lost the product id`);
  }
});

test('a CEA extension contributes the colorimetry flags the DWS shows', () => {
  // "BT2020 RGB supported / BT2020 YCbCr supported" comes from the CEA colorimetry data block, not
  // the base block — which is why getEdidIdentity()'s flags and the raw bytes must agree.
  const ext = Buffer.alloc(128);
  ext[0] = 0x02; ext[1] = 3; ext[2] = 8; ext[3] = 0x00;
  ext[4] = (7 << 5) | 3;            // extended tag, length 3
  ext[5] = 0x05;                    // colorimetry data block
  ext[6] = 0x80 | 0x40;             // BT2020 RGB + YCC
  ext[7] = 0x00;
  const two = Buffer.concat([Buffer.from(CX101), ext]);
  two[126] = 1;
  two[127] = (256 - (two.slice(0, 127).reduce((a, x) => (a + x) & 0xff, 0) % 256)) & 0xff;

  const e = parseEdid(two);
  assert.equal(e.extensionBlocks, 1);
  assert.equal(e.cea.bt2020Rgb, true);
  assert.equal(e.cea.bt2020Ycc, true);
});

// ---------------------------------------------------------------------------------------------
// The path from panel to page
//
// Four hops, none of which can be executed here: the bridge reads getEdid() on a widget, the page
// sends it on register, applyHardwareIdentity stores it, the device route parses it on read. Each
// is pinned against its own source, because a break anywhere is silent — the card simply does not
// appear, which looks exactly like a panel that never reported an EDID.
// ---------------------------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('the bridge collects the RAW block, not just the identity object', () => {
  const bridge = read('brightsign', 'st-bridge.js');
  assert.match(bridge, /typeof vo\.getEdid === 'function'/,
    'getEdidIdentity() cannot answer manufacturer, gamma or the mode lists — the raw block must be read');
  assert.match(bridge, /edid: function \(\) \{ return edidRaw; \}/, 'and exposed to the page');
  assert.match(bridge, /function toBase64/, 'normalised, because the return shape is undocumented');
});

test('EDID rides the REGISTER, not the heartbeat', () => {
  // It changes when someone swaps the screen. ~350 characters of unchanging base64 every 15
  // seconds, forever, across a fleet, to say the same thing each time.
  const player = read('server', 'player', 'index.html');
  assert.match(player, /data\.bs_edid = BS\.edid\(\) \|\| null/);
  const hb = player.slice(player.indexOf('function startHeartbeat'), player.indexOf('function stopHeartbeat'));
  assert.ok(!hb.includes('bs_edid'), 'the heartbeat must not carry it');
  assert.match(player, /maybeReportEdid/, 'but a late-arriving probe must still be reported');
});

test('a device that reports no EDID does not erase the one already stored', () => {
  // The probe is async and the first register usually predates it, so nulls are NORMAL. A plain
  // assignment would blank the column on every reconnect and the card would flicker in and out.
  const sock = read('server', 'ws', 'deviceSocket.js');
  assert.match(sock, /hardware_edid\s*=\s*COALESCE\(\?, hardware_edid\)/);
});

test('the blob is stored raw and parsed on READ', () => {
  // The whole argument for server-side parsing: a new field is a server deploy, not a fleet
  // re-collection. Storing a parsed snapshot instead would freeze today's field list into the DB.
  const route = read('server', 'routes', 'devices.js');
  assert.match(route, /parseEdid\(device\.hardware_edid\)/);
  assert.match(route, /capabilities, edid,/, 'and shipped to the dashboard');
  const db = read('server', 'db', 'database.js');
  assert.match(db, /ADD COLUMN hardware_edid TEXT/, 'the migration must exist');
});

test('the card renders only when there is something to show', () => {
  const view = read('frontend', 'js', 'views', 'device-detail.js');
  assert.match(view, /\$\{device\.edid \? `/, 'no EDID must mean no card, not an empty one');
  for (const k of ['device.info.edid', 'device.info.edid_preferred', 'device.info.edid_made']) {
    assert.ok(view.includes(k), `${k} must be rendered`);
    assert.ok(read('frontend', 'js', 'i18n', 'en.js').includes(`'${k}'`), `${k} must be defined in en.js`);
  }
});
