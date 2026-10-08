'use strict';

/*
 * Boot-time migrations log nothing alarming when there is nothing wrong.
 *   - a fresh install prints no `[migrate] FAILED` / `… failed` line: statements that need the
 *     multi-tenancy tables (organizations, devices.workspace_id) run after that phase, not in the
 *     migrations array before it
 *   - the later feature schema runs as independent named steps, so one bad statement is reported
 *     under its own feature and does not skip the rest (it used to be one try blaming
 *     "template-zone dedupe")
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-migboot-'));
process.env.DATA_DIR = tmp;

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.join(' ')); origError(...a); };
const { db } = require('../db/database');
console.error = origError;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'db', 'database.js'), 'utf8');

test('a fresh install logs no migration failure', () => {
  const bad = errors.filter((l) => /\[migrate\]/.test(l));
  assert.deepEqual(bad, []);
});

test('a fresh install ends with the columns the moved statements were for', () => {
  const orgCols = db.prepare('PRAGMA table_info(organizations)').all().map((c) => c.name);
  assert.ok(orgCols.includes('widget_sandbox_isolation_disabled'));
  assert.ok(orgCols.includes('sso_only'));
  const schedCols = db.prepare('PRAGMA table_info(schedules)').all().map((c) => c.name);
  assert.ok(schedCols.includes('workspace_id'));
});

test('the migrations array no longer holds statements that need the multi-tenancy tables', () => {
  const arr = SRC.slice(SRC.indexOf('const migrations = ['), SRC.indexOf('\n];\n', SRC.indexOf('const migrations = [')));
  assert.ok(arr.length > 1000, 'found the array');
  assert.doesNotMatch(arr, /ALTER TABLE organizations ADD COLUMN/);
  assert.doesNotMatch(arr, /UPDATE schedules SET workspace_id/);
});

test('later feature schema runs as independent, named steps', () => {
  assert.doesNotMatch(SRC, /console\.error\('\[migrate\] template-zone dedupe failed/, 'the catch-all that blamed the wrong step is gone');
  const steps = [...SRC.matchAll(/^migrationStep\('([^']+)'/gm)].map((m) => m[1]);
  for (const name of ['SAML', 'Canva', 'Microsoft 365 and cloud folders', 'BI connections', 'automation', 'CAP feeds',
    'social walls', 'meeting rooms', 'audience counting', 'version history baseline', 'template-zone dedupe']) {
    assert.ok(steps.includes(name), `step ${name}`);
  }
  assert.equal(new Set(steps).size, steps.length, 'step names are unique');
  // Every step committed its marker / tables on this boot.
  for (const t of ['saml_requests', 'canva_links', 'cloud_folders', 'bi_connections', 'automation_hooks', 'cap_feeds',
    'social_posts', 'rooms', 'audience_buckets']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), `table ${t}`);
  }
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'dedupe_template_zones_v1'").get());
});
