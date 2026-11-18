#!/usr/bin/env node
'use strict';

/*
 * Feature inventory: every user-facing entry point, listed so that losing one is never silent.
 *
 * WHY. Features have gone missing as a side effect of unrelated work. The standalone "+ Group"
 * button went in 2.0 inside a bulk-selection PR (#296) that treated it as redundant, which left no
 * way to create a group once every display was in one; nobody noticed for three months. A test can
 * not know which features matter, but it can make every removal visible in review.
 *
 * WHAT IS LISTED (all read straight from the source, no app needed):
 *   - frontend: ids of interactive elements (button, a, select, input, textarea, details, summary),
 *     the data-* action attributes on buttons, and every #/route the dashboard links to;
 *   - server: every Express route (router.METHOD / app.METHOD with a literal path).
 *
 * server/test/feature-inventory.test.js compares this against the committed snapshot and fails
 * on anything missing or new. Removing something on purpose, or adding something: run
 *   node scripts/feature-inventory.js --write
 * and the snapshot diff in the PR shows exactly what changed, for a reviewer to see.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'server', 'test', 'fixtures', 'feature-inventory.json');

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'i18n' || entry.name === 'vendor') continue;
      walk(full, filter, out);
    } else if (filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const ID_RE = /<(?:button|a|select|input|textarea|details|summary)\b[^>]*?\sid="([A-Za-z][\w-]*)"/g;
const BUTTON_RE = /<button\b[^>]*>/g;
const DATA_ATTR_RE = /\s(data-[a-z][a-z0-9-]*)/g;
const HASH_ROUTE_RE = /['"`(=]#\/([a-z0-9][a-z0-9/_-]*)/g;
const ROUTE_RE = /\b(?:router|app)\.(get|post|put|patch|delete)\(\s*(['"`])(\/[^'"`$]*)\2/g;

// data-* attributes on buttons that describe styling or state rather than an action.
const NOT_ACTIONS = new Set(['data-advanced-ui', 'data-tip', 'data-tooltip', 'data-i18n', 'data-variant', 'data-size', 'data-state', 'data-active', 'data-selected']);

function frontendEntries(src) {
  const found = new Set();
  for (const m of src.matchAll(ID_RE)) found.add(`#${m[1]}`);
  for (const b of src.matchAll(BUTTON_RE)) {
    for (const a of b[0].matchAll(DATA_ATTR_RE)) if (!NOT_ACTIONS.has(a[1])) found.add(`[${a[1]}]`);
  }
  for (const m of src.matchAll(HASH_ROUTE_RE)) found.add(`route #/${m[1].replace(/\/+$/, '')}`);
  return found;
}

function serverEntries(src) {
  const found = new Set();
  for (const m of src.matchAll(ROUTE_RE)) found.add(`${m[1].toUpperCase()} ${m[3]}`);
  return found;
}

function build() {
  const inventory = { frontend: {}, server: {} };
  const add = (bucket, file, entries) => {
    if (entries.size) bucket[rel(file)] = [...entries].sort();
  };
  for (const f of walk(path.join(ROOT, 'frontend', 'js'), (n) => n.endsWith('.js')).sort()) {
    add(inventory.frontend, f, frontendEntries(fs.readFileSync(f, 'utf8')));
  }
  const serverFiles = [path.join(ROOT, 'server', 'server.js'), ...walk(path.join(ROOT, 'server', 'routes'), (n) => n.endsWith('.js'))].sort();
  for (const f of serverFiles) add(inventory.server, f, serverEntries(fs.readFileSync(f, 'utf8')));
  return inventory;
}

/** Entries in `a` that are not in `b`, as "area file: entry" lines. */
function difference(a, b) {
  const out = [];
  for (const area of ['frontend', 'server']) {
    for (const [file, entries] of Object.entries(a[area] || {})) {
      const other = new Set((b[area] && b[area][file]) || []);
      for (const e of entries) if (!other.has(e)) out.push(`${area} ${file}: ${e}`);
    }
  }
  return out;
}

function stringify(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

if (require.main === module) {
  const inventory = build();
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, stringify(inventory));
    const count = (area) => Object.values(inventory[area]).reduce((n, list) => n + list.length, 0);
    console.log(`feature inventory written: ${count('frontend')} frontend entry points, ${count('server')} server routes`);
  } else {
    process.stdout.write(stringify(inventory));
  }
}

module.exports = { build, difference, stringify, SNAPSHOT };
