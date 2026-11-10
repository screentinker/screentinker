'use strict';

/*
 * A COMMAND THE DOCUMENTATION TELLS AN OPERATOR TO RUN, RUNS.
 *
 * docs/instance-updater.md says `sudo scripts/updater/install-systemd.sh`. A script invoked by
 * path needs its executable bit, and that file (with two other installers) was committed without
 * one, so the documented command answered "command not found".
 *
 * The invariant: every repository script the docs or README invoke directly by path (not through
 * `sh`, `bash` or a pipe) is executable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const docs = [path.join(ROOT, 'README.md'), ...fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => path.join(ROOT, 'docs', f))];

test('scripts invoked directly by path in the docs are executable', () => {
  const invoked = new Set();
  for (const f of docs) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      // "sudo [VAR=x ...] scripts/…/name.sh" or "./scripts/…/name.sh" at the start of a command.
      const m = /^\s*(?:\$\s+)?(?:sudo\s+)?(?:[A-Z_]+=\S+\s+)*(?:\.\/)?(scripts\/[\w./-]+\.sh)\b/.exec(line);
      if (m && fs.existsSync(path.join(ROOT, m[1]))) invoked.add(m[1]);
    }
  }
  assert.ok(invoked.has('scripts/updater/install-systemd.sh'), 'the updater install command is among them');
  for (const rel of invoked) {
    assert.ok(fs.statSync(path.join(ROOT, rel)).mode & 0o111, `${rel} is run by path in the docs, so it must be executable`);
  }
});
