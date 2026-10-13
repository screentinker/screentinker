'use strict';

/*
 * res.sendFile(absolutePath) with Express 4's dotfile rule.
 *
 * ⚠️ EXPRESS 5 (send 1.x) REFUSES A DOT-SEGMENT ANYWHERE IN THE PATH, not only in the file's own name
 * as Express 4 did. Every res.sendFile(absPath) in the server then 404s whenever the install or
 * DATA_DIR sits under any dot-directory (~/.local/share/screentinker, a .history folder of retained
 * revisions): the dashboard shell, /player, downloads, all of it. Passing the directory as `root`
 * makes send check only the part below root, which is the file name, exactly the old behaviour: a
 * dotfile is still refused, a dot-directory above it is not.
 *
 * Calls that already pass their own `root` are left alone; so are relative paths, which need one.
 */
const path = require('path');

function sendFileCompat(req, res, next) {
  const sendFile = res.sendFile;
  res.sendFile = function compatSendFile(file, options, callback) {
    if (typeof options === 'function') { callback = options; options = undefined; }
    if (typeof file === 'string' && path.isAbsolute(file) && !(options && options.root)) {
      return sendFile.call(this, path.basename(file), { ...(options || {}), root: path.dirname(file) }, callback);
    }
    return sendFile.call(this, file, options, callback);
  };
  next();
}

module.exports = { sendFileCompat };
