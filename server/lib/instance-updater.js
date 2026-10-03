'use strict';

/*
 * The app's half of the instance updater (docs/instance-updater.md).
 *
 * ⚠️ THE SERVER NEVER UPGRADES ITSELF. It cannot: a process that replaces its own container or
 * restarts its own unit dies mid-command, and giving it the rights to do so (docker.sock, sudo)
 * would make every app bug a host-root bug. Instead it writes a REQUEST into a spool it owns and
 * a separate root-owned updater (scripts/updater/st-updater.sh — a systemd path unit, or the
 * docker sidecar) does the work and reports back through a STATUS directory the app can only read.
 *
 * Nothing here runs on a timer. A request exists only because a platform admin pressed the button.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// Where the updater writes; the app only reads. Docker mounts its volume at /updater, the systemd
// installer uses /var/lib/screentinker-updater. An explicit env wins.
const STATUS_CANDIDATES = ['/updater', '/var/lib/screentinker-updater'];
const DOCKER_HEARTBEAT_MAX_SEC = 120;   // the sidecar heartbeats every few seconds
const STALE_JOB_SEC = 45 * 60;          // a "running" status this old is a dead job, not a live one
const RUNNING = new Set(['starting', 'backup', 'fetch', 'pull', 'install', 'restart', 'verify', 'rollback']);
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

class UpdaterError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function readJson(file, maxBytes = 64 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return null; }
}

function statusDir() {
  if (process.env.UPDATER_STATUS_DIR) return process.env.UPDATER_STATUS_DIR;
  return STATUS_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'updater.json'))) || null;
}

function requestDir() {
  return process.env.UPDATER_REQUEST_DIR || path.join(config.dataDir, 'updater', 'requests');
}

// Is an updater installed and (for the always-on sidecar) alive?
function info(now = Math.floor(Date.now() / 1000)) {
  const dir = statusDir();
  const marker = dir && readJson(path.join(dir, 'updater.json'));
  if (!marker || !['git', 'docker'].includes(marker.kind)) return { available: false, reason: 'not_installed' };
  if (marker.kind === 'docker' && !(now - Number(marker.heartbeat_at || 0) <= DOCKER_HEARTBEAT_MAX_SEC)) {
    return { available: false, kind: marker.kind, reason: 'not_running' };
  }
  return { available: true, kind: marker.kind };
}

function pendingRequests() {
  try { return fs.readdirSync(requestDir()).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
}

function tail(file, maxLines = 80, maxBytes = 16 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8').split('\n').slice(-maxLines - 1).join('\n').trim();
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}

function isRunning(job, now = Math.floor(Date.now() / 1000)) {
  return !!(job && RUNNING.has(job.state) && now - Number(job.updated_at || 0) < STALE_JOB_SEC);
}

function status() {
  const dir = statusDir();
  const job = dir ? readJson(path.join(dir, 'status.json')) : null;
  return {
    job: job || null,
    running: isRunning(job),
    pending: pendingRequests().map((f) => f.replace(/\.json$/, '')),
    log: dir ? tail(path.join(dir, 'log.txt')) : '',
  };
}

// Queue one upgrade. Validates what it can; the updater re-validates everything, because it
// cannot trust this file.
function requestUpdate({ target, current, userId }) {
  const t = String(target || '').replace(/^v/, '');
  const c = String(current || '').replace(/^v/, '');
  if (!VERSION_RE.test(t)) throw new UpdaterError('bad_target', 'Pick a release version (X.Y.Z).');
  const cmp = require('./ghcr-check').compareVersions(t, c);
  if (!(cmp > 0)) throw new UpdaterError('not_newer', `v${t} is not newer than the running v${c}.`);
  const u = info();
  if (!u.available) throw new UpdaterError(u.reason, u.reason === 'not_running'
    ? 'The updater container is installed but not running.'
    : 'No updater is installed on this server.');
  const s = status();
  if (s.pending.length || s.running) throw new UpdaterError('busy', 'An upgrade is already queued or running.');

  const dir = requestDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, target: t, from: c, requested_by: String(userId || ''), requested_at: Math.floor(Date.now() / 1000) });
  // Write then rename, so the updater never reads half a request.
  const tmp = path.join(dir, `${id}.tmp`);
  fs.writeFileSync(tmp, body, { mode: 0o640 });
  fs.renameSync(tmp, path.join(dir, `${id}.json`));
  return { id, target: t, kind: u.kind };
}

module.exports = { info, status, requestUpdate, statusDir, requestDir, isRunning, UpdaterError, VERSION_RE };
