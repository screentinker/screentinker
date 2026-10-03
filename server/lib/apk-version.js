'use strict';
/*
 * Read an APK's own versionName, so the OTA endpoint can advertise the version of the bytes it
 * would actually serve. #341.
 *
 * WHY THIS EXISTS. latest_version used to be the server's own VERSION constant, on the assumption
 * that server and APK ship together. An operator who mounts their own build at
 * /data/ScreenTinker.apk breaks that, and it breaks silently: a 2.0.7 server serving a 2.0.0 APK
 * offers 2.0.7 to a 2.0.0 display, Android accepts the download as a same-version reinstall, the
 * display comes back on 2.0.0, and is offered again. Two field displays did that 493 times over
 * five days with nothing failing anywhere.
 *
 * The Android client has always been able to do this (UpdateChecker.kt uses PackageManager's
 * getPackageArchiveInfo). The server cannot, so it reads the two container formats itself.
 *
 * DELIBERATELY SYNCHRONOUS AND DEPENDENCY-FREE. It runs from apk-cache.refresh(), which is a
 * timer, not a request path, and only when the file's mtime/size actually changed. Measured at
 * 0 to 2 ms on real APKs. Doing it with unzipper would make refresh() async for no benefit; doing
 * it per request would reintroduce exactly the fs-flood #146 removed.
 *
 * Cross-checked against `aapt2 dump badging` on three builds (1.7.7 x2, 2.0.7).
 */
const fs = require('fs');
const zlib = require('zlib');

/* ---- just enough zip to pull one stored/deflated entry out, synchronously ---- */
function readEntrySync(file, wanted) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) return null;
    // The End Of Central Directory record is last, after a comment of up to 64KB.
    const tail = Buffer.alloc(Math.min(66_000, size));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) return null;   // zip64: not worth handling for an APK
    if (cdOff + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const cmtLen = cd.readUInt16LE(p + 32);
      const localOff = cd.readUInt32LE(p + 42);
      if (cd.toString('utf8', p + 46, p + 46 + nameLen) === wanted) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, localOff);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        // The local header repeats the name/extra with its OWN lengths; the central ones lie here.
        const data = Buffer.alloc(csize);
        fs.readSync(fd, data, 0, csize, localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
        return method === 8 ? zlib.inflateRawSync(data) : (method === 0 ? data : null);
      }
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/* ---- just enough Android binary XML to read one attribute off the root element ---- */
const RES_XML = 0x0003, RES_STRING_POOL = 0x0001, RES_XML_START_ELEMENT = 0x0102;
const TYPE_STRING = 0x03;

function parseStringPool(buf, off) {
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & (1 << 8)) !== 0;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + buf.readUInt32LE(off + 28 + i * 4);
    if (utf8) {
      const n1 = buf[p++]; if (n1 & 0x80) p++;                    // char count, may be 2 bytes
      let n = buf[p++]; if (n & 0x80) n = ((n & 0x7f) << 8) | buf[p++];   // byte count
      out[i] = buf.toString('utf8', p, p + n);
    } else {
      let n = buf.readUInt16LE(p); p += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      out[i] = buf.toString('utf16le', p, p + n * 2);
    }
  }
  return out;
}

function versionNameFromAxml(buf) {
  if (!buf || buf.length < 8 || buf.readUInt16LE(0) !== RES_XML) return null;
  let off = buf.readUInt16LE(2);
  let strings = null;
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (type === RES_STRING_POOL) {
      strings = parseStringPool(buf, off);
    } else if (type === RES_XML_START_ELEMENT && strings) {
      if (strings[buf.readUInt32LE(off + 20)] === 'manifest') {
        const attrStart = buf.readUInt16LE(off + 24);
        const attrSize = buf.readUInt16LE(off + 26);
        const attrCount = buf.readUInt16LE(off + 28);
        for (let i = 0; i < attrCount; i++) {
          const a = off + 16 + attrStart + i * attrSize;
          if (a + 20 > buf.length) break;
          if (strings[buf.readUInt32LE(a + 4)] !== 'versionName') continue;
          const raw = buf.readUInt32LE(a + 8);
          // Gradle writes versionName as a literal, so the raw string slot is normally populated.
          if (raw !== 0xFFFFFFFF && strings[raw]) return strings[raw];
          // Otherwise take the typed value, but only if it is a string. A versionName given as
          // @string/... resolves through resources.arsc, which is out of scope: report null and
          // let the caller fall back rather than advertise a resource id as a version.
          return buf.readUInt8(a + 15) === TYPE_STRING ? (strings[buf.readUInt32LE(a + 16)] || null) : null;
        }
        return null;   // root element seen, no versionName on it
      }
    }
    off += size;
  }
  return null;
}

/** The versionName inside an APK, or null if it cannot be read for any reason. Never throws. */
function readApkVersionName(apkPath) {
  try {
    const v = versionNameFromAxml(readEntrySync(apkPath, 'AndroidManifest.xml'));
    return (typeof v === 'string' && v.trim()) ? v.trim() : null;
  } catch (_) {
    return null;
  }
}

module.exports = { readApkVersionName, versionNameFromAxml, readEntrySync };
