#!/usr/bin/env node
'use strict';

/**
 * Write frontend/certified-hardware.html from certified-hardware.json.
 *
 * ⚠️ WHY GENERATE RATHER THAN HAND-WRITE. Every other public page here is hand-authored static HTML
 * and this does not add a template engine. But this page is a list that grows one entry at a time
 * forever, and hand-editing sixteen fields per device is how a wrong model number reaches a page
 * that reseller agreements point at. So a human edits JSON and this renders it.
 *
 *   cd server && npm run build:certified-hardware     # rewrite the page
 *   node scripts/build-certified-hardware.js --check  # fail if the page is stale (CI + tests)
 *
 * ⚠️ THE COMMITTED FILE IS THE JSON ALONE — no community submissions. That is not an oversight: it
 * is the fallback the route serves if the database is unavailable, and a contract page should
 * degrade to "ByteTinker's own entries only" rather than to an error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { render, loadData, DATA, OUT } = require('../lib/certified-hardware');

const data = loadData();
const output = render(data);

if (process.argv.includes('--check')) {
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== output) {
    throw new Error('frontend/certified-hardware.html is stale; run npm run build:certified-hardware');
  }
} else {
  fs.writeFileSync(OUT, output);
  process.stdout.write(`wrote ${path.relative(path.dirname(DATA), OUT)} (${data.devices.length} devices)\n`);
}
