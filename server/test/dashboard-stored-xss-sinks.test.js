'use strict';

/*
 * Values the dashboard did not write must not reach innerHTML raw — and a write the server
 * refused must not be reported as a success.
 *
 * ⚠️ EVERY SINK HERE WAS STORED XSS INTO THE DASHBOARD ORIGIN, where the session JWT sits in
 * localStorage. The CSP does not save us: server.js sets scriptSrcAttr 'unsafe-inline', so an
 * `<img src=x onerror=…>` or an attribute break-out `x" onmouseover=…` runs. Each value came from
 * somebody with LESS privilege than the person who ends up looking at it:
 *
 *   - Reports (audit F08): content_name is whatever a PLAYER sends in play-event; device_name is
 *     whatever an editor renamed the screen to.
 *   - Device detail (F09): android_version / local_ip / local_ip6 are device-reported telemetry.
 *   - Widget editor (F10): config is whatever JSON was last PUT — an HTML widget is free-form
 *     markup by design, so `</textarea><img onerror=…>` closed the box. Unescaped textarea bodies
 *     also did not ROUND-TRIP: textarea content is RCDATA, entities decode, and a re-save changed
 *     a literal `&lt;b&gt;` into real bold text.
 *   - Designer (F18): config.design.elements, a loaded .json file, or an AI response.
 *
 * And two "success" toasts that a 403 could not stop (F19 white-label save, F27 apply layout),
 * because fetch() resolves on any HTTP status.
 *
 * There is no DOM in this suite, so these read the view source — the same approach as
 * frontend-shared-helpers.test.js. They are written as RULES over each template ("every
 * interpolation of a stored value is escaped") rather than a grep for the one line that was
 * reported, so a new field added next month without esc() fails too.
 *
 * FRONTEND_ROOT may point at another checkout (e.g. an export of the pre-fix tree) to prove the
 * rules fail there.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = process.env.FRONTEND_ROOT
  ? path.join(process.env.FRONTEND_ROOT, 'frontend', 'js')
  : path.join(__dirname, '..', '..', 'frontend', 'js');
// Block comments are dropped first: the ⚠️ notes beside these fixes quote the very patterns the
// rules look for, and a comment is not a sink. Only ones that OPEN a line — `accept="image/*"` in a
// template would otherwise start a "comment" that eats half the file.
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');

/** The balanced {...} body that follows the first `{` at or after `marker`. */
function bodyAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `marker not found: ${marker}`);
  const open = src.indexOf('{', at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced body after ${marker}`);
}

/** Every `${ … }` expression in a chunk of source, brace-balanced, outermost first. */
function interpolations(src) {
  const out = [];
  let i = 0;
  while ((i = src.indexOf('${', i)) >= 0) {
    let depth = 0;
    let j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) break;
    }
    out.push(src.slice(i + 2, j).trim());
    i += 2; // nested ones are reported too; the rules below only look at the ones that matter
  }
  return out;
}

const escaped = (expr) => /^(esc|escAttr)\(/.test(expr);
// A ternary (` ? `, with spaces — `el.data?.slice` is optional chaining, not a ternary) chooses
// between literals for a `selected`/`checked` flag; an arithmetic expression yields a number or NaN.
const isTernary = (expr) => / \? /.test(expr) || /&&/.test(expr);
const isArithmetic = (expr) => /^Math\.round\(/.test(expr) || /^[\w.]+ \/ \d+$/.test(expr);

function rawUses(body, rootRe) {
  return interpolations(body)
    .filter((e) => rootRe.test(e))
    .filter((e) => !escaped(e) && !isTernary(e) && !isArithmetic(e));
}

/* ================================================================== F08 Reports */

test('⚠️ F08: proof-of-play names (player-reported content, editor-set device) are escaped', () => {
  const body = bodyAfter(read('views/reports.js'), 'export async function render(container)');
  // `c.` rows are by_content, `d.` rows are by_device. Numbers (plays, seconds) are server-computed
  // aggregates; the strings are not.
  const raw = rawUses(body, /^[cd]\.\w*name\b/);
  assert.deepEqual(raw, [], `unescaped name interpolations in the Reports tables: ${JSON.stringify(raw)}`);
  assert.match(body, /esc\(c\.content_name/, 'the content cell must escape content_name');
  assert.match(body, /esc\(d\.device_name/, 'the device cell must escape device_name');
});

/* ============================================================ F09 Device detail */

test('⚠️ F09: device-reported telemetry strings are escaped on the device page', () => {
  const src = read('views/device-detail.js');
  // These three come straight off the socket (applyDeviceInfo / telemetry) with no sanitising.
  for (const field of ['android_version', 'local_ip', 'local_ip6']) {
    const raw = interpolations(src)
      .filter((e) => new RegExp(`^device\\.${field}\\b`).test(e))
      .filter((e) => !isTernary(e));
    assert.deepEqual(raw, [], `device.${field} reaches markup unescaped: ${JSON.stringify(raw)}`);
  }
});

/* ============================================================== F10 Widget editor */

test('⚠️ F10: every stored config value in the widget edit form is escaped', () => {
  const body = bodyAfter(read('views/widgets.js'), 'function showConfigForm(type, config)');
  const raw = rawUses(body, /\bconfig\./);
  assert.deepEqual(raw, [], `unescaped config values in showConfigForm: ${JSON.stringify(raw)}`);
});

test('⚠️ F10: the HTML/CSS textarea bodies are escaped, so they can neither break out nor mutate', () => {
  const body = bodyAfter(read('views/widgets.js'), 'function showConfigForm(type, config)');
  assert.match(body, /<textarea id="wHtml"[^>]*>\$\{escAttr\(config\.html/, 'wHtml body must be escaped');
  assert.match(body, /<textarea id="wCss"[^>]*>\$\{escAttr\(config\.css/, 'wCss body must be escaped');

  // And escAttr is the right tool for RCDATA: it must encode & as well as < >, or a stored
  // `&lt;b&gt;` is decoded by the textarea and saved back as a real tag.
  const src = read('views/widgets.js');
  const fn = src.slice(src.indexOf('function escAttr('), src.indexOf('}', src.indexOf('function escAttr(')) + 1);
  // eslint-disable-next-line no-new-func
  const escAttr = new Function(`${fn}; return escAttr;`)();
  const hostile = '</textarea><img src=x onerror="alert(1)">';
  assert.ok(!/[<>"]/.test(escAttr(hostile)), 'escAttr must neutralise a textarea break-out');
  // A minimal RCDATA decode (what the browser does to textarea content) must give back the input.
  const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const v of ['&lt;b&gt;literal&lt;/b&gt;', 'a & b', hostile]) {
    assert.equal(decode(escAttr(v)), v, `stored html must round-trip unchanged: ${v}`);
  }
});

/* ================================================================== F18 Designer */

test('⚠️ F18: every element field the designer renders into the dashboard is escaped', () => {
  const src = read('views/designer.js');
  for (const fn of ['function redraw()', 'function updateProps()', 'function updateLayers()']) {
    const body = bodyAfter(src, fn);
    const raw = rawUses(body, /^el\./);
    assert.deepEqual(raw, [], `${fn} interpolates element fields raw: ${JSON.stringify(raw)}`);
  }
});

test('⚠️ F18: the design is never serialised into an inline onclick attribute', () => {
  const body = bodyAfter(read('views/designer.js'), 'function updateProps()');
  // JSON.stringify(elements) inside onclick="…" closed the attribute at its first `"` (so the
  // button never worked) and let element text be parsed as attributes on the button.
  assert.doesNotMatch(body, /onclick="[^"]*\$\{JSON\.stringify\(elements\)\}/,
    'the Save-design button must not embed the elements in its onclick attribute');
  assert.match(body, /saveDesignFileBtn['"]\)\?\.addEventListener\('click'/,
    'the Save-design button must use a listener that reads the design at click time');
});

