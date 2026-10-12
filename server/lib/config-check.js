'use strict';

/*
 * Boot-time checks for two self-hosting traps that otherwise fail SILENTLY.
 *
 * 1. A .env file whose settings are not in effect.
 *    `npm start` runs `node --env-file-if-exists=.env server.js`, so server/.env is loaded only when
 *    the server is started that way. pm2, systemd and plain `node server.js` all skip it, and the
 *    repository-root .env (a copy of .env.example) is never read at all. A self-hoster under pm2
 *    put SELF_HOSTED=true in the root .env and ran for days in hosted mode (plan limits, trial
 *    expiry, view-only access off) with nothing on screen to say so.
 *    We compare each key in those files with the running process and name the ones that differ.
 *    Comparing, rather than warning about the file's existence, keeps an install that loads the
 *    same file through systemd's EnvironmentFile= quiet. Only key NAMES are logged, never values:
 *    these files hold secrets.
 *
 * 2. A JWT_SECRET that changed.
 *    lib/secretbox.js derives its encryption key from JWT_SECRET, so a new secret signs everyone out
 *    AND makes every secret saved in the dashboard unreadable. The common way in is the trap above:
 *    the server generated certs/.jwt_secret on first boot, then someone applies a .env with its own
 *    JWT_SECRET. We store a check value derived from the key (an HMAC, not the key and not a
 *    ciphertext) and compare it on every boot. When the old generated secret is still on disk and
 *    matches, we name that file as the way back.
 *    The first boot with this check just records the current key: a change that happened before
 *    this code existed cannot be detected.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHECK_KEY = 'secretbox_check';

/** KEY=value lines, as Node's --env-file reads them: comments, blank lines and `export ` ignored. */
function parseEnvFile(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    const q = v[0];
    if ((q === '"' || q === "'" || q === '`') && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, '').trim();
    out.set(m[1], v);
  }
  return out;
}

/**
 * Warnings for .env files whose settings the running process does not have.
 * @returns {string[]} one message per file, key names only
 */
function envFileWarnings({ serverDir, env = process.env, execArgv = process.execArgv, readFile = fs.readFileSync } = {}) {
  const loadedByFlag = execArgv.some((a) => a.startsWith('--env-file'));
  const files = [
    { file: path.join(serverDir, '.env'), local: true },
    { file: path.join(serverDir, '..', '.env'), local: false },
  ];
  const out = [];
  for (const { file, local } of files) {
    let text;
    try { text = readFile(file, 'utf8'); } catch { continue; }
    const keys = [...parseEnvFile(text)].filter(([k, v]) => env[k] !== v).map(([k]) => k);
    if (!keys.length) continue;
    const shown = path.resolve(file);
    const why = local
      ? (loadedByFlag
        ? 'It was loaded, but the process environment overrides it (an environment variable wins over the file).'
        : 'This file is loaded only by `npm start`; this server was started another way (pm2, systemd or `node server.js`), so it was not read. Put these settings where that process manager sets the environment.')
      : 'The server never reads this file. Put these settings where your process manager sets the environment (systemd Environment=, pm2, docker), or in server/.env if you start with `npm start`.';
    let msg = `[config] ${shown} sets ${keys.join(', ')}, but the running server does not have ${keys.length === 1 ? 'that value' : 'those values'}. ${why}`;
    if (keys.includes('JWT_SECRET')) {
      msg += ' ⚠️ Do not apply JWT_SECRET from it unless it is the secret this server already uses: it also keys the encryption of saved secrets, so a new one signs everyone out and makes them unreadable.';
    }
    out.push(msg);
  }
  return out;
}

/** The check value for a JWT secret: an HMAC under the key secretbox derives from it. */
function checkValueFor(secret) {
  const key = crypto.createHash('sha256').update(String(secret) + ':secretbox-v1').digest();
  return crypto.createHmac('sha256', key).update('screentinker secretbox check v1').digest('hex');
}

/**
 * Compare the running secret with the one this database was last used with.
 * `get`/`set` read and write app_settings. Returns { status: 'recorded' | 'ok' | 'changed', messages }.
 */
function checkSecretKey({ secret, get, set, certsDir, envSecret = process.env.JWT_SECRET, readFile = fs.readFileSync }) {
  const current = checkValueFor(secret);
  const stored = get(CHECK_KEY);
  if (!stored) {
    try { set(CHECK_KEY, current); } catch { /* read-only replica: nothing to record */ }
    return { status: 'recorded', messages: [] };
  }
  if (stored === current) return { status: 'ok', messages: [] };

  const generated = path.join(certsDir, '.jwt_secret');
  let fileSecret = null;
  try { fileSecret = readFile(generated, 'utf8').trim(); } catch { /* no generated secret on disk */ }
  const fileIsPrevious = !!fileSecret && checkValueFor(fileSecret) === stored;

  const messages = [
    '[secrets] ⚠️ JWT_SECRET is not the secret this database was last used with. Everyone has been signed out, and secrets saved in the dashboard before the change (integration and storage credentials, AI keys, view-only share links) can no longer be decrypted.',
  ];
  if (fileIsPrevious && envSecret) {
    messages.push(`[secrets] The previous secret is the one this server generated, in ${path.resolve(generated)}. To go back: remove JWT_SECRET from the server's environment (or set it to that file's contents) and restart.`);
  } else {
    messages.push('[secrets] If this was not intended, restore the previous JWT_SECRET and restart.');
  }
  messages.push(`[secrets] If it was intended, enter those secrets again, then clear this warning: sqlite3 <your database> "DELETE FROM app_settings WHERE key = '${CHECK_KEY}'"`);
  return { status: 'changed', messages };
}

module.exports = { parseEnvFile, envFileWarnings, checkValueFor, checkSecretKey, CHECK_KEY };
