'use strict';

const crypto = require('crypto');

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
  /*
   * ⚠️ EVERY FAILURE ENDS UP IN THE LOG ON DISK. This wrapper is the whole point of the change.
   *
   * The log already existed to work around the status listener being bound to localhost (#291,
   * deliberately — it must not answer the LAN). But only the SUCCESS path wrote to it: every
   * `throw` in here skipped note() entirely, so a failed install left a log that simply stopped,
   * and the reason lived in `installState` and the on-screen ring buffer — one unreachable on a
   * real player, the other gone at the next reboot.
   *
   * So the one artefact a technician can actually fetch, over DWS, from a box on a wall in another
   * building, contained everything except why it broke. Diagnosing alpha5 meant guessing.
   */
  try {
    return await installInner(opts);
  } catch (e) {
    try {
      const logPath = path.join(opts.installDir, '.payload-install.log');
      const msg = String((e && e.message) ? e.message : e);
      const stack = (e && e.stack) ? '\n' + String(e.stack).split('\n').slice(1, 4).join('\n') : '';
      // Appended, so it lands after whatever progress the run managed to record.
      const prior = (() => { try { return fs.readFileSync(logPath, 'utf8'); } catch (_) { return ''; } })();
      fs.writeFileSync(logPath,
        prior + new Date().toISOString() + '  FAILED: ' + msg + stack + '\n');
    } catch (_) { /* a diagnostic must never be the thing that breaks an install */ }
    throw e;
  }
}

