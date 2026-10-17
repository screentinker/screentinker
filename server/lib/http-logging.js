'use strict';

// The service manager owns files/rotation. The application only writes to its console.
const net = require('node:net');
const { format } = require('node:util');
const SAFE_CONSOLE = Symbol.for('screentinker.safe-console');
const writeStdout = line => process.stdout.write(line);
const AUTH_METHOD = Object.freeze({ PASSWORD: 'password', TOTP: 'totp' });

function clientAddress(value) {
  if (typeof value !== 'string') return null;
  const ip = value.replace(/^::ffff:/i, '');
  // Zone identifiers and arbitrary header text do not belong in ban commands.
  return net.isIP(ip) && /^[\da-f:.]+$/i.test(ip) ? ip : null;
}

function escapeControls(text) {
  return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ch => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

// Console diagnostics share the service log with security records. Escape the WHOLE
// formatted call, not just selected request fields: otherwise any newline in an IdP
// error, plugin message or stack could impersonate a fail2ban event on a fresh line.
function installConsoleSafety(target = console) {
  if (target[SAFE_CONSOLE]) return;
  Object.defineProperty(target, SAFE_CONSOLE, { value: true });
  const stdout = target.log || target.info;
  const stderr = target.error || target.warn;
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) {
    if (typeof target[method] !== 'function') continue;
    const output = (method === 'warn' || method === 'error' || method === 'trace')
      ? stderr : (stdout || target[method]);
    // Snapshot the output function before replacing any of the methods.
    const original = output.bind(target);
    target[method] = (...args) => original('%s', escapeControls(format(...args)));
  }
}

function authenticationFailure(ip, method, { write = writeStdout } = {}) {
  const address = clientAddress(ip);
  if (!address || !Object.values(AUTH_METHOD).includes(method)) return;
  try {
    write(`${new Date().toISOString()} [security] auth_failure ip=${address} method=${method}\n`);
  } catch (_) { /* observability must not change the authentication outcome */ }
}

function accessLogger({ getClientIp, write = writeStdout } = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    let ip = '-';
    try { ip = clientAddress(getClientIp?.(req)) || clientAddress(req.socket?.remoteAddress) || '-'; } catch (_) {}
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      try {
        const aborted = !res.writableFinished;
        const data = {
          ip,
          method: String(req.method || '').slice(0, 20),
          // Only a router's declared template: raw URLs can contain hook secrets,
          // viewing keys, preview tokens, reset links and credentials in queries.
          route: typeof req.route?.path === 'string' ? req.route.path : '-',
          status: aborted ? 499 : res.statusCode,
          duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
          aborted,
        };
        write(`${new Date().toISOString()} [access] ${JSON.stringify(data)}\n`);
      } catch (_) { /* a completed HTTP response must not become an uncaught exception */ }
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

module.exports = { accessLogger, authenticationFailure, installConsoleSafety, AUTH_METHOD };