/* ============================================================= F19 White-label */

test('⚠️ F19: a refused branding save is reported as a failure, not "Branding saved"', () => {
  const src = read('views/settings.js');
  const handler = bodyAfter(src, "getElementById('saveWhiteLabelBtn')?.addEventListener('click', async () =>");
  const okCheck = handler.indexOf('!res.ok');
  const success = handler.indexOf("t('settings.toast.branding_saved')");
  assert.ok(okCheck >= 0, 'the save handler must look at the response status');
  assert.ok(success > okCheck, 'the status check must come BEFORE the success toast');
});

test('⚠️ F19: platform-admin-only fields are not sent by anyone else', () => {
  const src = read('views/settings.js');
  const handler = bodyAfter(src, "getElementById('saveWhiteLabelBtn')?.addEventListener('click', async () =>");
  // The server 403s ANY non-empty custom_domain/custom_css from a non-platform-admin before it
  // writes anything; sending the pre-filled values unconditionally made every save fail.
  const guarded = bodyAfter(handler, 'if (canSetDomainAndCss)');
  assert.match(guarded, /custom_domain/);
  assert.match(guarded, /custom_css/);
  const outside = handler.replace(guarded, '');
  assert.doesNotMatch(outside, /custom_domain|custom_css/,
    'custom_domain / custom_css must only be added to the body for a platform admin');
  const load = bodyAfter(src, 'async function loadWhiteLabel()');
  assert.match(load, /const canSetDomainAndCss = isPlatformAdmin\(user\)/);
});

/* ============================================================ F27 Apply layout */

test('⚠️ F27: applying a layout goes through api.put, so a 403/400 is an error toast', () => {
  const src = read('views/device-detail.js');
  const handler = bodyAfter(src, "getElementById('applyLayoutBtn')?.addEventListener('click', async () =>");
  // A bare fetch resolves on 403 (viewer, cross-workspace layout) and 400 (bad id), and also
  // skipped the linked-server routing that request() applies.
  assert.doesNotMatch(handler, /\bfetch\(/, 'Apply layout must not use a bare fetch');
  const put = handler.indexOf('await api.put(`/layouts/device/${device.id}`');
  const toast = handler.indexOf("'success'");
  assert.ok(put >= 0, 'Apply layout must call api.put on the device layout route');
  assert.ok(toast > put, 'the success toast must come after the awaited request');
});
