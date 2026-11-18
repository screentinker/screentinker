'use strict';

/*
 * A minimal MP4 writer for one H.264 track of constant-duration samples.
 *
 * Layout is "fast start": ftyp, moov, then mdat, so a player can begin as soon as it has the index.
 * The sample table is the smallest legal one: every sample has the same duration (one stts entry),
 * all samples live in one chunk (one stsc entry, one stco offset), and only sample 1 is a sync sample.
 * avcC carries the SPS and PPS; colr (nclx) repeats the BT.709 limited-range tags for players that
 * read colour from the container rather than the bitstream.
 */

function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, vf, ...payloads);
}

function u32(...values) {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
}

function u16(...values) {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeUInt16BE(v & 0xffff, i * 2));
  return b;
}

const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/**
 * Build the file. `samples` are access units as NAL payload lists (no start codes); each NAL is
 * written with a 4-byte length prefix. `sps`/`pps` are NAL payloads (header byte included).
 */
function writeMp4({ width, height, sps, pps, samples, sampleDuration = 1000, timescale = 1000 }) {
  if (!samples.length) throw new Error('at least one sample is required');
  const sampleData = samples.map((nals) => Buffer.concat(nals.flatMap((n) => [u32(n.length), Buffer.from(n)])));
  const duration = sampleDuration * samples.length;

  const avcC = box('avcC',
    Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]), u16(sps.length), Buffer.from(sps),
    Buffer.from([1]), u16(pps.length), Buffer.from(pps));
  // colour_primaries, transfer_characteristics, matrix_coefficients = BT.709; full_range_flag = 0
  const colr = box('colr', Buffer.from('nclx', 'ascii'), u16(1, 1, 1), Buffer.from([0]));
  const avc1 = box('avc1',
    Buffer.alloc(6), u16(1),                // reserved, data_reference_index
    Buffer.alloc(16),                       // pre_defined / reserved
    u16(width, height),
    u32(0x00480000, 0x00480000, 0),         // 72 dpi, reserved
    u16(1),                                 // frame_count
    Buffer.alloc(32),                       // compressorname
    u16(0x0018), u16(0xffff),               // depth, pre_defined = -1
    avcC, colr);

  const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
  const stts = fullBox('stts', 0, 0, u32(1, samples.length, sampleDuration));
  const stss = fullBox('stss', 0, 0, u32(1, 1));
  const stsc = fullBox('stsc', 0, 0, u32(1, 1, samples.length, 1));
  const stsz = fullBox('stsz', 0, 0, u32(0, samples.length), u32(...sampleData.map((d) => d.length)));

  const ftyp = box('ftyp', Buffer.from('isom', 'ascii'), u32(0x200), Buffer.from('isomiso2avc1mp41', 'ascii'));

  // The chunk offset depends on the size of moov, which contains it; the stco box has a fixed size,
  // so build moov once with offset 0 to measure it, then again with the real offset.
  const buildMoov = (chunkOffset) => {
    const stco = fullBox('stco', 0, 0, u32(1, chunkOffset));
    const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
    const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
    const minf = box('minf', fullBox('vmhd', 0, 1, u16(0, 0, 0, 0)), dinf, stbl);
    const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'ascii'), u32(0, 0, 0), Buffer.from('VideoHandler\0', 'ascii'));
    const mdhd = fullBox('mdhd', 0, 0, u32(0, 0, timescale, duration), u16(0x55c4, 0)); // language "und"
    const mdia = box('mdia', mdhd, hdlr, minf);
    const tkhd = fullBox('tkhd', 0, 3, u32(0, 0, 1, 0, duration, 0, 0), u16(0, 0, 0, 0), MATRIX, u32(width * 65536, height * 65536));
    const trak = box('trak', tkhd, mdia);
    const mvhd = fullBox('mvhd', 0, 0, u32(0, 0, timescale, duration, 0x00010000), u16(0x0100, 0), u32(0, 0), MATRIX, Buffer.alloc(24), u32(2));
    return box('moov', mvhd, trak);
  };
  const moovSize = buildMoov(0).length;
  const mdatPayload = Buffer.concat(sampleData);
  const moov = buildMoov(ftyp.length + moovSize + 8);
  return Buffer.concat([ftyp, moov, box('mdat', mdatPayload)]);
}

module.exports = { writeMp4 };
