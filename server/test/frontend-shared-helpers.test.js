'use strict';

/*
 * A shared helper a view CALLS must be a helper that view IMPORTS.
 *
 * ⚠️ THIS SHIPPED, AND IT SHIPPED FOR SIXTEEN DAYS. The escaping sweep of 2026-08-11 added esc()
 * to three sinks in views/widgets.js and imported it in none of them. Every one of those lines
 * threw ReferenceError the instant it ran:
 *
 *   - the image picker died before appending itself, so "+ Add Background Image" and "Choose Logo"
 *     on a directory board did NOTHING AT ALL — which is what the report of "someone couldn't
 *     upload a background picture" actually was;
 *   - the Weather and Social config forms threw while building their HTML, so neither widget could
 *     be opened for editing.
 *
 * Nothing saw it. A syntax check passes — the reference is only resolved when the line runs. Every
 * view still rendered, because the calls sit inside click handlers. The unit suite was green,
 * 2600 tests of it, and so was the browser smoke, which never opened those particular dialogs.
 *
 * This is the cheapest thing that would have caught it: the shared helpers are a small, known set,
 * and asking whether a file that uses one has actually imported it costs nothing.
 *
 * Backported from main (2.0.0-alpha8+) with the fix itself, because this is the branch the hosted
 * instance runs and the branch the defect shipped to.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'js');

/** Files that export the helpers everything else borrows. */
const SOURCES = ['utils.js', 'i18n.js', 'api.js', 'branding.js']
  .map((f) => path.join(FRONTEND, f))
  .concat(fs.existsSync(path.join(FRONTEND, 'components'))
    ? fs.readdirSync(path.join(FRONTEND, 'components')).filter((f) => f.endsWith('.js'))
      .map((f) => path.join(FRONTEND, 'components', f))
    : [])
  .filter((p) => fs.existsSync(p));

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'i18n') out.push(...jsFiles(p)); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Named exports of a module: `export function x`, `export const x`, `export { a, b }`. */
function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const as = part.split(/\bas\b/);
      const name = (as[as.length - 1] || '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Names this file brings into scope: imports, plus anything it declares itself. */
function inScope(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const as = part.split(/\bas\b/);
      const name = (as[as.length - 1] || '').trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  /*
   * Declared locally — a file is free to define its own helper, and several do.
   *
   * ⚠️ ANCHORED AT THE START OF A LINE, and the first version of this guard was not, which made it
   * VACUOUS: widgets.js contains `addEventListener('keydown', function esc(ev) {`, a NAMED FUNCTION
   * EXPRESSION whose name is scoped to itself. An unanchored scan read that as "this file declares
   * esc", so the guard passed against the very source it was written to catch.
   */
  for (const m of src.matchAll(/^[ \t]*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  return names;
}

/* Comments and strings are not code: an `esc(` inside a comment must not count as a use, and a
 * template literal's ${esc(x)} must. Strip line/block comments only. */
function code(src) {
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}

test('⚠️ every shared helper a frontend file calls is in that file\'s scope', () => {
  const shared = new Set();
  for (const p of SOURCES) for (const n of exportedNames(fs.readFileSync(p, 'utf8'))) shared.add(n);
  assert.ok(shared.has('esc'), 'utils.esc no longer parses as an export — re-check this guard');
  assert.ok(shared.size > 5, `only ${shared.size} shared helpers parsed`);

  const offenders = [];
  for (const file of jsFiles(FRONTEND)) {
    if (SOURCES.includes(file)) continue;
    const src = code(fs.readFileSync(file, 'utf8'));
    const scope = inScope(src);
    for (const name of shared) {
      if (scope.has(name)) continue;
      // A call, not a property access (`x.esc(`) and not a longer identifier (`escAttr(`).
      const used = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(src);
      if (used) offenders.push(`${path.relative(FRONTEND, file)} calls ${name}() without importing it`);
    }
  }
  assert.deepEqual(offenders, [],
    'these throw ReferenceError the moment the line runs — a syntax check and a rendered view both '
    + 'miss it:\n  ' + offenders.join('\n  '));
});
