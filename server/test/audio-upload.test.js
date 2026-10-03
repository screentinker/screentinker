'use strict';

/*
 * Audio uploads, for slide voiceovers and deck music beds.
 *
 * ⚠️ THE UPLOAD PATH IS AN ALLOWLIST, and it was an allowlist with no audio in it — so the feature
 * shipped with no way to get a track into the library. It is an allowlist on purpose ("a new
 * container format is a deliberate addition rather than something that slips through"), which is
 * exactly why adding one is a code change with tests rather than a config tweak.
 *
 * ⚠️ TWO OF THESE FORMATS SHARE A CONTAINER WITH A VIDEO FORMAT, and that is the part worth
 * testing. An .m4a is ISO-BMFF, the same box structure as an .mp4; an Ogg file may hold Opus or
 * Theora. Both used to be classified as video — playable, but stored under a video extension and
 * invisible to a picker that filters on audio, so an operator would upload a voiceover and then be
 * unable to find it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sniffMime, MIME_TO_EXT, INLINE_SAFE_EXTS } = require('../lib/upload-sniff');

/** Pad to a realistic read so the sniffer sees what it would see from a real file. */
const buf = (...parts) => {
  const head = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
  return Buffer.concat([head, Buffer.alloc(4096 - head.length, 0)]);
};

test('WAV is recognised, and not confused with the other RIFF formats', () => {
  assert.equal(sniffMime(buf('RIFF', '\x00\x00\x00\x00', 'WAVE')), 'audio/wav');
  // The two RIFF neighbours must be unaffected.
  assert.equal(sniffMime(buf('RIFF', '\x00\x00\x00\x00', 'WEBP')), 'image/webp');
  assert.equal(sniffMime(buf('RIFF', '\x00\x00\x00\x00', 'AVI ')), 'video/x-msvideo');
});

test('FLAC is recognised', () => {
  assert.equal(sniffMime(buf('fLaC', '\x00\x00\x00\x22')), 'audio/flac');
});

test('an .m4a is told apart from the .mp4 it shares a container with', () => {
  assert.equal(sniffMime(buf('\x00\x00\x00\x20', 'ftyp', 'M4A ')), 'audio/mp4');
  assert.equal(sniffMime(buf('\x00\x00\x00\x20', 'ftyp', 'M4B ')), 'audio/mp4');
  // The brands that are genuinely video or image must not have moved.
  assert.equal(sniffMime(buf('\x00\x00\x00\x20', 'ftyp', 'isom')), 'video/mp4');
  assert.equal(sniffMime(buf('\x00\x00\x00\x20', 'ftyp', 'qt  ')), 'video/quicktime');
  assert.equal(sniffMime(buf('\x00\x00\x00\x20', 'ftyp', 'avif')), 'image/avif');
});

test('an Ogg file is classified by what is inside it, not just by OggS', () => {
  assert.equal(sniffMime(buf('OggS', '\x00'.repeat(24), 'OpusHead')), 'audio/ogg');
  assert.equal(sniffMime(buf('OggS', '\x00'.repeat(24), '\x01vorbis')), 'audio/ogg');
  // Unidentifiable Ogg keeps the previous answer rather than guessing audio.
  assert.equal(sniffMime(buf('OggS', '\x00'.repeat(24), 'theora')), 'video/ogg');
});

test('MP3 is recognised with a tag, and with a bare frame sync', () => {
  assert.equal(sniffMime(buf('ID3\x03\x00\x00\x00\x00\x00\x00')), 'audio/mpeg');
  // 0xFFFB: sync + MPEG-1 + layer III, 128kbps 44.1kHz.
  assert.equal(sniffMime(buf(Buffer.from([0xff, 0xfb, 0x90, 0x00]))), 'audio/mpeg');
});

test('the loose MP3 sync does not swallow other formats', () => {
  /*
   * The frame sync is eleven set bits and nothing more, so it is checked LAST and with the
   * reserved encodings excluded. These are the ways a false positive would show up.
   */
  // Reserved layer (bits 00) — not a frame.
  assert.equal(sniffMime(buf(Buffer.from([0xff, 0xf9, 0x90, 0x00]))), null);
  // Invalid bitrate index (1111).
  assert.equal(sniffMime(buf(Buffer.from([0xff, 0xfb, 0xf0, 0x00]))), null);
  // Reserved sample rate (11).
  assert.equal(sniffMime(buf(Buffer.from([0xff, 0xfb, 0x9c, 0x00]))), null);
  // And every real format still resolves to itself rather than to MP3.
  assert.equal(sniffMime(buf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))), 'image/jpeg');
});

test('every audio type lands on an extension, and is served inline', () => {
  for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac']) {
    const ext = MIME_TO_EXT[mime];
    assert.ok(ext, `${mime} has no extension, so an upload of it is refused`);
    // Not inline means served as an attachment, and an <audio src> pointed at an attachment
    // plays nothing at all.
    assert.ok(INLINE_SAFE_EXTS.has(ext), `${ext} would download instead of playing`);
  }
});

test('the ingest path probes audio, so the voiceover warning has a duration to compare', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'content-ingest.js'), 'utf8');
  assert.match(src, /mime\.startsWith\('video\/'\) \|\| mime\.startsWith\('audio\/'\)/,
    'without this an uploaded voiceover has no duration_sec and vo-outlives-dwell can never fire');
});

test('audio is admitted by extension when the caller sends an unhelpful type', () => {
  /*
   * ⚠️ FOUND BY UPLOADING A REAL FILE, not by reading the code. The sniffer was taught about audio
   * and the upload still failed, because multer's fileFilter is a SECOND allowlist — and then it
   * failed again for a client that sends application/octet-stream, which curl does for a .wav.
   * Browsers send a real type; plenty of other things do not, and the feature looks broken for all
   * of them.
   *
   * Mirrors the .wgt rule already in that file: the extension has to agree with the unhelpful type,
   * because bare octet-stream on its own would let every default upload reach the disk.
   */
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'upload.js'), 'utf8');
  assert.match(src, /looksLikeMedia/, 'a client sending octet-stream for a .wav must still get through');
  assert.match(src, /mp3\|m4a\|m4b\|wav\|ogg\|oga\|opus\|flac/, 'the extensions it admits');
  assert.match(src, /ZIP_MIMETYPES\.includes/, 'and only alongside an unhelpful type, never on its own');
  assert.match(src, /startsWith\('audio\/'\)/, 'a real audio type is admitted directly');
});
