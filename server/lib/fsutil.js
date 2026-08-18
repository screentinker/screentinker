'use strict';

const fs = require('fs');

/*
 * Copy a file without touching its mode.
 *
 * ⚠️ USE THIS INSTEAD OF fs.copyFileSync FOR ANYTHING UNDER THE DATA DIRECTORY.
 *
 * copyFileSync does not merely copy bytes: it opens the destination and then fchmods it to match
 * the source. On exFAT there are no permission bits, so that chmod is refused and the whole copy
 * fails with
 *
 *     EPERM: operation not permitted, copyfile '.../remote_display.db' -> '.../...pre-migration.db'
 *
 * That is not hypothetical. A BrightSign player's storage is exFAT, and this took down the server
 * running on one: the pre-migration snapshot in db/database.js failed, the failure path called
 * process.exit(1), and because that server runs inside an roHtmlWidget the exit killed the page
 * too — a black screen, no listener, and no diagnostic anywhere. The check was right; the copy was
 * the problem.
 *
 * Chunked rather than readFileSync/writeFileSync because the thing most often copied here is the
 * database, which is unbounded in principle and 33MB in practice on a developer's machine.
 */
const CHUNK = 1024 * 1024;

function copyFileBytes(src, dest) {
  const inFd = fs.openSync(src, 'r');
  let outFd;
  try {
    // 'w' truncates or creates. No mode is requested, so nothing asks exFAT for permission bits.
    outFd = fs.openSync(dest, 'w');
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    for (;;) {
      const read = fs.readSync(inFd, buf, 0, CHUNK, pos);
      if (read <= 0) break;
      let written = 0;
      // A single writeSync is not guaranteed to consume the whole buffer.
      while (written < read) written += fs.writeSync(outFd, buf, written, read - written);
      pos += read;
    }
    /*
     * Carry the source's permissions across where the filesystem has any.
     *
     * ⚠️ NOT optional, and the reason this function exists does not excuse skipping it. Dropping
     * the chmod entirely - which is what the first version did - creates the copy at the default
     * 0666 & ~umask. A database snapshot that was 0600 came out 0664, so the whole database became
     * group- and world-readable on every install. That is a worse bug than the one this function
     * was written to fix.
     *
     * Doing it as a SEPARATE, failure-tolerant step is the difference from fs.copyFileSync: there
     * the chmod is inseparable from the copy, so a filesystem that refuses modes - exFAT, which is
     * what a BrightSign player's storage is - fails the whole operation with EPERM. Here the bytes
     * are already written and safe; the mode is applied if it can be, and its refusal is not an
     * error because on such a filesystem there were never permissions to preserve.
     */
    try {
      fs.fchmodSync(outFd, fs.fstatSync(inFd).mode & 0o777);
    } catch (e) {
      /* no permission bits on this filesystem - nothing to carry across */
    }

    // The caller is usually taking a backup it is about to rely on, so make sure the bytes are
    // actually on the device before it proceeds to modify the original.
    fs.fsyncSync(outFd);
    return pos;
  } finally {
    fs.closeSync(inFd);
    if (outFd !== undefined) fs.closeSync(outFd);
  }
}

module.exports = { copyFileBytes };