async function installInner(opts) {
  const { url, installDir, onState, expectSha256 } = opts;
  const say = (phase, detail, pct) => { if (onState) onState({ phase, detail, pct }); };

  const zipPath = path.join(installDir, 'server-payload.zip');
  let installedDigest = null;

  /*
   * ⚠️ AN INSTALL LOG ON DISK, because the live one is unreachable where it matters. The status
   * listener binds to localhost only (#291, deliberately — it should not answer the LAN), so on a
   * real player the only account of what happened during an install is inside a process nobody can
   * query. Diagnosing a failed update then means guessing, which is exactly where this landed.
   *
   * A file the device's own web server can serve turns that into evidence. Small, overwritten each
   * run, and best-effort: a diagnostic that could itself break an install would be worse than none.
   */
  const logPath = path.join(installDir, '.payload-install.log');
  /*
   * ⚠️ NOT INSIDE THE REPLACED TREE, EVEN THOUGH IT LIVES IN installDir. The replace loop
   * iterates the payload's own top-level entries, and neither of these dotfiles is one of them —
   * so they survive it. That is load-bearing: a log that vanished with the tree it was describing
   * would be worthless at exactly the moment it is needed.
   */
  const incompleteMarker = path.join(installDir, '.payload-incomplete');
  const lines = [];
  const note = (msg) => {
    lines.push(new Date().toISOString() + '  ' + msg);
    try { fs.writeFileSync(logPath, lines.join('\n') + '\n'); } catch (e) { /* never fatal */ }
  };
  const msgOf = (e) => String((e && e.message) ? e.message : e);
  note('install starting from ' + url + (expectSha256 ? ' (checksum supplied)' : ' (NO checksum supplied)'));
  const staging = path.join(installDir, '.payload-staging');
  const entry = path.join(installDir, 'server', 'server.js');

  say('downloading', url, 0);
  const { bytes } = await download(url, zipPath, (got, total) => {
    const mb = (n) => Math.round(n / 1048576);
    say('downloading',
        total ? `${mb(got)}MB of ${mb(total)}MB` : `${mb(got)}MB`,
        total ? Math.round((got / total) * 100) : null);
  });

  /*
   * ⚠️ THE DIGEST IS COMPUTED FOR EVERY INSTALL, verified when there is something to verify against,
   * and RECORDED either way.
   *
   * Two jobs, and tying the second to the first is what broke it: an install with no manifest
   * recorded nothing, so the next boot had nothing to compare against and could never detect a
   * rebuild — one missing fetch disabling update detection for the life of the device.
   *
   * ⚠️ AND VERIFYING BEFORE EXTRACTING IS THE POINT. "It unpacked" is not "it is what we published":
   * a truncated download is a valid zip far more often than people expect, and this project has
   * already seen truncated APKs in the field. A partial payload that extracted cleanly would
   * otherwise be swapped in over a working server.
   */
  installedDigest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
  note('downloaded ' + bytes + ' bytes, sha256=' + installedDigest);

  if (expectSha256 && installedDigest !== expectSha256) {
    note('CHECKSUM MISMATCH: expected ' + expectSha256 + ' — refusing to install');
    throw new Error('payload checksum mismatch: expected ' + expectSha256.slice(0, 12) +
                    '… got ' + installedDigest.slice(0, 12) + '… — refusing to install');
  }
  if (expectSha256) note('checksum verified against the published manifest');

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
  /*
   * ⚠️ THIS LOOP IS NOT ATOMIC, AND A FAILURE PART WAY THROUGH LEAVES A TREE THAT BOOTS.
   *
   * Each top-level entry is removed and replaced in turn. Die on entry 40 of 60 and the tree is a
   * mixture: VERSION may already say the new version while half the modules are still the old
   * ones. The caller then sees a server/server.js on disk, decides a failed UPDATE is survivable
   * (correctly — an unreachable update server must not be an outage) and starts it. So the box
   * comes up, reports the new version, and is running something nobody built.
   *
   * That is what happened on the 2.0.0-alpha5 install: VERSION new, server running, install log
   * stopped three lines in, and no digest recorded. It could not be diagnosed because the error
   * existed only in a process that then rebooted.
   *
   * The marker below is what makes it detectable. It is written before the first entry is touched
   * and removed only when the tree is whole, so its presence at boot means "this tree is a
   * mixture" — see bs-server-boot.js, which reinstalls rather than trusting VERSION.
   */
  try { fs.writeFileSync(incompleteMarker, new Date().toISOString() + ' replacing tree\n'); }
  catch (e) { note('could not write the incomplete marker: ' + msgOf(e)); }

  let replacing = null;
  try {
    for (const name of fs.readdirSync(staging)) {
      replacing = name;
      const from = path.join(staging, name);
      const to = path.join(installDir, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
    }
  } catch (e) {
    // ⚠️ Named, because "the install failed" and "the install failed while replacing server/,
    // so the tree is now a mixture" are different problems with different recoveries.
    note('FAILED while replacing "' + replacing + '" — the tree is now a MIXTURE of versions: ' + msgOf(e));
    throw e;
  }
  replacing = null;
  fs.rmSync(staging, { recursive: true, force: true });

  // The archive is 71MB of duplicate on a device that will never need it again.
  try { fs.unlinkSync(zipPath); } catch (e) { /* not worth failing over */ }

  if (!fs.existsSync(entry)) throw new Error('install finished but ' + entry + ' is missing');
  // The tree is whole from here, so the mixture marker comes off. Anything that fails after this
  // point is extra credit (the digest, the launcher refresh) and leaves a usable install behind.
  try { fs.unlinkSync(incompleteMarker); } catch (e) { /* absent is the state we wanted */ }
  note('tree replaced, ' + result.files + ' files, server/server.js present');

  /*
   * ⚠️ RECORD THE DIGEST HERE — BEFORE the launcher self-refresh below, not after it.
   *
   * The tree is now complete and verified, which is the moment "this box is running these bytes"
   * becomes true. Everything after this point is optional extra credit that can fail without making
   * that statement false, and the launcher refresh explicitly calls itself the riskiest copy in the
   * project. Recording afterwards made the durable fact depend on the fragile step.
   *
   * That is not hypothetical. A real XT245 took 2.0.0-alpha1, ran it, reported it up the mesh — and
   * came back with no .payload-sha256 at all and a log that stopped before this line. Because the
   * digest is what detects a REBUILD of an unchanged version string, and every alpha build is
   * "2.0.0-alpha1", that box had quietly lost the ability to see the next payload. It still boots,
   * because differs() falls back to comparing versions, which is why nothing looked wrong.
   *
   * ⚠️ READ IT BACK. This file is the entire basis of the next update decision, and a truncated or
   * empty write reads as "no digest" — which silently degrades to version-only comparison rather
   * than failing. Verifying costs one read of 64 bytes.
   */
  if (installedDigest) {
    try {
      fs.writeFileSync(path.join(installDir, '.payload-sha256'), installedDigest);
      const back = fs.readFileSync(path.join(installDir, '.payload-sha256'), 'utf8').trim();
      if (back !== installedDigest) throw new Error('wrote ' + installedDigest.slice(0, 12) +
                                                    '… but read back ' + (back.slice(0, 12) || '(empty)') + '…');
      note('recorded .payload-sha256=' + installedDigest);
    } catch (e) {
      note('could NOT record .payload-sha256: ' + (e && e.message) +
           ' — this box will not detect a rebuild of the version it just installed');
    }
  } else {
    note('no digest computed — nothing recorded, so the next boot cannot detect a rebuild');
  }

  /*
   * ⚠️ THE LAUNCHER IS INSTALLED BY THE TREE REPLACE ABOVE, NOT COPIED HERE.
   *
   * This used to fs.copyFileSync the payload's brightsign/server/bs-*.js up to the root, and it was
   * the riskiest copy in the project by its own admission. On a real XT245 it silently did nothing,
   * twice: both files existed, both differed, no .prev appeared, and the only account of the failure
   * went to a status listener bound to localhost that nothing on a player can reach. The payload
   * installed, the server ran, and the launcher stayed frozen at whatever the boot zip first
   * dropped — so every launcher fix, including the update check written to solve this exact class of
   * problem, could never have reached a box in the field.
   *
   * The payload now carries both files at its TOP LEVEL, so they are placed by the same
   * rmSync+renameSync loop that lands the other 9,630 files and is proven on that hardware. rename()
   * is also the safer verb: it never opens the destination, so replacing a script the running
   * process has already require()d is atomic rather than a write into a file in use.
   *
   * What is left here is only the report. If a payload predates the build change its top level has
   * no launcher, the root copy stays as it was, and the log says so instead of staying silent.
   */
  for (const name of ['bs-server-boot.js', 'bs-payload-install.js']) {
    try {
      const root = path.join(installDir, name);
      if (!fs.existsSync(root)) { note('launcher ' + name + ' is MISSING from the install root'); continue; }
      const inPayload = path.join(installDir, 'brightsign', 'server', name);
      if (!fs.existsSync(inPayload)) continue;
      const matches = fs.readFileSync(root, 'utf8') === fs.readFileSync(inPayload, 'utf8');
      note(matches
        ? 'launcher ' + name + ' is current'
        : 'launcher ' + name + ' NOT updated — this payload carries no top-level copy, so the ' +
          'launcher stays as it was. A payload built before the top-level change cannot update it.');
    } catch (e) {
      note('could not check launcher ' + name + ': ' + ((e && e.message) || 'unknown'));
    }
  }

  note('installed ' + result.files + ' files');
  say('installed', `${result.files} files`, 100);
  return result;
}

module.exports = { install, unzip, download };
