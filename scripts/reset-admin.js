#!/usr/bin/env node
/**
 * Emergency admin access for self-hosted ScreenTinker.
 * Run this on the server to get a temporary admin login URL.
 *
 * Usage: node scripts/reset-admin.js
 */

const path = require('path');
const config = require(path.join(__dirname, '..', 'server', 'config'));
const jwt = require(path.join(__dirname, '..', 'server', 'node_modules', 'jsonwebtoken'));
const crypto = require('crypto');

const nonce = crypto.randomBytes(8).toString('hex');
const token = jwt.sign(
  { id: 'recovery-' + nonce, email: 'admin@localhost', role: 'admin' },
  config.jwtSecret,
  { expiresIn: '1h' }
);

const port = config.port || 3001;

console.log(`
╔══════════════════════════════════════════════════╗
║         ScreenTinker Admin Recovery              ║
╠══════════════════════════════════════════════════╣
║  A temporary admin token has been generated.     ║
║  Valid for 1 hour. Use it to log in and reset    ║
║  your password or create a new admin account.    ║
╚══════════════════════════════════════════════════╝

Token: ${token}

To use: Open your ScreenTinker instance, open browser
console (F12), and run:

  localStorage.setItem('token', '${token}');
  localStorage.setItem('user', '${JSON.stringify({ id: 'recovery-' + nonce, email: 'admin@localhost', name: 'Recovery Admin', role: 'admin', plan_id: 'enterprise' }).replace(/'/g, "\\'")}');
  location.reload();

Or use the API directly:

  curl -H "Authorization: Bearer ${token}" http://localhost:${port}/api/devices
`);
