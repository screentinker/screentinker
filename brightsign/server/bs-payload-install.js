'use strict';

/*
 * Fetch and unpack the server payload, on the player, in pure JavaScript.
 *
 * WHY THIS EXISTS. BrightSignOS cannot open a large autorun.zip. The 73MB build of this server
 * failed at boot with
 *
 *     Failed to use zipped 'SSD:/autorun.zip': ZipArchive error at line 91
 *     Load or runtime error in autorun. Forcing recovery.
 *
 * and the OS renamed the archive to autorun.zip_invalid — which is how a device that had once
 * unpacked successfully came up with no autorun at all. The identical package cut down to 32KB and
 * five files boots fine, so the limit is in the OS's boot-time zip reader, not in the archive:
 * paths (max 182 chars) and depth (8) are unremarkable, and provisioning unpacks the big one
 * happily.
 *
 * So autorun.zip carries only what is needed to start, and the ~71MB of server + node_modules comes
 * down over HTTP into a Node process that has no such limit. A side benefit worth having: the
 * payload can be updated without re-provisioning the device.
 *
 * NO DEPENDENCIES, deliberately. This code runs *before* node_modules exists, so it cannot use
 * anything from it. That is less painful than it sounds — the payload is STORED, so the common case
 * is copying byte ranges, and DEFLATE is handled by the built-in zlib for anything that is not.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

/* ------------------------------------------------------------------------------------------- */
/* Download                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/*
 * Straight to a file, never into memory. The payload is ~71MB on a player with other things to do;
 * buffering it whole would work today and stop working the first time the bundle grows.
 *
 * Downloads to a .part and renames on completion, so an interrupted transfer — a reboot mid-fetch is
 * entirely normal on a device someone can unplug — can never be mistaken for a finished one.
 */
