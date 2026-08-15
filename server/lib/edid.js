'use strict';

/*
 * Parse a raw EDID block into the facts an operator actually asks about.
 *
 * WHY THIS LIVES ON THE SERVER, not in the player.
 *
 * The player can already answer a few of these: @brightsign/videooutput exposes getEdidIdentity(),
 * which returns monitorName, product, serialNumber, weekOfManufacture, yearOfManufacture and the
 * BT2020/HDR support flags — and nothing else. Everything the player's own DWS shows beyond that
 * (manufacturer, EDID version, physical size, gamma, the VESA/standard/DTD mode lists, the CEA
 * extension) comes from parsing the raw bytes, which getEdid() hands over untouched.
 *
 * Shipping the ~128/256 raw bytes and parsing HERE means a new field is a server deploy, not a
 * fleet update. That distinction is not theoretical on this platform: st-bridge.js sits behind a
 * CDN that held it for four hours at a time, and autorun.brs only changes via an OTA package. A
 * parser on the player would make "we also want gamma" cost a firmware round trip.
 *
 * It is also the only half that can be tested. Nothing that runs on the panel can be.
 *
 * Reference: VESA E-EDID 1.3/1.4, base block = 128 bytes; CEA-861 extension blocks follow.
 */

// Established timings bitmap, byte 35-36. Byte 37 is the "manufacturer reserved" set, ignored.
const ESTABLISHED = [
  [35, 0x80, '720x400@70'], [35, 0x40, '720x400@88'], [35, 0x20, '640x480@60'],
  [35, 0x10, '640x480@67'], [35, 0x08, '640x480@72'], [35, 0x04, '640x480@75'],
  [35, 0x02, '800x600@56'], [35, 0x01, '800x600@60'],
  [36, 0x80, '800x600@72'], [36, 0x40, '800x600@75'], [36, 0x20, '832x624@75'],
  [36, 0x10, '1024x768@87i'], [36, 0x08, '1024x768@60'], [36, 0x04, '1024x768@70'],
  [36, 0x02, '1024x768@75'], [36, 0x01, '1280x1024@75'],
];

const ASPECT = ['16:10', '4:3', '5:4', '16:9'];

/* The 3-letter PNP id is five bits per letter, big-endian, 'A' == 1. */
function manufacturer(buf) {
  const v = buf.readUInt16BE(8);
  const letter = (n) => String.fromCharCode(64 + (n & 0x1f));
  return letter(v >> 10) + letter(v >> 5) + letter(v);
}

/* A Detailed Timing Descriptor, 18 bytes. Returns null for the descriptor-block forms. */
function detailedTiming(d) {
  const pixelClock = d.readUInt16LE(0) * 10;   // kHz
  if (pixelClock === 0) return null;           // 0 marks a monitor-descriptor, not a timing
  const hActive = d[2] | ((d[4] & 0xf0) << 4);
  const hBlank = d[3] | ((d[4] & 0x0f) << 8);
  const vActive = d[5] | ((d[7] & 0xf0) << 4);
  const vBlank = d[6] | ((d[7] & 0x0f) << 8);
  const hTotal = hActive + hBlank;
  const vTotal = vActive + vBlank;
  const interlaced = !!(d[17] & 0x80);
  // Rounded, because this is read by a human comparing it to what the panel claims — 59.94 and 60
  // are the same answer to "is it running at the right rate".
  const refresh = hTotal && vTotal ? Math.round((pixelClock * 1000) / (hTotal * vTotal)) : null;
  return {
    width: hActive,
    height: vActive,
    refresh,
    interlaced,
    pixelClockKhz: pixelClock,
    widthMm: d[12] | ((d[14] & 0xf0) << 4),
    heightMm: d[13] | ((d[14] & 0x0f) << 8),
    label: `${hActive}x${vActive}${interlaced ? 'i' : ''}@${refresh}`,
  };
}

/* Descriptor blocks 2-4 carry names and ranges instead of timings when the pixel clock is 0. */
function monitorDescriptor(d, out) {
  const text = () => d.slice(5, 18).toString('ascii').split('\n')[0].trim();
  switch (d[3]) {
    case 0xfc: out.monitorName = text(); break;
    case 0xff: out.serialNumberString = text(); break;
    case 0xfe: out.textString = text(); break;
    case 0xfd:
      out.rangeLimits = {
        vMinHz: d[5], vMaxHz: d[6], hMinKhz: d[7], hMaxKhz: d[8],
        maxPixelClockMhz: d[9] ? d[9] * 10 : null,
      };
      break;
    default: break;   // 0xfa extra standard timings, 0xf7..0xf9 vendor — nothing an operator reads
  }
}

/*
 * CEA-861 extension. This is where the TV modes, audio support and the HDMI vendor block live —
 * i.e. where "BT2020 supported" on the DWS comes from.
 */
