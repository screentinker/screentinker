'use strict';

// #158 (Hybrid-C): an agency token uploads into a bound folder + its descendants and NOTHING
// else. folderSubtree() in lib/agency-targets.js IS that confinement — it backs both the portal
// dropdown (GET /api/agency/folders) and the upload target check (POST /api/agency/content), so
// if it over-returns, the agency can both SEE and WRITE outside its area. Every way it could
// leak is asserted here; the workspace guard on the anchor row and the parent-join recursion are
// the two lines that make these bites go red.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { folderSubtree } = require('../lib/agency-targets');

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE content_folders (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, workspace_id TEXT);
  INSERT INTO content_folders (id, parent_id, name, workspace_id) VALUES
    ('root',   NULL,    'Agency — Acme', 'wsA'),  -- the bound folder
    ('sub1',   'root',  'Campaign Q1',   'wsA'),  -- child  -> in
    ('sub2',   'root',  'Campaign Q2',   'wsA'),  -- child  -> in
    ('deep',   'sub1',  'Drafts',        'wsA'),  -- grandchild -> in
    ('sibling',NULL,    'Internal',      'wsA'),  -- other root in same ws -> OUT (sibling leak)
    ('sibkid', 'sibling','Confidential', 'wsA'),  -- under the sibling  -> OUT
    ('foreign',NULL,    'Other tenant',  'wsB');  -- another workspace   -> OUT
`);

const ids = (root, ws) => folderSubtree(db, root, ws).map(r => r.id).sort();

test('#158 folderSubtree: bound folder + all descendants, nothing else', () => {
  assert.deepEqual(ids('root', 'wsA'), ['deep', 'root', 'sub1', 'sub2'],
    'root sees itself + children + grandchild, NOT the sibling tree');
});

test('#158 folderSubtree: a deeper bound folder is confined to its own subtree', () => {
  assert.deepEqual(ids('sub1', 'wsA'), ['deep', 'sub1'], 'sub1 sees itself + its child only');
  assert.deepEqual(ids('sub2', 'wsA'), ['sub2'], 'a leaf folder sees only itself');
});

test('#158 folderSubtree: workspace guard — a foreign-workspace anchor returns nothing', () => {
  assert.deepEqual(ids('root', 'wsB'), [], 'root anchored to the wrong workspace -> empty (no cross-ws upload area)');
  assert.deepEqual(ids('foreign', 'wsA'), [], 'a wsB folder claimed under wsA -> empty');
});

test('#158 folderSubtree: no bound folder -> root uploads, empty subtree', () => {
  assert.deepEqual(folderSubtree(db, null, 'wsA'), [], 'null bound folder -> [] (uploads default to library root)');
});

test('#158 folderSubtree: the sibling subtree is never reachable from root', () => {
  const got = ids('root', 'wsA');
  assert.ok(!got.includes('sibling') && !got.includes('sibkid'),
    'neither the sibling folder nor its child may appear in the bound subtree');
});
