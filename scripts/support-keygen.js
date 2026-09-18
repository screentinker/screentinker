#!/usr/bin/env node
'use strict';

/*
 * Generate the Ed25519 key pair that signs support-access tokens (lib/support-access).
 *
 * The PUBLIC key is embedded in server/lib/support-access.js and ships with every install; the
 * PRIVATE key exists only on the instance that issues tokens (SUPPORT_SIGNING_KEY_FILE). Run this
 * once, paste the public key into the library, and keep the private key out of the repository.
 *
 *   node scripts/support-keygen.js /secure/path/support-signing-key.pem
 *
 * Writes the private key to that path (mode 0600, refuses to overwrite) and prints the public key
 * — and ONLY the public key — to stdout, so the private key never lands in a terminal scrollback.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) {
  console.error('usage: support-keygen.js <private-key-output.pem>');
  process.exit(2);
}
if (fs.existsSync(out)) {
  console.error(`refusing to overwrite ${out}`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
fs.writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const pub = publicKey.export({ type: 'spki', format: 'pem' });
console.log(`private key written to ${out} (mode 0600)\n`);
console.log('public key — embed as SUPPORT_PUBLIC_KEY_PEM in server/lib/support-access.js:\n');
console.log(pub);