function parseCea(buf, out) {
  if (buf.length < 128 || buf[0] !== 0x02) return;
  out.cea = { revision: buf[1], underscan: !!(buf[3] & 0x80), basicAudio: !!(buf[3] & 0x40),
    ycbcr444: !!(buf[3] & 0x20), ycbcr422: !!(buf[3] & 0x10), nativeFormats: buf[3] & 0x0f };
  const dtdStart = buf[2];
  if (dtdStart <= 4) return;   // 0 = no data block collection, 4 = empty
  let i = 4;
  while (i < dtdStart && i < buf.length) {
    const tag = buf[i] >> 5;
    const len = buf[i] & 0x1f;
    const body = buf.slice(i + 1, i + 1 + len);
    if (tag === 3 && body.length >= 3) {
      // Vendor-specific. 0x000C03 is the HDMI Licensing IEEE id — the HDMI VSDB.
      const oui = body[0] | (body[1] << 8) | (body[2] << 16);
      if (oui === 0x000c03) out.cea.hdmiVsdb = true;
      if (oui === 0xc45dd8) out.cea.hdmiForumVsdb = true;
    }
    if (tag === 7 && body.length >= 2 && body[0] === 0x05) {
      // Colorimetry data block: BT2020 flags live in the first payload byte.
      out.cea.bt2020Rgb = !!(body[1] & 0x80);
      out.cea.bt2020Ycc = !!(body[1] & 0x40);
      out.cea.bt2020cYcc = !!(body[1] & 0x20);
    }
    if (tag === 7 && body.length >= 2 && body[0] === 0x06) {
      // HDR static metadata: bit 2 is SMPTE ST 2084 (HDR10).
      out.cea.hdrSt2084 = !!(body[1] & 0x04);
      out.cea.hdrHlg = !!(body[1] & 0x08);
    }
    i += len + 1;
  }
  for (let d = dtdStart; d + 18 <= 127; d += 18) {
    const t = detailedTiming(buf.slice(d, d + 18));
    if (t) (out.detailedTimings = out.detailedTimings || []).push(t);
  }
}

/*
 * Parse. Returns null rather than throwing for anything unrecognisable: this runs on data a panel
 * supplied, and a malformed EDID must degrade to "we do not know" rather than take down the device
 * page that was only trying to show a label.
 */
function parseEdid(input) {
  let buf = input;
  if (typeof buf === 'string') {
    const s = buf.trim();
    buf = /^[0-9a-fA-F\s]+$/.test(s) && s.replace(/\s/g, '').length >= 256
      ? Buffer.from(s.replace(/\s/g, ''), 'hex')
      : Buffer.from(s, 'base64');
  } else if (Array.isArray(buf) || (buf && buf.buffer && !Buffer.isBuffer(buf))) {
    buf = Buffer.from(buf);   // Uint8Array or a plain array of byte values
  }
  if (!Buffer.isBuffer(buf) || buf.length < 128) return null;
  // The fixed 8-byte header is the only reliable "this is an EDID" signal.
  if (buf.readUInt32BE(0) !== 0x00ffffff || buf.readUInt32BE(4) !== 0xffffff00) return null;

  const base = buf.slice(0, 128);
  const sum = base.reduce((a, b) => (a + b) & 0xff, 0);

  const out = {
    manufacturer: manufacturer(base),
    product: base.readUInt16LE(10),
    productHex: '0x' + base.readUInt16LE(10).toString(16).padStart(4, '0'),
    serialNumber: base.readUInt32LE(12),
    weekOfManufacture: base[16],
    yearOfManufacture: base[17] + 1990,
    edidVersion: `${base[18]}.${base[19]}`,
    digital: !!(base[20] & 0x80),
    widthCm: base[21],
    heightCm: base[22],
    // Stored as (gamma*100)-100; 0xff means "defined in a descriptor instead".
    gamma: base[23] === 0xff ? null : Math.round((base[23] + 100)) / 100,
    checksumValid: sum === 0,
    extensionBlocks: base[126],
    establishedTimings: ESTABLISHED.filter(([o, m]) => base[o] & m).map(([, , label]) => label),
    standardTimings: [],
    detailedTimings: [],
  };

  for (let i = 38; i <= 52; i += 2) {
    if (base[i] === 0x01 && base[i + 1] === 0x01) continue;   // unused slot
    const width = (base[i] + 31) * 8;
    const aspect = ASPECT[base[i + 1] >> 6];
    const refresh = (base[i + 1] & 0x3f) + 60;
    const heights = { '16:10': (width * 10) / 16, '4:3': (width * 3) / 4, '5:4': (width * 4) / 5, '16:9': (width * 9) / 16 };
    out.standardTimings.push({ width, height: Math.round(heights[aspect]), refresh, aspect,
      label: `${width}x${Math.round(heights[aspect])}@${refresh}` });
  }

  for (let i = 54; i <= 108; i += 18) {
    const d = base.slice(i, i + 18);
    const t = detailedTiming(d);
    if (t) out.detailedTimings.push(t);
    else monitorDescriptor(d, out);
  }

  // The first DTD is the panel's preferred mode by definition — the one an installer means when
  // they ask "what should this be set to".
  out.preferredMode = out.detailedTimings.length ? out.detailedTimings[0].label : null;

  for (let e = 1; e <= out.extensionBlocks && (e + 1) * 128 <= buf.length; e++) {
    parseCea(buf.slice(e * 128, (e + 1) * 128), out);
  }

  return out;
}

module.exports = { parseEdid };
