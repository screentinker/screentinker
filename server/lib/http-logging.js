'use strict';

// Access records go to the console. authenticationFailure() writes checked fields
// to a separate SECURITY_LOG file, so console text cannot become a Fail2ban event.
const fs = require('node:fs');
const net = require('node:net');
const writeStdout = line => process.stdout.write(line);
// Off unless SECURITY_LOG is set. appendFile creates the file, not its directory;
// the service user needs write access. Each append reopens the path for rotation.
// Errors are silently ignored; verify a failed login reaches the file after setup.
const writeSecurityLog = line => {
  const file = process.env.SECURITY_LOG;
  if (file) fs.appendFile(file, line, { mode: 0o640 }, () => { /* best effort */ });
};
const AUTH_METHOD = Object.freeze({ PASSWORD: 'password', TOTP: 'totp' });

function clientAddress(value) {
  if (typeof value !== 'string') return null;
  const ip = value.replace(/^::ffff:/i, '');
  // Zone identifiers and arbitrary header text do not belong in ban commands.
  return net.isIP(ip) && /^[\da-f:.]+$/i.test(ip) ? ip : null;
}

function authenticationFailure(ip, method, { write = writeSecurityLog } = {}) {
  const address = clientAddress(ip);
  if (!address || !Object.values(AUTH_METHOD).includes(method)) return;
  try {
    write(`${new Date().toISOString()} [security] auth_failure ip=${address} method=${method}\n`);
  } catch (_) { /* a logging error must not affect the login response */ }
}

function accessLogger({ getClientIp, write = writeStdout } = {}) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    let ip = '-';
    try { ip = clientAddress(getClientIp?.(req)) || clientAddress(req.socket?.remoteAddress) || '-'; } catch (_) {}
    // Express assigns req.route while baseUrl still contains the matched mount.
    // Capture it then: error propagation restores baseUrl before the response ends.
    let route = req.route;
    const template = value => typeof value?.path === 'string'
      ? `${typeof req.baseUrl === 'string' ? req.baseUrl : ''}${value.path}` : '-';
    let routePath = template(route);
    try {
      Object.defineProperty(req, 'route', {
        configurable: true,
        enumerable: true,
        get: () => route,
        set(value) { route = value; routePath = template(value); },
      });
    } catch (_) {}
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
          route: routePath,
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

module.exports = { accessLogger, authenticationFailure, AUTH_METHOD };
