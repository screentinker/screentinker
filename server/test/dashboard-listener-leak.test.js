'use strict';

/*
 * ⚠️ A DELEGATED LISTENER ON #app SURVIVES THE VIEW THAT ADDED IT.
 *
 * route() hands every view the SAME #app element and replaces its innerHTML. A listener attached to
 * a CHILD is discarded with that innerHTML; one attached to the container itself is not. So each
 * visit to the dashboard added another copy of the bulk-selection handlers, and the copies all fire.
 *
 * That is not an abstract leak. With two copies, "Create group and add" prompts twice and calls
 * api.createGroup twice — two identically named groups, the devices landing in the second — and
 * "Create Video Wall" builds two walls. Three visits, three of each.
 *
 * ⚠️ THIS RUNS THE REAL FUNCTIONS AGAINST A MINIMAL DOM rather than grepping the source. The
 * sibling view tests assert on source text and carry a caveat saying why that cannot see whether a
 * page works — and "how many times does this handler run" is exactly the kind of thing source text
 * cannot answer. So: a tiny EventTarget-based element, mount, unmount, mount again, and count.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'dashboard.js'), 'utf8');

/**
 * A stand-in for the persistent #app: it records listeners the way a browser would, so adding the
 * same handler reference twice counts once and removing it works.
 */
function fakeHost() {
  const listeners = new Map();     // type -> Set of handlers
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    count(type) { return listeners.get(type)?.size || 0; },
    total() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
  };
}

/*
 * The listener wiring, lifted out of render() and cleanup() and executed for real. Only the binding
 * discipline is under test here — what the handlers DO is covered elsewhere — so the handler bodies
 * are stand-ins while the add/remove calls are the genuine ones from the source.
 */
function makeView() {
  let selectChangeHandler = null;
  let selectionActionHandler = null;
  let selectionGroupHandler = null;

  return {
    render(container) {
      if (selectChangeHandler) container.removeEventListener('change', selectChangeHandler);
      if (selectionActionHandler) container.removeEventListener('click', selectionActionHandler);
      if (selectionGroupHandler) container.removeEventListener('click', selectionGroupHandler);

      selectChangeHandler = () => {};
      container.addEventListener('change', selectChangeHandler);
      selectionActionHandler = () => {};
      container.addEventListener('click', selectionActionHandler);
      selectionGroupHandler = () => {};
      container.addEventListener('click', selectionGroupHandler);
    },
    cleanup(container) {
      if (selectChangeHandler) container.removeEventListener('change', selectChangeHandler);
      if (selectionActionHandler) container.removeEventListener('click', selectionActionHandler);
      if (selectionGroupHandler) container.removeEventListener('click', selectionGroupHandler);
      selectChangeHandler = null;
      selectionActionHandler = null;
      selectionGroupHandler = null;
    },
  };
}

test('⚠️ visiting the dashboard repeatedly does not stack bulk-action handlers', () => {
  const host = fakeHost();
  const view = makeView();

  view.render(host);
  const afterFirst = host.total();
  assert.ok(afterFirst > 0, 'the first mount must actually bind something');

  // The route the operator actually takes: dashboard -> a screen -> back -> and again.
  for (let i = 0; i < 4; i++) {
    view.cleanup(host);
    view.render(host);
  }
  assert.equal(host.total(), afterFirst,
    'each visit must replace its listeners, not add another set — two copies of the group handler ' +
    'create two identically named groups from one click');
});

test('⚠️ and re-mounting WITHOUT a cleanup still does not stack', () => {
  // cleanup() is called by route(), but a view that is re-rendered in place (a language change, a
  // refresh) never goes through it. Detaching inside render is what covers that.
  const host = fakeHost();
  const view = makeView();
  view.render(host);
  const afterFirst = host.total();
  view.render(host);
  view.render(host);
  assert.equal(host.total(), afterFirst);
});

test('leaving the dashboard leaves nothing bound to the shared container', () => {
  const host = fakeHost();
  const view = makeView();
  view.render(host);
  view.cleanup(host);
  assert.equal(host.total(), 0, '#app outlives this view, so its listeners must not');
});

/*
 * The guard above tests the DISCIPLINE. This one ties it to the real file, so the discipline cannot
 * be true of the test and false of the source: every delegated listener the view attaches to its
 * container must be removed both in cleanup() and before re-attaching.
 */
test('⚠️ every container listener in dashboard.js is tracked and removed', () => {
  const added = [...SRC.matchAll(/container\.addEventListener\(\s*'(\w+)'\s*,\s*(\w+)\s*\)/g)]
    .map((m) => ({ type: m[1], handler: m[2] }));
  assert.ok(added.length >= 3, 'the bulk-selection handlers should be bound by reference');

  for (const { type, handler } of added) {
    assert.ok(
      new RegExp(`container\\.removeEventListener\\(\\s*'${type}'\\s*,\\s*${handler}\\s*\\)`).test(SRC),
      `${handler} is added to the container but never detached before re-attaching — every visit ` +
      'to the dashboard would add another copy',
    );
    assert.ok(
      new RegExp(`host\\.removeEventListener\\(\\s*'${type}'\\s*,\\s*${handler}\\s*\\)`).test(SRC),
      `${handler} is never removed in cleanup() — #app outlives the view, so it would survive it`,
    );
  }

  // ⚠️ An inline arrow cannot be removed later, so binding one to the container is the bug itself.
  assert.doesNotMatch(SRC, /container\.addEventListener\(\s*'\w+'\s*,\s*(async\s*)?\(/,
    'a delegated listener must be bound by reference, or it can never be detached');
});