function download(url, dest, onProgress, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, onProgress, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
      }

      const total = parseInt(res.headers['content-length'] || '0', 10) || null;
      let got = 0;
      const part = dest + '.part';
      let out;
      try { out = fs.createWriteStream(part); } catch (e) { return reject(e); }

      res.on('data', (chunk) => {
        got += chunk.length;
        if (onProgress) onProgress(got, total);
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => {
        try {
          // A truncated body that still ended cleanly is a real failure mode on flaky links, and it
          // produces a zip whose central directory is simply missing — an error far from the cause.
          if (total !== null && got !== total) {
            fs.unlinkSync(part);
            return reject(new Error('short download: ' + got + ' of ' + total + ' bytes'));
          }
          fs.renameSync(part, dest);
          resolve({ bytes: got });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out fetching ' + url)));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------------------------------- */
/* Unzip                                                                                        */
/* ------------------------------------------------------------------------------------------- */

function findEocd(fd, size) {
  // The EOCD sits at the very end unless there is a trailing comment, which is capped at 64KB.
  const want = Math.min(size, 65557);
  const buf = Buffer.alloc(want);
  fs.readSync(fd, buf, 0, want, size - want);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      // ZIP64 would put the real values in a separate record and leave 0xffffffff here. The payload
      // is nowhere near those limits, but a silent misparse would be far worse than a clear refusal.
      if (i >= 20 && buf.readUInt32LE(i - 20) === ZIP64_EOCD_LOCATOR_SIG) {
        throw new Error('ZIP64 archives are not supported by this installer');
      }
      return {
        entries: buf.readUInt16LE(i + 10),
        cdSize: buf.readUInt32LE(i + 12),
        cdOffset: buf.readUInt32LE(i + 16),
      };
    }
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/*
 * Reject anything that would write outside the destination.
 *
 * "Zip slip": an entry named ../../etc/something escapes the extraction root. Nothing we build
 * contains such a name, but this unpacks a file fetched over the network onto a device in someone
 * else's building, and validating is two lines.
 */
function safeJoin(destDir, name) {
  if (!name || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return null;
  const full = path.resolve(destDir, name);
  const root = path.resolve(destDir) + path.sep;
  return (full + path.sep).startsWith(root) ? full : null;
}

/*
 * Extract, yielding to the event loop as it goes.
 *
 * A synchronous loop over 9,000+ files would be simpler, and on this hardware it would freeze the
 * page for the entire extraction — the one surface that can report what is happening. Handing
 * control back every so often keeps the screen alive and costs nothing measurable.
 */
async function unzip(zipPath, destDir, onProgress) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const eocd = findEocd(fd, size);

    const cd = Buffer.alloc(eocd.cdSize);
    fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset);

    const localHeader = Buffer.alloc(30);
    let done = 0;
    let skipped = 0;
    let p = 0;

    for (let n = 0; n < eocd.entries; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) {
        throw new Error('corrupt central directory at entry ' + n);
      }
      const method = cd.readUInt16LE(p + 10);
      const expectedCrc = cd.readUInt32LE(p + 16);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;

      const target = safeJoin(destDir, name);
      if (!target) { skipped++; continue; }

      if (name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        // The local header's extra field can differ in length from the central one, so the data
        // offset has to come from the local header — not from the central directory's copy.
        fs.readSync(fd, localHeader, 0, 30, localOffset);
        if (localHeader.readUInt32LE(0) !== LOCAL_SIG) {
          throw new Error('corrupt local header for ' + name);
        }
        const dataAt = localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);

        const raw = Buffer.alloc(compressedSize);
        if (compressedSize > 0) fs.readSync(fd, raw, 0, compressedSize, dataAt);

        let data;
        if (method === 0) data = raw;                       // STORED — the whole point
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error('unsupported compression method ' + method + ' for ' + name);

        /*
         * Verify the CRC the archive already carries.
         *
         * Skipping this was a real gap: a corrupted or short-read file lands on disk looking
         * perfectly normal and only surfaces much later as something baffling - a "SyntaxError:
         * Invalid or unexpected token" from a file nobody edited, hundreds of files after the actual
         * damage. The checksum is right there in the central directory and costs a pass over bytes
         * we have already read.
         */
        if (typeof zlib.crc32 === 'function' && expectedCrc !== 0) {
          const actual = zlib.crc32(data);
          if (actual !== expectedCrc) {
            throw new Error('checksum mismatch extracting ' + name +
                            ' (expected ' + expectedCrc.toString(16) + ', got ' + actual.toString(16) + ')');
          }
        }

        fs.mkdirSync(path.dirname(target), { recursive: true });
        // writeFileSync, never copyFileSync: the destination is exFAT, which has no permission bits,
        // and anything that tries to set a mode there fails with EPERM.
        fs.writeFileSync(target, data);
      }

      done++;
      if (done % 100 === 0) {
        if (onProgress) onProgress(done, eocd.entries);
        await new Promise((r) => setImmediate(r));
      }
    }

    if (onProgress) onProgress(done, eocd.entries);
    return { files: done, skipped, entries: eocd.entries };
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The installer                                                                                */
/* ------------------------------------------------------------------------------------------- */

/*
 * Install the payload into installDir, reporting progress through onState.
 *
 * Extraction goes to a staging directory and is renamed into place only once it has completed and
 * been checked. Unpacking 9,000 files directly over the destination means an interruption leaves a
 * half-installed tree that looks installed — server/server.js can easily be file 300 of 9,356 — and
 * every subsequent boot would then skip the install and fail somewhere deep in a missing module.
 */
async function install(opts) {
  const { url, installDir, onState } = opts;
  const say = (phase, detail, pct) => { if (onState) onState({ phase, detail, pct }); };

  const zipPath = path.join(installDir, 'server-payload.zip');
  const staging = path.join(installDir, '.payload-staging');
  const entry = path.join(installDir, 'server', 'server.js');

  say('downloading', url, 0);
  const { bytes } = await download(url, zipPath, (got, total) => {
    const mb = (n) => Math.round(n / 1048576);
    say('downloading',
        total ? `${mb(got)}MB of ${mb(total)}MB` : `${mb(got)}MB`,
        total ? Math.round((got / total) * 100) : null);
  });

  say('extracting', `${Math.round(bytes / 1048576)}MB downloaded`, 0);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const result = await unzip(zipPath, staging, (done, total) => {
    say('extracting', `${done} of ${total} files`, Math.round((done / total) * 100));
  });

  // Verify before committing: the archive can be perfectly valid and still be the wrong archive.
  if (!fs.existsSync(path.join(staging, 'server', 'server.js'))) {
    throw new Error('payload unpacked but contains no server/server.js (' + result.files + ' files)');
  }

  /*
   * Replacing the tree wholesale is only safe because runtime state lives OUTSIDE it: the launcher
   * exports DATA_DIR so the database, uploads and certs sit in <install>/data, not in <install>/
   * server. Refuse rather than proceed if that ever stops being true - this loop deletes what it
   * replaces, and a payload update is not allowed to be a data-loss event.
   */
  const dataDir = process.env.DATA_DIR || '';
  const wouldDeleteState = dataDir && fs.readdirSync(staging)
    .some((name) => (path.resolve(dataDir) + path.sep).startsWith(path.resolve(installDir, name) + path.sep));
  if (wouldDeleteState) {
    throw new Error('refusing to install: DATA_DIR (' + dataDir + ') is inside the payload tree');
  }

  say('installing', `${result.files} files`, null);
  for (const name of fs.readdirSync(staging)) {
    const from = path.join(staging, name);
    const to = path.join(installDir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
  fs.rmSync(staging, { recursive: true, force: true });

  // The archive is 71MB of duplicate on a device that will never need it again.
  try { fs.unlinkSync(zipPath); } catch (e) { /* not worth failing over */ }

  if (!fs.existsSync(entry)) throw new Error('install finished but ' + entry + ' is missing');
  say('installed', `${result.files} files`, 100);
  return result;
}

module.exports = { install, unzip, download };
