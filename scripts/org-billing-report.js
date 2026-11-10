#!/usr/bin/env node
'use strict';

/*
 * What changes for whom when screen and storage limits are counted per ORGANIZATION instead of
 * per person. READ-ONLY: the database is opened read-only and nothing is written anywhere.
 *
 *   node scripts/org-billing-report.js /path/to/remote_display.db          human-readable
 *   node scripts/org-billing-report.js /path/to/remote_display.db --json   everything, as JSON
 *
 * Point it at a COPY of production (see scripts/backup.sh), not at the live file. It lists the
 * screens that would stop playing, the ones that would start, owners with several organizations,
 * members whose own plan covers screens in someone else's organization, and organizations that
 * would be over their storage limit. The rules are in server/lib/org-billing-report.js.
 */

const path = require('node:path');
const fs = require('node:fs');

const file = process.argv[2];
if (!file || file.startsWith('-')) { console.error('usage: node scripts/org-billing-report.js <database file> [--json]'); process.exit(2); }
if (!fs.existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2); }

const Database = require(path.join(__dirname, '..', 'server', 'node_modules', 'better-sqlite3'));
const report = require(path.join(__dirname, '..', 'server', 'lib', 'org-billing-report'));

const db = new Database(file, { readonly: true, fileMustExist: true });
try {
  const r = report.build(db);
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : report.text(r));
} finally { db.close(); }
